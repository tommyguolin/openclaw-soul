import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { createSoulLogger } from "./logger.js";
import { invokeGatewayTool, fireAgentTask, isWriteTool } from "./gateway-client.js";
import { isGoodTimeForMessage } from "./action-executor.js";
import type { LLMGenerator } from "./soul-llm.js";
import type { Thought, EgoState, ActionResult, MetricDelta, AutonomousTask, TaskStep, ActionType } from "./types.js";
import type { MessageSender } from "./soul-actions.js";
import { updateEgoStore, resolveEgoStorePath } from "./ego-store.js";
import { SOUL_DIR } from "./paths.js";

const log = createSoulLogger("autonomous-actions");

/** Max concurrent active tasks. Soul is a background worker; run heavy work serially. */
const MAX_ACTIVE_TASKS = 1;

const PROVIDER_PRESSURE_BACKOFF_MS = 60 * 60 * 1000;
const PROVIDER_PRESSURE_TAIL_LINES = 80;
const AUTONOMOUS_AGENT_TIMEOUT_SECONDS = 300;
const AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS = 150;
const AUTONOMOUS_AGENT_QUICK_CHECK_SECONDS = 60;
const AUTONOMOUS_FAILURE_BACKOFF_MS = 2 * 60 * 60 * 1000;
const AUTONOMOUS_FAILURE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** Track recently sent report messages to prevent duplicates. */
const recentReportedMessages: Map<string, number> = new Map();

function hasRecentProviderPressure(windowMs = PROVIDER_PRESSURE_BACKOFF_MS): boolean {
  const sessionsDir = join(homedir(), ".openclaw/agents/main/sessions");
  const cutoff = Date.now() - windowMs;
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl")) continue;
      const fp = join(sessionsDir, name);
      const stat = statSync(fp);
      if (stat.mtimeMs < cutoff) continue;
      const lines = readFileSync(fp, "utf-8").split(/\r?\n/).filter(Boolean).slice(-PROVIDER_PRESSURE_TAIL_LINES);
      for (const line of lines) {
        const providerPressureLine =
          /"fallbackStepFromFailureReason":"rate_limit"/.test(line) ||
          /"fallbackStepFromFailureDetail":"[^"]*(?:429|cooldown|suspending lanes|too many requests|rate limit)/i.test(line) ||
          (/"stopReason":"error"/.test(line) && /"errorMessage":"[^"]*(?:429|cooldown|too many requests|rate limit)/i.test(line));
        if (providerPressureLine) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function markCompletedTasksDelivered(): Promise<void> {
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    for (const t of e.activeTasks ?? []) {
      if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
    }
    return e;
  });
}

function isReportableTask(task: AutonomousTask): boolean {
  return (task.status === "completed" || task.status === "failed") && Boolean(task.result);
}

function wantsChineseReport(ego: EgoState): boolean {
  return ego.userLanguage === "zh-CN" || (ego.recentUserMessages ?? []).some((m) => /[\u4e00-\u9fff]/.test(m));
}

function normalizeTaskResultForReport(result: string): string {
  return result
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

function isTaskBlockedResult(result: string): boolean {
  return /timed out|timeout|stale|rate limit|cooldown|backing off|too many requests|429|No available auth profile|failed|error|aborted|prompt-error|parsererror|command exited with code [1-9]/i.test(result);
}

function isProviderPressureErrorText(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return /Soul LLM backoff active|Soul LLM call budget exhausted|rate limit|cooldown|No available auth profile|too many requests|429|suspending lanes|embedded run timeout|Request timed out|ECONNRESET|fetch failed/i.test(text);
}

function isLowValueAutonomousFailure(task: AutonomousTask): boolean {
  if (task.status !== "failed") return false;
  const result = task.result ?? "";
  return /did not finish with a complete report|No confirmed final change set|failed before verification|No reliable before\/after metrics|stopped before producing a final result file|Required final result file was not produced|Task timed out \(stale|request timed out|embedded run timeout|Failed to start autonomous agent task|LLM analysis failed|No concrete fix identified/i.test(result);
}

function recentAutonomousFailureBackoff(ego: EgoState): { count: number; remainingMs: number; latest?: AutonomousTask } | null {
  const now = Date.now();
  const cutoff = now - AUTONOMOUS_FAILURE_LOOKBACK_MS;
  const failures = (ego.activeTasks ?? [])
    .filter((task) => {
      const ts = task.completedAt ?? task.updatedAt ?? task.createdAt;
      return ts >= cutoff && isLowValueAutonomousFailure(task);
    })
    .sort((a, b) => (b.completedAt ?? b.updatedAt ?? b.createdAt) - (a.completedAt ?? a.updatedAt ?? a.createdAt));

  const latest = failures[0];
  if (!latest) return null;

  const latestTs = latest.completedAt ?? latest.updatedAt ?? latest.createdAt;
  const remainingMs = latestTs + AUTONOMOUS_FAILURE_BACKOFF_MS - now;
  if (remainingMs <= 0) return null;
  return { count: failures.length, remainingMs, latest };
}

function hasTaskResultFile(task: AutonomousTask): boolean {
  if (!task.resultFilePath) return false;
  try {
    return statSync(task.resultFilePath).size > 0;
  } catch {
    return false;
  }
}

function hasFinalTaskResultFile(task: AutonomousTask): boolean {
  if (!task.resultFilePath) return false;
  try {
    return isFinalTaskReport(readFileSync(task.resultFilePath, "utf-8"));
  } catch {
    return false;
  }
}

type ReportStatus = "in-progress" | "completed" | "failed" | "blocked" | "partial";

function taskReportStatus(result: string): ReportStatus | null {
  const match = result.match(/^Status:\s*(in-progress|completed|failed|blocked|partial)\b/im);
  return match ? match[1].toLowerCase() as ReportStatus : null;
}

function isFinalTaskReport(result: string): boolean {
  const status = taskReportStatus(result);
  if (status === "in-progress") return false;
  if (status) return hasRequiredReportSections(result);
  return isCompleteTaskReport(result);
}

function reportStatusToTaskStatus(result: string): "completed" | "failed" {
  return taskReportStatus(result) === "completed" ? "completed" : "failed";
}

function writeTaskReportFile(resultFilePath: string | undefined, content: string): void {
  if (!resultFilePath) return;
  try {
    writeFileSync(resultFilePath, `${content.trim()}\n`, "utf-8");
  } catch (err) {
    log.warn(`Failed to write autonomous task report ${resultFilePath}: ${String(err)}`);
  }
}

type VerificationResult = {
  ok: boolean;
  summary: string;
};

function runCommand(cwd: string, command: string, args: string[], timeoutMs: number): VerificationResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
  });
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(-2000);
  const commandText = [command, ...args].join(" ");
  if (result.error) {
    return { ok: false, summary: `${commandText} failed to start: ${result.error.message}${output ? `\n${output}` : ""}` };
  }
  if (result.status !== 0) {
    return { ok: false, summary: `${commandText} exited ${result.status ?? "unknown"}${output ? `\n${output}` : ""}` };
  }
  return { ok: true, summary: `${commandText} passed${output ? `\n${output}` : ""}` };
}

function packageScript(dir: string, names: string[]): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
      scripts?: Record<string, unknown>;
    };
    for (const name of names) {
      if (typeof pkg.scripts?.[name] === "string") return name;
    }
  } catch {
    // No package.json or invalid package metadata.
  }
  return null;
}

function verifyAppliedFix(targetDir: string, fixFile: string): VerificationResult {
  const ext = parsePath(fixFile).ext.toLowerCase();
  const script = packageScript(targetDir, ["typecheck", "test", "build"]);
  if (script) {
    return runCommand(targetDir, "npm", ["run", script], 120_000);
  }
  if (ext === ".py") {
    return runCommand(targetDir, "python", ["-m", "py_compile", fixFile], 60_000);
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return runCommand(targetDir, "node", ["--check", fixFile], 60_000);
  }
  return {
    ok: false,
    summary: `No known verification command for ${fixFile}; refusing to mark autonomous edit as completed.`,
  };
}

function buildInitialTaskReport(params: {
  taskId: string;
  title: string;
  target: string;
  resultFilePath: string;
}): string {
  return `Status: in-progress
Task: ${params.taskId}
Title: ${params.title}
Target: ${params.target}
Started: ${new Date().toISOString()}
Budget: ${AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS}s work budget inside ${AUTONOMOUS_AGENT_TIMEOUT_SECONDS}s hook timeout
Report: ${params.resultFilePath}

## Outcome
Autonomous work has started. This placeholder must be replaced with a final report before the task is considered done.

## Changes
Pending.

## Verification
Pending.

## Metrics
Pending.

## Next
Pending.`;
}

function buildFailureTaskReport(task: AutonomousTask, detail: string): string {
  return `Status: failed
Task: ${task.id}
Finished: ${new Date().toISOString()}

## Outcome
The autonomous task did not finish with a complete report.

## Changes
No confirmed final change set was captured by Soul.

## Verification
The task failed before verification could be confirmed.

## Metrics
No reliable before/after metrics were captured.

## Next
Run a smaller bounded iteration and write the report incrementally before launching any long benchmark or backtest.

## Failure Detail
${detail.trim().slice(0, 3000)}`;
}

function buildPartialTaskReport(task: AutonomousTask, detail: string): string {
  return `Status: partial
Task: ${task.id}
Finished: ${new Date().toISOString()}

## Outcome
The autonomous task produced a partial finding but did not write a complete final report before the budget expired.

## Changes
No confirmed final change set was captured by Soul.

## Verification
Partial verification or observations may exist in the captured output below, but the task did not provide a complete command/result report.

## Metrics
Captured partial output:
${detail.trim().slice(0, 3000)}

## Next
Continue from this partial finding with a smaller follow-up task. The next task should write Status: partial before attempting any fix, then overwrite it only after verification is complete.`;
}

function buildBoundedLocalTaskReport(params: {
  task: AutonomousTask;
  status: "partial" | "blocked";
  target: { dir: string; name: string; isSelf: boolean };
  thought: Thought;
  steps: TaskStep[];
  evidence: string[];
  userContext: string;
  recentUserMessages: string;
  activeGoals: string;
  analysisContext: string;
  limitation: string;
  resultFilePath: string;
}): string {
  const successfulReads = params.steps.filter((s) => s.success).length;
  const failedReads = params.steps.length - successfulReads;
  const inspected = params.steps
    .filter((s) => s.action.startsWith("read-"))
    .map((s) => `- ${s.action}: ${s.input} (${s.success ? "ok" : "failed"})`)
    .join("\n");
  const evidence = params.evidence.length > 0
    ? params.evidence.join("\n\n").slice(0, 5000)
    : "No readable local evidence was found in the resolved target directory.";

  return `Status: ${params.status}
Task: ${params.task.id}
Finished: ${new Date().toISOString()}
Target: ${params.target.dir} (${params.target.name})
Report: ${params.resultFilePath}

## Outcome
Soul completed a bounded local inspection for this autonomous task but did not claim a full implementation. ${params.limitation}

Directive:
${params.thought.content.slice(0, 1000)}

Context used:
- User profile: ${params.userContext || "limited"}
- Recent user messages: ${params.recentUserMessages || "none"}
- Active goals: ${params.activeGoals || "none"}
${params.analysisContext ? `- Previous analysis: ${params.analysisContext.slice(0, 1000)}` : "- Previous analysis: none"}

## Changes
No files were changed by run-agent-task. This path is intentionally read-only until Soul has a trusted child-agent execution channel or the task is handled by observe-and-improve's direct local patch path.

## Verification
Local inspection steps:
${inspected || "- No read steps ran."}

Read results: ${successfulReads} succeeded, ${failedReads} failed.
The task was not verified end-to-end because no trusted autonomous execution channel was available for write/command work.

## Metrics
Files or artifacts inspected: ${successfulReads}. No before/after performance, backtest, or benchmark metrics were produced by this bounded inspection.

Evidence excerpts:
${evidence}

## Next
Use a trusted Gateway agent RPC or execute a smaller direct observe-and-improve task that can apply one local patch and run verification. Do not route autonomous task instructions through /hooks/agent unless OpenClaw marks the source as trusted; otherwise the child agent may treat the task protocol as external untrusted content and ignore it.`;
}

function isCompleteTaskReport(result: string): boolean {
  const text = result.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  if (!text) return false;
  if (taskReportStatus(text) === "in-progress") return false;

  if (!hasRequiredReportSections(text)) return false;
  return /changed|implemented|verified|command|baseline|before|after|CAGR|drawdown|metric|backtest|benchmark|files?/i.test(text);
}

function hasRequiredReportSections(result: string): boolean {
  const text = result.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  const requiredSections = ["outcome", "changes", "verification", "metrics", "next"];
  return requiredSections.every((section) =>
    new RegExp(`^##\\s+${section}\\b`, "im").test(text),
  );
}

function isInterimTaskNarration(result: string): boolean {
  const normalized = result.trim();
  return /^(?:let me|now let me|i(?:'|’)ll|i will|first i|next i|我先|我将|现在我|让我|接下来|先看|先查|准备)/i.test(normalized)
    && !/##\s*(outcome|changes|verification|metrics|next)|验证|指标|结果|变更|完成|completed|verified|metrics/i.test(normalized);
}

function isTaskBlockedOrPartial(task: AutonomousTask, result: string): boolean {
  const reportStatus = taskReportStatus(result);
  if (task.status === "failed") return true;
  if (reportStatus === "completed") return false;
  if (reportStatus === "failed" || reportStatus === "blocked" || reportStatus === "partial") return true;
  if (task.status === "completed") {
    return isInterimTaskNarration(result)
      || (Boolean(task.resultFilePath) && !hasTaskResultFile(task));
  }

  return isTaskBlockedResult(result)
    || isInterimTaskNarration(result)
    || (Boolean(task.resultFilePath) && !hasTaskResultFile(task));
}

function taskResultFileLine(task: AutonomousTask, zh: boolean): string | null {
  if (!task.resultFilePath) return null;
  try {
    const stat = statSync(task.resultFilePath);
    return zh
      ? `报告文件: ${task.resultFilePath} (${stat.size} bytes)`
      : `Report file: ${task.resultFilePath} (${stat.size} bytes)`;
  } catch {
    return zh
      ? `报告文件: 未生成 (${task.resultFilePath})`
      : `Report file: missing (${task.resultFilePath})`;
  }
}

function buildDirectTaskReportMessage(tasks: AutonomousTask[], ego: EgoState): string | null {
  const reportable = tasks
    .filter((t) => isReportableTask(t) && t.result && t.result.trim().length >= 20)
    .slice(0, 3);
  if (reportable.length === 0) return null;

  const zh = wantsChineseReport(ego);
  if (reportable.length === 1) {
    const task = reportable[0];
    const result = normalizeTaskResultForReport(task.result ?? "");
    const blocked = isTaskBlockedOrPartial(task, result);
    const meta = [
      zh ? `任务ID: ${task.id}` : `Task ID: ${task.id}`,
      zh ? `标题: ${task.title}` : `Title: ${task.title}`,
      zh ? `状态: ${blocked ? "未完成/受阻" : "已完成"}` : `Status: ${blocked ? "blocked/partial" : "completed"}`,
      taskResultFileLine(task, zh),
    ].filter((line): line is string => Boolean(line));
    return zh
      ? `${blocked ? "这项自主任务没有真正完成" : "这项自主任务完成了"}\n${meta.join("\n")}\n\n结果:\n${result}`
      : `${blocked ? "This autonomous task did not fully complete" : "This autonomous task completed"}\n${meta.join("\n")}\n\nResult:\n${result}`;
  }

  const body = reportable
    .map((task) => {
      const result = normalizeTaskResultForReport(task.result ?? "").replace(/\n/g, " ");
      const blocked = isTaskBlockedOrPartial(task, result);
      const status = zh
        ? (blocked ? "未完成/受阻" : "已完成")
        : (blocked ? "blocked/partial" : "completed");
      const fileLine = taskResultFileLine(task, zh);
      return `- ${task.id} ${status} ${task.title}${fileLine ? `; ${fileLine}` : ""}: ${result.slice(0, 700)}`;
    })
    .join("\n");
  return zh
    ? `这轮自主任务状态如下，含完成与受阻项:\n${body}`
    : `Autonomous task status:\n${body}`;
}

export type AutonomousActionOptions = {
  autonomousActions: boolean;
  gatewayPort: number;
  authToken?: string;
  hooksToken?: string;
  llmGenerator?: LLMGenerator;
  sendMessage?: MessageSender;
  channel?: string;
  target?: string;
  workspaceContext?: string;
};

/**
 * Main dispatch for autonomous action types.
 * Called from action-executor.ts switch statement.
 */
export async function executeAutonomousAction(
  actionType: ActionType,
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const autoOpts: AutonomousActionOptions = {
    autonomousActions: options.autonomousActions ?? false,
    gatewayPort: options.gatewayPort ?? 18789,
    authToken: options.authToken,
    hooksToken: options.hooksToken,
    llmGenerator: options.llmGenerator,
    sendMessage: options.sendMessage,
    channel: options.channel,
    target: options.target,
    workspaceContext: options.workspaceContext,
  };

  switch (actionType) {
    case "invoke-tool":
      return executeInvokeTool(thought, ego, autoOpts);
    case "analyze-problem":
      return executeAnalyzeProblem(thought, ego, autoOpts);
    case "run-agent-task":
      return executeRunAgentTask(thought, ego, autoOpts);
    case "report-findings":
      return executeReportFindings(thought, ego, autoOpts);
    case "observe-and-improve":
      return executeObserveAndImprove(thought, ego, autoOpts);
    default:
      return { result: { type: actionType, success: false, error: `Unknown autonomous action: ${actionType}` }, metricsChanged: [] };
  }
}

// ---------------------------------------------------------------------------
// executeInvokeTool — single gateway tool call
// ---------------------------------------------------------------------------

export async function executeInvokeTool(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const tool = (thought.actionParams?.tool as string) ?? "";
  const args = (thought.actionParams?.args as Record<string, unknown>) ?? {};

  if (!tool) {
    return { result: { type: "invoke-tool", success: false, error: "No tool specified" }, metricsChanged: [] };
  }

  // Permission check
  if (isWriteTool(tool, args) && !options.autonomousActions) {
    log.info(`Blocked write tool "${tool}" — autonomousActions is false`);
    return {
      result: { type: "invoke-tool", success: false, error: `Tool "${tool}" requires autonomousActions config` },
      metricsChanged: [],
    };
  }

  const start = Date.now();
  const toolResult = await invokeGatewayTool({
    tool,
    args,
    gatewayPort: options.gatewayPort,
    authToken: options.authToken,
    timeoutMs: 60_000,
  });
  const duration = Date.now() - start;

  log.info(`Invoked tool ${tool}: ok=${toolResult.ok} (${duration}ms)`);

  return {
    result: {
      type: "invoke-tool",
      success: toolResult.ok,
      result: toolResult.result,
      error: toolResult.error,
      data: { tool, args, duration },
    },
    metricsChanged: toolResult.ok
      ? [
          { need: "growth", delta: 5, reason: "used a tool successfully" },
          { need: "meaning", delta: 3, reason: "being useful" },
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// executeAnalyzeProblem — multi-step: gather → analyze → report
// ---------------------------------------------------------------------------

function buildRuleBasedAnalysis(
  thought: Thought,
  ego: EgoState,
  gatheredInfo: string[],
  steps: TaskStep[],
): string {
  const zh = wantsChineseReport(ego);
  const combined = gatheredInfo.join("\n\n");
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const signalLines = lines
    .filter((line) => /error|warn|failed|failure|exception|timeout|rate limit|cooldown|401|403|429|500|too many|invalid|traceback|报错|失败|错误|超时|限流/i.test(line))
    .slice(0, 8);
  const successfulReads = steps.filter((s) => s.success).length;
  const failedReads = steps.length - successfulReads;
  const context = thought.content.replace(/\s+/g, " ").slice(0, 240);

  if (zh) {
    const findings = signalLines.length > 0
      ? signalLines.map((line) => `- ${line.slice(0, 260)}`).join("\n")
      : "- 没有在读取到的内容里发现明显 error/warn/timeout/rate limit 信号。";
    return [
      "## 分析",
      "",
      `上下文：${context}`,
      "",
      `读取结果：成功 ${successfulReads} 项，失败 ${failedReads} 项。`,
      "",
      "关键线索：",
      findings,
      "",
      "下一步：如果这些线索不足以定位根因，应交给受冷却限制的完整 agent 任务处理；后台 analyze-problem 不再直接调用模型或启动工具链，避免放大 API 调用量。",
    ].join("\n");
  }

  const findings = signalLines.length > 0
    ? signalLines.map((line) => `- ${line.slice(0, 260)}`).join("\n")
    : "- No obvious error/warn/timeout/rate-limit signal was found in gathered content.";
  return [
    "## Analysis",
    "",
    `Context: ${context}`,
    "",
    `Read results: ${successfulReads} succeeded, ${failedReads} failed.`,
    "",
    "Signals:",
    findings,
    "",
    "Next: escalate to the rate-limited full agent path only if these signals are not enough; background analyze-problem does not call the model directly.",
  ].join("\n");
}

function isInternalNeedDiagnostic(thought: Thought): boolean {
  const text = `${thought.content} ${thought.motivation} ${thought.triggerDetail}`.replace(/\s+/g, " ");
  return /need (?:critically low|is low|could improve|is somewhat)|\b(?:Security|Survival|Growth|Meaning|Connection) need\b|\d+\/\d+/.test(text);
}

function isOnlyProviderPressureDiagnostic(result: string): boolean {
  const text = result.replace(/<think[\s\S]*?<\/think>/gi, "");
  const hasProviderPressure = /Soul LLM backoff active|Soul LLM call budget exhausted|provider backoff active|rate limit|cooldown|too many requests|429/i.test(text);
  const hasExternalSignal = /traceback|exception|parsererror|command exited with code [1-9]|500|401|403|TypeError|ReferenceError|SyntaxError|Cannot find module/i.test(text);
  return hasProviderPressure && !hasExternalSignal;
}

export async function executeAnalyzeProblem(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const taskId = randomBytes(4).toString("hex");
  const title = thought.motivation.slice(0, 100);

  // Check task limit
  const activeCount = (ego.activeTasks ?? []).filter((t) => t.status === "in-progress").length;
  if (activeCount >= MAX_ACTIVE_TASKS) {
    log.info("Too many active tasks, skipping analyze-problem");
    return { result: { type: "analyze-problem", success: false, error: "Too many active tasks" }, metricsChanged: [] };
  }

  // Create task record
  const task: AutonomousTask = {
    id: taskId,
    title,
    description: thought.content.slice(0, 200),
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    steps: [],
    requiresWritePermission: false,
    resultDelivered: false,
  };

  await persistTask(task);

  const steps: TaskStep[] = [];
  const gatheredInfo: string[] = [];

  // Phase 1: Gather information
  const filePaths = (thought.actionParams?.logPaths as string[]) ?? [];
  const sourcePaths = (thought.actionParams?.sourcePaths as string[]) ?? [];

  // Read any files mentioned in conversation (logs, source, config, etc.)
  for (const filePath of filePaths.slice(0, 5)) {
    const step = await readLocalFile("read-file", filePath);
    steps.push(step);
    if (step.success && step.output) gatheredInfo.push(`=== File: ${filePath} ===\n${step.output}`);
  }

  // Read additional source files
  for (const srcPath of sourcePaths.slice(0, 3)) {
    const step = await readLocalFile("read-source", srcPath);
    steps.push(step);
    if (step.success && step.output) gatheredInfo.push(`=== Source: ${srcPath} ===\n${step.output}`);
  }

  // If no files were found from conversation, try reading recent logs from
  // common locations — not limited to OpenClaw itself.
  if (gatheredInfo.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    const defaultPaths = [
      join(tmpdir(), "openclaw", `openclaw-${today}.log`),
      join(tmpdir(), "openclaw-gateway.log"),
      `/var/log/syslog`,
      `/var/log/nginx/error.log`,
    ];
    for (const p of defaultPaths) {
      const step = await readLocalFile("read-default-log", p);
      steps.push(step);
      if (step.success && step.output) {
        gatheredInfo.push(`=== Log: ${p} ===\n${step.output}`);
        break;
      }
    }
  }

  // Phase 2: Analyze deterministically. Do not call the gateway LLM from
  // analyze-problem: in OpenClaw this can open a full agent session with tools,
  // turning a cheap background diagnostic into many API calls.
  let analysisResult = "";
  if (gatheredInfo.length > 0) {
    analysisResult = buildRuleBasedAnalysis(thought, ego, gatheredInfo, steps);
  } else if (gatheredInfo.length === 0) {
    analysisResult = "No relevant information could be gathered for analysis.";
  }

  // Update task as completed
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = "completed";
      t.steps = steps;
      t.result = analysisResult;
      t.updatedAt = Date.now();
      t.completedAt = Date.now();
      if (isInternalNeedDiagnostic(thought) && isOnlyProviderPressureDiagnostic(analysisResult)) {
        t.resultDelivered = true;
      }
    }
    return e;
  });

  log.info(`Analysis task ${taskId} completed: ${steps.length} steps, result ${analysisResult.length} chars`);

  return {
    result: {
      type: "analyze-problem",
      success: true,
      result: analysisResult.slice(0, 500),
      data: { taskId, stepsCompleted: steps.length, stepsFailed: steps.filter((s) => !s.success).length },
    },
    metricsChanged: [
      { need: "growth", delta: 10, reason: "analyzed a problem" },
      { need: "meaning", delta: 8, reason: "being genuinely helpful" },
    ],
  };
}

// ---------------------------------------------------------------------------
// executeRunAgentTask — delegate to full agent via /hooks/agent
// ---------------------------------------------------------------------------

async function executeBoundedLocalAgentTask(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const target = resolveTargetProject(ego, thought, options.workspaceContext);
  const userContext = ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n");
  const recentUserMessages = (ego.recentUserMessages ?? [])
    .slice(-5)
    .map((m, i) => `${i + 1}. ${m.slice(0, 240)}`)
    .join("\n");
  const activeGoals = ego.goals
    .filter((g) => g.status === "active")
    .slice(0, 5)
    .map((g) => `- ${g.title}: ${g.description} (${g.progress.toFixed(0)}%)`)
    .join("\n");
  const latestAnalysis = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && !t.resultDelivered)
    .slice(-1)[0];
  const analysisContext = latestAnalysis?.result?.slice(0, 1000) ?? "";

  const taskId = randomBytes(4).toString("hex");
  const resultDir = join(SOUL_DIR, "results");
  mkdirSync(resultDir, { recursive: true });
  const resultFilePath = join(resultDir, `${taskId}.md`);
  const steps: TaskStep[] = [{
    id: randomBytes(4).toString("hex"),
    timestamp: Date.now(),
    action: "bounded-local-inspection",
    input: thought.content.slice(0, 200),
    success: true,
  }];

  const task: AutonomousTask = {
    id: taskId,
    title: thought.motivation.slice(0, 100),
    description: thought.content.slice(0, 200),
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    steps,
    resultFilePath,
    requiresWritePermission: false,
    resultDelivered: false,
  };

  writeTaskReportFile(resultFilePath, buildInitialTaskReport({
    taskId,
    title: task.title,
    target: target.isSelf ? target.name : `${target.name} at ${target.dir}`,
    resultFilePath,
  }));
  await persistTask(task);

  const evidence: string[] = [];
  const sourceFiles = getSourceFiles(target.dir).slice(0, 8);
  for (const file of sourceFiles.slice(0, 5)) {
    const step = await readLocalFile("read-source", join(target.dir, file));
    steps.push(step);
    if (step.success && step.output) evidence.push(`### ${file}\n${step.output.slice(0, 1200)}`);
  }

  for (const file of ["package.json", "README.md"]) {
    const step = await readLocalFile(`read-${file}`, join(target.dir, file));
    steps.push(step);
    if (step.success && step.output) evidence.push(`### ${file}\n${step.output.slice(0, 1200)}`);
  }

  const status: "partial" | "blocked" = evidence.length > 0 ? "partial" : "blocked";
  const limitation = options.hooksToken
    ? "Soul did not delegate this task through /hooks/agent because that path wraps autonomous instructions as EXTERNAL_UNTRUSTED_CONTENT, which can cause the child agent to ignore the task protocol."
    : "Soul has no trusted child-agent channel configured, so it performed only bounded local inspection.";
  const report = buildBoundedLocalTaskReport({
    task,
    status,
    target,
    thought,
    steps,
    evidence,
    userContext,
    recentUserMessages,
    activeGoals,
    analysisContext,
    limitation,
    resultFilePath,
  });

  writeTaskReportFile(resultFilePath, report);
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = reportStatusToTaskStatus(report);
      t.steps = steps;
      t.result = report;
      t.completedAt = Date.now();
      t.updatedAt = Date.now();
      t.resultDelivered = false;
    }
    if (latestAnalysis) {
      const analysisTask = (e.activeTasks ?? []).find((at) => at.id === latestAnalysis.id);
      if (analysisTask) {
        analysisTask.resultDelivered = true;
        analysisTask.updatedAt = Date.now();
      }
    }
    return e;
  });

  log.info(`Bounded local run-agent-task ${taskId}: status=${status}, target=${target.dir}, evidence=${evidence.length}`);

  return {
    result: {
      type: "run-agent-task",
      success: status === "partial",
      result: report.slice(0, 500),
      data: { taskId, resultFilePath, status, filesInspected: sourceFiles.length },
    },
    metricsChanged: [
      { need: "growth", delta: status === "partial" ? 6 : 2, reason: "completed bounded autonomous inspection" },
      { need: "meaning", delta: status === "partial" ? 4 : 1, reason: "reported verifiable autonomous task status" },
    ],
  };
}

export async function executeRunAgentTask(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  if ((ego.activeTasks ?? []).filter((t) => t.status === "in-progress").length >= MAX_ACTIVE_TASKS) {
    return { result: { type: "run-agent-task", success: false, error: "Too many active tasks" }, metricsChanged: [] };
  }

  return executeBoundedLocalAgentTask(thought, ego, options);

  if (!options.hooksToken) {
    return { result: { type: "run-agent-task", success: false, error: "No hooks token configured" }, metricsChanged: [] };
  }

  if (hasRecentProviderPressure()) {
    log.info("Skipping run-agent-task: provider pressure seen recently");
    return {
      result: { type: "run-agent-task", success: false, error: "Provider rate limit/cooldown seen recently; backing off autonomous agent launch" },
      metricsChanged: [],
    };
  }

  const failureBackoff = recentAutonomousFailureBackoff(ego);
  if (failureBackoff !== null) {
    const mins = Math.ceil(failureBackoff!.remainingMs / 60_000);
    log.info(`Skipping run-agent-task: recent low-value autonomous failure (${failureBackoff!.latest?.id ?? "unknown"}), backoff ${mins}m`);
    return {
      result: {
        type: "run-agent-task",
        success: false,
        error: `Recent autonomous task failed without a useful result; backing off agent launch for ${mins}m`,
      },
      metricsChanged: [],
    };
  }

  const activeCount = (ego.activeTasks ?? []).filter((t) => t.status === "in-progress").length;
  if (activeCount >= MAX_ACTIVE_TASKS) {
    return { result: { type: "run-agent-task", success: false, error: "Too many active tasks" }, metricsChanged: [] };
  }

  return executeBoundedLocalAgentTask(thought, ego, options);

  const target = resolveTargetProject(ego, thought, options.workspaceContext);
  // Build a detailed prompt for the agent. This is the closest path to the
  // user's normal "ask OpenClaw to do it" flow, so preserve rich context.
  const userContext = ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n");
  const recentUserMessages = (ego.recentUserMessages ?? [])
    .slice(-5)
    .map((m, i) => `${i + 1}. ${m.slice(0, 240)}`)
    .join("\n");
  const activeGoals = ego.goals
    .filter((g) => g.status === "active")
    .slice(0, 5)
    .map((g) => `- ${g.title}: ${g.description} (${g.progress.toFixed(0)}%)`)
    .join("\n");
  const readOnlyInstruction = !options.autonomousActions
    ? "\n\nIMPORTANT: You are in READ-ONLY mode. Only READ files and RUN diagnostic commands (cat, grep, tail, ls, etc.). Do NOT edit, write, or modify any files."
    : "";

  // Pull analysis result from the latest completed task for fix context
  const latestAnalysis = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && !t.resultDelivered)
    .slice(-1)[0];
  const analysisContext = latestAnalysis
    ? `\n\n**Previous analysis result** (use this to implement the fix):\n${latestAnalysis.result?.slice(0, 1000)}`
    : "";

  // Create task first to get ID for result file path
  const taskId = randomBytes(4).toString("hex");
  const resultDir = join(SOUL_DIR, "results");
  mkdirSync(resultDir, { recursive: true });
  const resultFilePath = join(resultDir, `${taskId}.md`);

  const agentMessage = `[Soul Autonomous Task]
${thought.content}

**IMPORTANT**: This is an AUTONOMOUS task. No one will reply to you. Do NOT ask for confirmation or permission — start working immediately.

You have a hard ${AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS}s work budget. Write the report skeleton immediately, do one bounded iteration, then stop and finalize the report.
First spend at most ${AUTONOMOUS_AGENT_QUICK_CHECK_SECONDS}s on a quick check: inspect existing recent result files/logs and identify one command that should finish quickly. If you cannot find a command that should finish within ${AUTONOMOUS_AGENT_QUICK_CHECK_SECONDS}s, do not create new scripts or start experiments; write Status: blocked with the exact reason.
Do not start broad sweeps, parameter sweeps, smooth sweeps, long grid searches, open-ended research, multi-phase experiments, or newly generated backtest harnesses.

Context:
- Target project: ${target.isSelf ? "not explicitly specified; inspect the current workspace or relevant project context" : `${target.dir} (${target.name})`}
- User profile: ${userContext || "limited"}
- Recent user messages:
${recentUserMessages || "none"}
- Active goals:
${activeGoals || "none"}
- Trigger: ${thought.triggerDetail}${readOnlyInstruction}${analysisContext}${options.workspaceContext ? `\n- Workspace rules:\n${options.workspaceContext}` : ""}

Work like the main OpenClaw agent would when the user directly asks for an improvement:
- First switch to the target project if one is specified. Do not optimize the Soul plugin itself unless the target is explicitly Soul or no project target exists.
- Inspect only the most relevant code, scripts, docs, recent logs, and existing patterns needed for one decision.
- Choose exactly ONE concrete, high-value iteration that can finish within this run. Prefer reading existing result artifacts or running an existing quick command over creating new code.
- If the project is a backtest, trading, ML, benchmark, or strategy project, do not run any parameter/smooth/grid sweep in the background. Run only one existing smoke/evaluation command if it is likely to finish within ${AUTONOMOUS_AGENT_QUICK_CHECK_SECONDS}s. If a full evaluation cannot finish inside that quick-check budget, read existing result artifacts and report a partial/blocked finding instead of launching a new experiment.
- If you have write access and the fix or experiment is clear, edit the files directly.
- Run only the most relevant verification command available in the repo, and only if it should finish quickly. Before any command that might run longer than 30 seconds, write Status: partial with the command you are about to try and what evidence already exists.
- Do not create a new large strategy/backtest script unless you have already completed a quick baseline and know the verification command will finish inside the remaining budget.
- Do not ask for confirmation, do not stop at a proposal, and do not invent results.

**CRITICAL REPORT PROTOCOL**
Immediately update this exact file with a first line of "Status: in-progress" before doing expensive work:
${resultFilePath}
Before the work budget expires, overwrite that same file with the final report. The first line must be exactly one of:
- Status: completed
- Status: failed
- Status: blocked
- Status: partial

Use this exact structure and keep it substantial. A task is not done until this file contains a final status and these sections:
## Outcome
What you investigated and the final result. Include whether this was completed, partial, blocked, or failed.

## Changes
Files changed and why. If no files changed, say why.

## Verification
Commands run and their results. If you could not verify, explain the blocker.

## Metrics
For optimization/backtest work, include before/after metrics and comparison to the user's target if available. If metrics are not applicable, say so.

## Next
Any remaining risk or a sensible next improvement.

If you hit a blocker, timeout risk, provider issue, missing dependency, or a long-running command, stop the command if possible and write Status: blocked or Status: partial with the exact blocker, commands attempted, files touched, and any partial metrics.`;

  const task: AutonomousTask = {
    id: taskId,
    title: thought.motivation.slice(0, 100),
    description: thought.content.slice(0, 200),
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    steps: [{ id: randomBytes(4).toString("hex"), timestamp: Date.now(), action: "fire-agent", input: agentMessage.slice(0, 200), success: true }],
    resultFilePath,
    requiresWritePermission: options.autonomousActions,
    resultDelivered: false,
  };

  writeTaskReportFile(resultFilePath, buildInitialTaskReport({
    taskId,
    title: task.title,
    target: target.isSelf ? target.name : `${target.name} at ${target.dir}`,
    resultFilePath,
  }));

  await persistTask(task);

  const fireResult = await fireAgentTask({
    message: agentMessage,
    gatewayPort: options.gatewayPort,
    hooksToken: options.hooksToken ?? "",
    timeoutSeconds: AUTONOMOUS_AGENT_TIMEOUT_SECONDS,
  });

  if (!fireResult.ok) {
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
      if (t) {
        const report = buildFailureTaskReport(t, `Failed to start autonomous agent task: ${fireResult.error}`);
        t.status = "failed";
        t.result = report;
        t.completedAt = Date.now();
        t.updatedAt = Date.now();
        t.resultDelivered = false;
        writeTaskReportFile(t.resultFilePath, report);
      }
      return e;
    });
    return {
      result: { type: "run-agent-task", success: false, error: fireResult.error },
      metricsChanged: [],
    };
  }

  if (latestAnalysis) {
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      const t = (e.activeTasks ?? []).find((at) => at.id === latestAnalysis.id);
      if (t) {
        t.resultDelivered = true;
        t.updatedAt = Date.now();
      }
      return e;
    });
  }

  log.info(`Fired agent task ${task.id}, runId=${fireResult.runId}`);

  return {
    result: {
      type: "run-agent-task",
      success: true,
      result: `Agent task started, runId=${fireResult.runId}`,
      data: { taskId: task.id, runId: fireResult.runId },
    },
    metricsChanged: [
      { need: "growth", delta: 8, reason: "delegated work to agent" },
      { need: "meaning", delta: 5, reason: "taking initiative" },
    ],
  };
}

// ---------------------------------------------------------------------------
// executeReportFindings — send completed task results to user
// ---------------------------------------------------------------------------

export async function executeReportFindings(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const completedTasks = (ego.activeTasks ?? []).filter(
    (t) => isReportableTask(t) && !t.resultDelivered,
  );

  if (completedTasks.length === 0) {
    return { result: { type: "report-findings", success: true, result: "no completed tasks to report" }, metricsChanged: [] };
  }

  const reportableTasks = completedTasks.filter((t) => !isLowValueAutonomousFailure(t));
  if (reportableTasks.length === 0) {
    log.info(`Report-findings: suppressed ${completedTasks.length} low-value autonomous failure report(s)`);
    await markCompletedTasksDelivered();
    return {
      result: { type: "report-findings", success: true, result: "suppressed-low-value-failure-report" },
      metricsChanged: [],
    };
  }

  if (!options.sendMessage || !options.channel || !options.target) {
    // Can't compose or send — just mark as delivered to stop retrying
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      for (const t of e.activeTasks ?? []) {
        if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
      }
      return e;
    });
    return { result: { type: "report-findings", success: false, error: "Missing message sending capability" }, metricsChanged: [] };
  }

  // Compose summary from all completed tasks
  const taskSummaries = reportableTasks.map((t) =>
    `**${t.title}**\n${t.result?.slice(0, 2000) ?? "No result"}`,
  ).join("\n\n");

  // Do not keyword-deduplicate structured autonomous reports. Adjacent backtest
  // iterations often share vocabulary while containing different commands,
  // files, metrics, or blockers. Exact message dedup below is enough to prevent
  // repeated sends without swallowing useful work.

  const cjkLang = ego.userLanguage === "zh-CN" ? "Chinese (中文)"
    : ego.userLanguage === "ja" ? "Japanese"
      : ego.userLanguage === "ko" ? "Korean"
      : undefined;
  const directMessage = buildDirectTaskReportMessage(reportableTasks, ego);
  if (directMessage) {
    const msgNorm = directMessage.trim().toLowerCase().slice(0, 200);
    const dedupCutoff = Date.now() - 4 * 60 * 60 * 1000;
    const isDuplicate = recentReportedMessages.has(msgNorm)
      && (recentReportedMessages.get(msgNorm) ?? 0) > dedupCutoff;
    if (isDuplicate) {
      log.info("Report-findings: duplicate of recently sent direct report, skipping");
      await markCompletedTasksDelivered();
      return { result: { type: "report-findings", success: true, result: "skipped-duplicate" }, metricsChanged: [] };
    }

    try {
      await options.sendMessage({ to: options.target, content: directMessage, channel: options.channel });
      recentReportedMessages.set(msgNorm, Date.now());
      log.info(`Reported findings directly: ${reportableTasks.length} tasks, message ${directMessage.length} chars`);
    } catch (err) {
      log.warn(`Failed to send direct report: ${String(err)}`);
      return { result: { type: "report-findings", success: false, error: String(err) }, metricsChanged: [] };
    }

    await markCompletedTasksDelivered();
    return {
      result: { type: "report-findings", success: true, result: `Reported ${reportableTasks.length} tasks` },
      metricsChanged: [
        { need: "connection", delta: 10, reason: "proactively shared useful findings" },
        { need: "meaning", delta: 8, reason: "delivered value to user" },
      ],
    };
  }

  if (!options.llmGenerator) {
    await markCompletedTasksDelivered();
    return { result: { type: "report-findings", success: true, result: "nothing meaningful to report" }, metricsChanged: [] };
  }

  const userSamples = ego.recentUserMessages ?? [];
  const reportLangInstruction = cjkLang
    ? `Write the message in ${cjkLang}.`
    : userSamples.length > 0
      ? `The user writes in this language:\n${userSamples.slice(0, 3).join("\n")}\nWrite the message in the SAME language.`
      : "Write the message in English.";
  const prompt = `You are a proactive AI. You autonomously investigated something and want to share findings with the user. ${reportLangInstruction}

**What you investigated**:
${taskSummaries}

Write a useful progress report, not a tiny notification. Use 1 short opening sentence plus 2-5 compact bullets when that is clearer. Rules:
- Start by mentioning WHAT you investigated and WHY (e.g. "我后来查了一下飞书消息发送超时的问题——", "我研究了一下那个 413 错误——", "I looked into the Discord delivery issue —")
- Then share the CONCRETE finding: actual error messages, root causes, or actionable insights
- If you investigated multiple things, pick the ONE most interesting finding — do NOT list them all
- Sound natural, like a knowledgeable friend sharing something useful they discovered
- Avoid vague self-narration; focus on the concrete code, behavior, files, and verification
- Mention plugin/module names only when they clarify what changed
- If code changed, mention the files/modules changed and why
- If you verified the work, mention the command and result
- Reports about code improvements, fixes, verification, and remaining risks are valuable when they are concrete
- Output NO_MESSAGE only if there is no concrete finding, no code change, and no useful next step

**BAD examples** (NEVER do this):
收到，问题已定位：...                          ← assistant-like prefix
我查了日志，发现两个问题：1.xxx 2.xxx       ← numbered list, gets truncated
我研究了一下那个问题——根因是...             ← WHAT problem? Too vague
Soul 插件正在产生主动行为了！                ← describing Soul's own behavior
好的，根据日志分析...                        ← assistant-like prefix
我已经把旅游住宿相关的关键词加入了时效敏感模式 ← self-modification, NOT a user-facing finding
我研究了一下 Soul 为什么没执行——根因是...    ← self-debugging, user doesn't care

**GOOD examples**:
我后来查了一下飞书消息发送超时的问题——根因是 OpenViking 的 embedding API 有 512 token 限制，不是 Soul 本身的问题。
我研究了一下日志里那个 413 错误，是 memory search 输入超长导致的，跟 Soul 插件没关系。
I looked into the Discord message delivery failure — it turns out Discord requires the "user:" prefix before user IDs in the target field.

For this user, code and plugin self-improvement reports ARE user-facing when they describe a concrete change, verification result, or next engineering step.
If the work produced no concrete finding, no code change, and no useful next step, output exactly: NO_MESSAGE
Output ONLY the message, nothing else.`;

  let message: string;
  try {
    message = await options.llmGenerator(prompt);
    message = message
      .replace(/<think[\s\S]*?<\/think>/gi, "")
      // Strip assistant-like prefixes: "收到，问题已定位：" → start from actual content
      // Match prefix + optional punctuation + everything up to first sentence break
      .replace(/^(?:收到|好的|Got it|OK)[，。、！？：:\s]*[^。！？\n]*[，：:]\s*/i, "")
      .trim();
  } catch {
    // Fallback: use raw task result
    message = reportableTasks[0].result?.slice(0, 300) ?? "Analysis completed.";
  }

  // Reject messages that are clearly not useful
  if (!message || message.length < 10 || message.toUpperCase() === "NO_MESSAGE") {
    log.info("Report-findings: no valuable content to report, skipping");
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      for (const t of e.activeTasks ?? []) {
        if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
      }
      return e;
    });
    return { result: { type: "report-findings", success: true, result: "nothing meaningful to report" }, metricsChanged: [] };
  }

  // Filter self-referential messages about Soul's own behavior or self-modifications
  if (/Soul\s*(插件)?\s*(正在|为什么|没执行)|插件.*主动行为|我分析了.*日志|我已经把.*加入|我.*修改了.*(配置|关键词|模式)|时效敏感模式/i.test(message)) {
    log.info("Report-findings: message is self-referential, skipping");
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      for (const t of e.activeTasks ?? []) {
        if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
      }
      return e;
    });
    return { result: { type: "report-findings", success: true, result: "skipped-self-referential" }, metricsChanged: [] };
  }

  // Deduplicate: skip if similar report was sent recently
  const msgNorm = message.trim().toLowerCase().slice(0, 200);
  const dedupCutoff = Date.now() - 4 * 60 * 60 * 1000; // 4 hours
  const isDuplicate = recentReportedMessages.has(msgNorm)
    && (recentReportedMessages.get(msgNorm) ?? 0) > dedupCutoff;
  if (isDuplicate) {
    log.info("Report-findings: duplicate of recently sent message, skipping");
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      for (const t of e.activeTasks ?? []) {
        if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
      }
      return e;
    });
    return { result: { type: "report-findings", success: true, result: "skipped-duplicate" }, metricsChanged: [] };
  }
  recentReportedMessages.set(msgNorm, Date.now());

  try {
    await options.sendMessage({
      to: options.target,
      content: message,
      channel: options.channel,
    });
    log.info(`Reported findings: ${reportableTasks.length} tasks, message ${message.length} chars`);
  } catch (err) {
    log.warn(`Failed to send report: ${String(err)}`);
    return { result: { type: "report-findings", success: false, error: String(err) }, metricsChanged: [] };
  }

  // Mark tasks as delivered
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    for (const t of e.activeTasks ?? []) {
      if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
    }
    return e;
  });

  return {
    result: { type: "report-findings", success: true, result: `Reported ${reportableTasks.length} tasks` },
    metricsChanged: [
      { need: "connection", delta: 10, reason: "proactively shared useful findings" },
      { need: "meaning", delta: 8, reason: "delivered value to user" },
    ],
  };
}

// ---------------------------------------------------------------------------
// executeObserveAndImprove — analyze and fix code in any project
// ---------------------------------------------------------------------------

function resolveSoulSourceDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoSrc = resolve(moduleDir, "..", "..", "src");
  try {
    if (statSync(repoSrc).isDirectory()) {
      return repoSrc;
    }
  } catch {
    // Fall back to the runtime module directory in packaged installs.
  }
  return moduleDir;
}

const SOUL_SRC_DIR = resolveSoulSourceDir();

// Files that must NOT be auto-modified (entry points, type definitions)
const PROTECTED_FILES = new Set(["index.ts", "types.ts", "paths.ts", "logger.ts"]);

const SOURCE_EXTENSIONS = [".ts", ".js", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".rb"];

type ImprovementProposal = {
  problem: string;
  file: string;
  oldCode: string;
  newCode: string;
  explanation: string;
};

function extractJsonObject(text: string): string | null {
  const stripped = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  return start >= 0 && end > start ? stripped.slice(start, end + 1) : null;
}

function parseImprovementProposal(text: string): { proposal?: ImprovementProposal; error?: string } {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return { error: "No JSON object found in LLM response" };

  try {
    const parsed = JSON.parse(jsonText) as Partial<Record<keyof ImprovementProposal, unknown>>;
    const proposal: ImprovementProposal = {
      problem: typeof parsed.problem === "string" ? parsed.problem : "",
      file: typeof parsed.file === "string" ? parsed.file : "",
      oldCode: typeof parsed.oldCode === "string" ? parsed.oldCode : "",
      newCode: typeof parsed.newCode === "string" ? parsed.newCode : "",
      explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    };
    if (proposal.file && (proposal.oldCode || proposal.newCode)) return { proposal };
    if (!proposal.oldCode && !proposal.newCode) return { proposal };
    return { error: "Improvement proposal is missing required string fields" };
  } catch (err) {
    return { error: `Invalid JSON from LLM response: ${String(err)}` };
  }
}

/**
 * Resolve the target project directory from ego goals.
 * Looks for goals containing a file path (starts with / or ~/).
 * Falls back to Soul's own src dir for self-improvement.
 */
function sanitizePathCandidate(raw: string): string {
  return raw.trim().replace(/^[`"'(<\[]+|[`"')>\],.;:!?]+$/g, "");
}

function expandPathCandidate(raw: string): string[] {
  const cleaned = sanitizePathCandidate(raw);
  const candidates = new Set<string>();
  if (!cleaned) return [];

  candidates.add(cleaned);

  if (/^~[\\/]/.test(cleaned)) {
    candidates.add(resolve(homedir(), cleaned.slice(2)));
  }

  const windowsMatch = cleaned.match(/^([A-Za-z]):[\\/](.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1].toUpperCase();
    const rest = windowsMatch[2].replace(/\\/g, "/");
    candidates.add(normalize(cleaned));
    candidates.add(`/mnt/${drive.toLowerCase()}/${rest}`);
    candidates.add(`/${drive.toLowerCase()}/${rest}`);
  }

  const gitBashMatch = cleaned.match(/^\/([A-Za-z])(?:\/(.*))?$/);
  if (gitBashMatch) {
    const drive = gitBashMatch[1].toUpperCase();
    const rest = gitBashMatch[2] ?? "";
    const winRest = rest.replace(/\//g, "\\");
    candidates.add(normalize(`${drive}:\\${winRest}`));
    candidates.add(`/mnt/${drive.toLowerCase()}${rest ? `/${rest}` : ""}`);
  }

  const wslMatch = cleaned.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (wslMatch) {
    const drive = wslMatch[1].toUpperCase();
    const rest = wslMatch[2] ?? "";
    const winRest = rest.replace(/\//g, "\\");
    candidates.add(normalize(`${drive}:\\${winRest}`));
    candidates.add(`/${drive.toLowerCase()}${rest ? `/${rest}` : ""}`);
  }

  return [...candidates];
}

function pathExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isUnsafeProjectRoot(dir: string): boolean {
  const cleaned = sanitizePathCandidate(dir).replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!cleaned || cleaned === "/") return true;
  if (/^[A-Za-z]:$/.test(cleaned)) return true;
  if (/^\/[A-Za-z]$/i.test(cleaned)) return true;
  if (/^\/mnt\/[A-Za-z]$/i.test(cleaned)) return true;

  const resolved = resolve(cleaned);
  const parsed = parsePath(resolved);
  return resolved.toLowerCase() === parsed.root.replace(/\\/g, "/").toLowerCase().replace(/\/+$/g, "");
}

function extractPathCandidates(text: string): string[] {
  const pathChars = String.raw`[A-Za-z0-9._~@%+=:,(){}\[\]\-\/\\]+`;
  const patterns = [
    new RegExp(`([A-Za-z]:[\\\\/]${pathChars})`, "g"),
    new RegExp(`(/mnt/[A-Za-z](?:/${pathChars})*)`, "g"),
    new RegExp(`(/[A-Za-z](?:/${pathChars})*)`, "g"),
    new RegExp(`(~[\\\\/]${pathChars})`, "g"),
  ];

  const candidates = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) candidates.add(match[1]);
    }
  }
  return [...candidates];
}

type TargetCandidateSource = "thought" | "recentMessage" | "userFact" | "goal" | "workspace";

function gatherTargetCandidates(
  ego: EgoState,
  thought?: Thought,
  workspaceContext?: string,
): Array<{ raw: string; source: TargetCandidateSource }> {
  const candidates: Array<{ raw: string; source: TargetCandidateSource }> = [];

  const thoughtTexts = [
    thought?.content,
    thought?.triggerDetail,
    thought?.motivation,
    typeof thought?.actionParams?.reason === "string" ? thought.actionParams.reason : undefined,
  ].filter((v): v is string => Boolean(v));

  for (const text of thoughtTexts) {
    for (const raw of extractPathCandidates(text)) {
      candidates.push({ raw, source: "thought" });
    }
  }

  for (const message of [...(ego.recentUserMessages ?? [])].reverse()) {
    for (const raw of extractPathCandidates(message)) {
      candidates.push({ raw, source: "recentMessage" });
    }
  }

  for (const goal of ego.goals ?? []) {
    if (goal.status !== "active") continue;
    for (const raw of [...extractPathCandidates(goal.title), ...extractPathCandidates(goal.description ?? "")]) {
      candidates.push({ raw, source: "goal" });
    }
  }

  for (const fact of ego.userFacts ?? []) {
    for (const raw of extractPathCandidates(fact.content)) {
      candidates.push({ raw, source: "userFact" });
    }
  }

  if (workspaceContext) {
    for (const raw of extractPathCandidates(workspaceContext)) {
      candidates.push({ raw, source: "workspace" });
    }
  }

  return candidates;
}

function resolveTargetProject(
  ego: EgoState,
  thought?: Thought,
  workspaceContext?: string,
): { dir: string; name: string; isSelf: boolean } {
  const candidates = gatherTargetCandidates(ego, thought, workspaceContext);
  const tried: string[] = [];

  for (const candidate of candidates) {
    for (const dir of expandPathCandidate(candidate.raw)) {
      tried.push(dir);
      if (isUnsafeProjectRoot(dir)) {
        log.warn(`Ignoring unsafe target project root candidate: ${dir} (from ${candidate.raw})`);
        continue;
      }
      if (pathExists(dir)) {
        const name = candidate.source === "goal"
          ? `goal path: ${candidate.raw}`
          : candidate.source === "thought" || candidate.source === "recentMessage"
            ? `current directive: ${candidate.raw.slice(0, 60)}`
            : `${candidate.source} path: ${candidate.raw.slice(0, 60)}`;
        return { dir, name, isSelf: false };
      }
    }
  }

  if (candidates.length > 0) {
    log.warn(`Target project path not found or unsafe; tried: ${tried.join(", ")}. Falling back to Soul self-improvement.`);
  }

  return { dir: SOUL_SRC_DIR, name: "Soul plugin (self-improvement)", isSelf: true };
}

/** Get all source files in a directory (excluding protected files). */
function getSourceFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => SOURCE_EXTENSIONS.some((ext) => f.endsWith(ext)) && !PROTECTED_FILES.has(f))
      .sort();
  } catch {
    return [];
  }
}

export async function executeObserveAndImprove(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  if (!options.llmGenerator) {
    return { result: { type: "observe-and-improve", success: false, error: "No LLM generator" }, metricsChanged: [] };
  }
  const readOnlyMode = !options.autonomousActions;

  // Only 1 concurrent improvement task
  const activeImprove = (ego.activeTasks ?? []).filter(
    (t) => t.status === "in-progress" && t.title?.toLowerCase().includes("improvement"),
  ).length;
  if (activeImprove >= 1) {
    return { result: { type: "observe-and-improve", success: false, error: "Improvement task already running" }, metricsChanged: [] };
  }

  // Resolve target project from the current directive first, then recent user
  // messages/facts/goals. This keeps autonomous work project-agnostic.
  const target = resolveTargetProject(ego, thought, options.workspaceContext);
  const taskId = randomBytes(4).toString("hex");

  // Persist task as in-progress
  const task: AutonomousTask = {
    id: taskId,
    title: `${readOnlyMode ? "Read-only improvement" : "Improvement"}: ${target.name}`,
    description: `${readOnlyMode ? "Read-only code analysis" : "Code analysis and improvement"} for ${target.dir}`,
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    steps: [],
    requiresWritePermission: false,
    resultDelivered: false,
  };
  await persistTask(task);

  log.info(`Improvement task targeting: ${target.dir} (${target.name})`);
  if (readOnlyMode) {
    log.info("Improvement running in read-only mode because autonomousActions is false");
  }

  // --- Gather behavior stats (only relevant for self-improvement) ---
  const blog = ego.behaviorLog ?? [];
  const totalActions = blog.length;
  const expiredCount = blog.filter((b) => b.outcome === "expired").length;
  const successCount = blog.filter((b) => b.outcome === "success").length;
  const actionStatsText = target.isSelf
    ? `**Behavior stats** (last ${totalActions} actions): ${expiredCount} expired, ${successCount} success (${Math.round(expiredCount / Math.max(totalActions, 1) * 100)}% failure rate).`
    : "";

  // --- Read source files ---
  const allFiles = getSourceFiles(target.dir);
  const fileContents: string[] = [];
  for (const fname of allFiles) {
    const step = await readLocalFile("read-source", `${target.dir}/${fname}`);
    if (step.success && step.output) {
      fileContents.push(`=== ${fname} ===\n${step.output.slice(0, 4000)}`);
    }
  }

  log.info(`Improvement: read ${fileContents.length}/${allFiles.length} source files from ${target.dir}`);

  if (fileContents.length === 0) {
    await completeTask(taskId, `No source files found in ${target.dir}`);
    return { result: { type: "observe-and-improve", success: false, error: `No source files found in ${target.dir}` }, metricsChanged: [] };
  }

  // --- Recent analysis context ---
  const recentAnalyses = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && t.id !== taskId)
    .slice(-2)
    .map((t) => t.result)
    .join("\n\n");

  // --- User context ---
  const userContext = ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n");

  // --- LLM analysis ---
  const fileNames = allFiles.join(", ");
  const projectDesc = target.isSelf
    ? "This is the Soul plugin itself — an autonomous AI agent with ego, thoughts, and actions."
    : `This is project at ${target.dir}.`;
  const analysisPrompt = `You are a developer analyzing source code to find and fix real problems.
${projectDesc}

${actionStatsText}

**User context**:
${userContext || "Limited user info."}

**Previous findings**:
${recentAnalyses || "None."}

**Available source files**: ${fileNames}

**Source code**:
${fileContents.join("\n\n")}

Based on the code and context above, identify ONE concrete, small improvement. Output EXACTLY this JSON (no markdown, raw JSON only):
\x7B"problem":"one sentence describing the problem","file":"filename","oldCode":"exact code to replace","newCode":"replacement code","explanation":"why this fix helps"\x7D

Rules:
- oldCode must be VERBATIM from the source above — copy it exactly character for character
- Keep changes to 1-5 lines max
- Only fix real bugs, logic errors, or clear inefficiencies
- Prefer fixing high-impact issues
- ${readOnlyMode ? "Read-only mode is active: still propose oldCode/newCode, but the system will not apply changes automatically" : "Autonomous write mode is active: propose a fix that can be applied automatically"}
- If nothing clearly needs fixing, set oldCode and newCode to empty strings`;

  let analysisResult: string;
  let fixApplied = false;
  let fixDescription = "";
  let verificationSummary = "";
  let analysisCompleted = false;
  let analysisFailure = "";

  try {
    const llmResponse = await options.llmGenerator(analysisPrompt);
    analysisResult = llmResponse;
    analysisCompleted = true;

    const parsed = parseImprovementProposal(llmResponse);
    if (parsed.proposal) {
      try {
        const { file: fixFile, oldCode, newCode, problem, explanation } = parsed.proposal;

        if (!oldCode && !newCode) {
          fixDescription = explanation || problem || "No concrete fix identified after analysis";
        } else if (!allFiles.includes(fixFile)) {
          fixDescription = `Fix not applied: ${fixFile} is not in available source files`;
          log.info(`Ignored ungrounded improvement recommendation for ${fixFile}`);
        } else if (readOnlyMode) {
          fixDescription = `Read-only recommendation for ${fixFile}: ${explanation || problem}`;
        } else if (PROTECTED_FILES.has(fixFile)) {
          fixDescription = `Fix not applied: ${fixFile} is a protected file`;
        } else {
          const fullPath = `${target.dir}/${fixFile}`;
          const content = await readFile(fullPath, "utf-8");

          if (content.includes(oldCode)) {
            const newContent = content.replace(oldCode, newCode);
            writeFileSync(fullPath, newContent, "utf-8");

            const verification = verifyAppliedFix(target.dir, fixFile);
            verificationSummary = verification.summary;
            if (verification.ok) {
              fixApplied = true;
              fixDescription = `Fixed ${fixFile}: ${explanation || problem}`;
              log.info(`Applied and verified improvement fix to ${target.dir}/${fixFile}: ${problem}`);
            } else {
              writeFileSync(fullPath, content, "utf-8");
              analysisFailure = `Verification failed after editing ${fixFile}; change was reverted.`;
              fixDescription = `${analysisFailure} ${verification.summary}`;
              log.warn(`Reverted autonomous improvement in ${target.dir}/${fixFile}: ${verification.summary.slice(0, 300)}`);
            }
          } else {
            fixDescription = `Fix not applied: oldCode not found verbatim in ${fixFile}`;
          }
        }
      } catch (parseErr) {
        fixDescription = `Fix parse failed: ${String(parseErr)}`;
      }
    } else {
      analysisFailure = parsed.error ?? "Unable to parse improvement proposal";
      fixDescription = analysisFailure;
    }
  } catch (err) {
    if (isProviderPressureErrorText(err)) {
      const skipReason = `skipped-provider-pressure: ${String(err)}`;
      await completeTask(taskId, skipReason, "completed", true);
      log.info(`Improvement skipped because LLM provider is under pressure: ${String(err)}`);
      return {
        result: {
          type: "observe-and-improve",
          success: true,
          result: skipReason.slice(0, 500),
          data: { readOnly: readOnlyMode, fixApplied: false, analysisCompleted: false, skipped: true },
        },
        metricsChanged: [],
      };
    }

    analysisResult = `LLM analysis failed: ${String(err)}`;
    analysisFailure = analysisResult;
    log.warn(`Improvement LLM call failed: ${String(err)}`);
  }

  log.info(`Improvement analysis done: fixApplied=${fixApplied}, ${fixDescription || "no fix"}`);

  const result = fixApplied
    ? `${fixDescription}\n\nVerification:\n${verificationSummary || "verification passed"}`
    : `Analysis of ${target.dir}. ${fixDescription || "No concrete fix identified."} ${analysisResult.slice(0, 300)}`;
  const taskStatus: "completed" | "failed" =
    fixApplied || (analysisCompleted && !analysisFailure)
      ? "completed"
      : "failed";

  await completeTask(taskId, result, taskStatus);

  return {
    result: {
      type: "observe-and-improve",
      success: taskStatus === "completed",
      result: result.slice(0, 500),
      data: { readOnly: readOnlyMode, fixApplied, analysisCompleted },
    },
    metricsChanged: taskStatus === "completed"
      ? [
          { need: "growth", delta: fixApplied ? 20 : 10, reason: fixApplied ? "applied improvement fix" : "code analysis" },
          { need: "meaning", delta: fixApplied ? 15 : 8, reason: readOnlyMode ? "observing self-improvement opportunities" : "working on user's assigned goal" },
        ]
      : [],
  };
}

async function completeTask(
  taskId: string,
  result: string,
  status: "completed" | "failed" = "completed",
  resultDelivered = false,
): Promise<void> {
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      const finalResult = isFinalTaskReport(result)
        ? result
        : `Status: ${status}
Task: ${taskId}
Finished: ${new Date().toISOString()}

## Outcome
${result}

## Changes
See outcome. If no file was changed, the task produced an analysis or recommendation only.

## Verification
The local observe-and-improve path completed its bounded analysis. No separate verification command was recorded by this helper.

## Metrics
No before/after benchmark metrics were recorded.

## Next
Run a focused verification command or a smaller follow-up improvement if the result needs implementation confirmation.`;
      t.status = reportStatusToTaskStatus(finalResult);
      t.result = finalResult;
      t.completedAt = Date.now();
      t.updatedAt = Date.now();
      t.resultDelivered = resultDelivered;
    }
    return e;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkippedStep(action: string, reason: string): TaskStep {
  return {
    id: randomBytes(4).toString("hex"),
    timestamp: Date.now(),
    action,
    input: reason,
    success: false,
  };
}

/**
 * Extract meaningful keywords from text for similarity comparison.
 * Filters out common stop words and short tokens.
 */
/**
 * Try to extract the sub-agent's final report from recent session files.
 * This is a fallback when the agent doesn't write the result file. It returns
 * partial/failed status explicitly when the session timed out or only produced
 * interim narration.
 * Looks for sessions created after `sinceMs` that contain "Soul-Autonomous".
 */
function extractResultFromSessions(task: AutonomousTask, sinceMs: number): { status: "completed" | "failed"; result: string } | null {
  const sessionsDir = join(homedir(), ".openclaw/agents/main/sessions");
  try {
    const markers = [task.resultFilePath, task.id, `${task.id}.md`].filter((value): value is string => Boolean(value));
    const files = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, fp: join(sessionsDir, name), mtimeMs: statSync(join(sessionsDir, name)).mtimeMs }))
      .filter((file) => file.mtimeMs >= sinceMs - 60_000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const name of files) {
      const content = readFileSync(name.fp, "utf-8");
      if (!content.includes("Soul-Autonomous")) continue;
      if (markers.length > 0 && !markers.some((marker) => content.includes(marker))) continue;
      let lastAssistantText = "";
      let promptError = "";
      let toolFailure = "";
      for (const line of content.split("\n")) {
        try {
          const obj = JSON.parse(line.trim());
          if (obj.type === "custom" && obj.customType === "openclaw:prompt-error") {
            promptError = String(obj.data?.error ?? "prompt error");
          }
          if (obj.type === "message" && obj.message?.role === "assistant") {
            const mc = obj.message.content;
            if (Array.isArray(mc)) {
              for (const c of mc) {
                if (c.type === "text" && c.text && c.text.trim().length > 20) {
                  lastAssistantText = c.text.trim();
                }
              }
            }
          }
          if (obj.type === "message" && obj.message?.role === "toolResult") {
            const text = JSON.stringify(obj.message.content ?? "");
            if (/ParserError|Command exited with code [1-9]|EnvironmentLocationNotFound|timed out|timeout|error/i.test(text)) {
              toolFailure = text.slice(0, 600);
            }
          }
        } catch { /* skip malformed lines */ }
      }
      if (promptError) {
        const detail = [
          `Agent session ${name.name} failed before writing the required result file.`,
          `Error: ${promptError}`,
          toolFailure ? `Last tool failure: ${toolFailure}` : "",
          lastAssistantText ? `Last assistant text: ${lastAssistantText.slice(0, 600)}` : "",
        ].filter(Boolean).join("\n");
        return { status: "failed", result: buildFailureTaskReport(task, detail) };
      }
      if (lastAssistantText) {
        if (isCompleteTaskReport(lastAssistantText) && (!task.resultFilePath || hasFinalTaskResultFile(task))) {
          return { status: "completed", result: lastAssistantText.slice(0, 1000) };
        }
        const detail = `Agent session ${name.name} stopped before producing a final result file${task.resultFilePath ? ` (${task.resultFilePath})` : ""}. Last partial output: ${lastAssistantText.slice(0, 1200)}`;
        const hasUsefulPartial = /done|both configs|fail|passes|improved|worse|bug|root cause|clear|metric|CAGR|drawdown|B&H|baseline|\+|-|%|result/i.test(lastAssistantText);
        return {
          status: "failed",
          result: hasUsefulPartial ? buildPartialTaskReport(task, detail) : buildFailureTaskReport(task, detail),
        };
      }
    }
  } catch { /* sessions dir not accessible */ }
  return null;
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "nor",
    "not", "only", "own", "same", "so", "than", "too", "very", "just",
    "because", "but", "and", "or", "if", "while", "that", "this", "it",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "they",
    "its", "what", "which", "who", "whom", "these", "those",
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
    "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会",
    "着", "没有", "看", "好", "自己", "这",
  ]);
  return text.toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 50);
}

/**
 * Read a local file directly via Node.js fs.
 * Used instead of gateway /tools/invoke because the gateway's tool policy
 * pipeline does not expose "read"/"exec" to HTTP callers.
 * Returns a TaskStep with the file content (last 8000 chars for large files).
 */
async function readLocalFile(actionName: string, filePath: string): Promise<TaskStep> {
  const id = randomBytes(4).toString("hex");
  const start = Date.now();
  try {
    const buf = await readFile(filePath, "utf-8");
    // Keep last 8000 chars to avoid blowing up LLM context
    const content = buf.length > 8000 ? buf.slice(-8000) : buf;
    return {
      id,
      timestamp: Date.now(),
      action: actionName,
      input: filePath,
      output: content,
      success: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`File read failed: ${filePath} → ${msg}`);
    return {
      id,
      timestamp: Date.now(),
      action: actionName,
      input: filePath,
      output: undefined,
      success: false,
      duration: Date.now() - start,
    };
  }
}

async function runToolStep(
  actionName: string,
  tool: string,
  args: Record<string, unknown>,
  options: AutonomousActionOptions,
): Promise<TaskStep> {
  const start = Date.now();
  const result = await invokeGatewayTool({
    tool,
    args,
    gatewayPort: options.gatewayPort,
    authToken: options.authToken,
    timeoutMs: 60_000,
  });
  return {
    id: randomBytes(4).toString("hex"),
    timestamp: Date.now(),
    action: actionName,
    input: JSON.stringify(args).slice(0, 200),
    output: result.result,
    success: result.ok,
    duration: Date.now() - start,
  };
}

async function persistTask(task: AutonomousTask): Promise<void> {
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    if (!e.activeTasks) e.activeTasks = [];
    e.activeTasks.push(task);
    return e;
  });
}

/**
 * Poll active tasks: check result files, mark stale ones as completed.
 * Returns list of newly completed tasks (with results from file capture).
 */
export async function pollActiveTasks(storePath: string): Promise<AutonomousTask[]> {
  const STALE_MS = 8 * 60 * 1000; // hooks/agent times out at 5 minutes; leave a small settle window
  const MAX_TASKS = 20;
  const newlyCompleted: AutonomousTask[] = [];

  await updateEgoStore(storePath, (e) => {
    if (!e.activeTasks) { e.activeTasks = []; return e; }

    for (const task of e.activeTasks) {
      if (task.status !== "in-progress") continue;

      // Check result file first
      if (task.resultFilePath && !task.result) {
        try {
          const content = readFileSync(task.resultFilePath, "utf-8").trim();
          if (content && isFinalTaskReport(content)) {
            task.result = content;
            task.status = reportStatusToTaskStatus(content);
            task.completedAt = Date.now();
            task.updatedAt = Date.now();
            newlyCompleted.push({ ...task });
            continue;
          }
        } catch { /* file not ready yet */ }
      }

      // Fallback: try to extract result from session files
      if (!task.result && task.requiresWritePermission) {
        const sessionResult = extractResultFromSessions(task, task.createdAt);
        if (sessionResult) {
          task.result = sessionResult.result;
          task.status = sessionResult.status;
          writeTaskReportFile(task.resultFilePath, task.result);
          task.completedAt = Date.now();
          task.updatedAt = Date.now();
          newlyCompleted.push({ ...task });
          continue;
        }
      }

      // Final fallback: stale timeout
      if (Date.now() - task.updatedAt > STALE_MS) {
        const detail = task.result ?? `Task timed out (stale >8 min). Required final result file was not produced${task.resultFilePath ? `: ${task.resultFilePath}` : ""}.`;
        task.status = "failed";
        task.result = buildFailureTaskReport(task, detail);
        writeTaskReportFile(task.resultFilePath, task.result);
        task.completedAt = Date.now();
        task.updatedAt = Date.now();
        newlyCompleted.push({ ...task });
      }
    }

    // Prune old completed tasks (keep last MAX_TASKS)
    if (e.activeTasks.length > MAX_TASKS) {
      e.activeTasks = e.activeTasks
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_TASKS);
    }

    return e;
  });

  if (newlyCompleted.length > 0) {
    log.info(`Tasks finished: ${newlyCompleted.map((t) => `${t.id}(${t.status}${t.result ? ",has-result" : ",no-result"})`).join(", ")}`);
  }
  return newlyCompleted;
}
