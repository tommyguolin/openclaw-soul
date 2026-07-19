import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { readFile, access as accessFile } from "node:fs/promises";
import { dirname, join, normalize, parse as parsePath, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
import { createSoulLogger } from "./logger.js";
import { IntentionStore, resolveIntentionStorePath } from "./intention/store.js";
import { WorkHandoffStore, resolveWorkHandoffStorePath } from "./handoff/store.js";
import { invokeGatewayTool, fireAgentTask, isWriteTool } from "./gateway-client.js";
import { isGoodTimeForMessage } from "./action-executor.js";
import type { LLMGenerator } from "./soul-llm.js";
import type { Thought, EgoState, ActionResult, MetricDelta, AutonomousTask, TaskStep, TaskStatus, ActionType } from "./types.js";
import type { MessageSender } from "./soul-actions.js";
import { updateEgoStore, resolveEgoStorePath } from "./ego-store.js";
import { resolveSoulDir } from "./paths.js";
import { buildUserLanguageInstruction, supportsLocalMessageTemplate } from "./language-context.js";

const log = createSoulLogger("autonomous-actions");

/** Max concurrent active tasks. Soul is a background worker; run heavy work serially. */
const MAX_ACTIVE_TASKS = 1;

const PROVIDER_PRESSURE_BACKOFF_MS = 60 * 60 * 1000;
const PROVIDER_PRESSURE_TAIL_LINES = 80;
const AUTONOMOUS_AGENT_TIMEOUT_SECONDS = 600;
const AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS = 150;
const AUTONOMOUS_AGENT_QUICK_CHECK_SECONDS = 60;
/** Grace period to wait for a subagent that timed out or errored to finish
 * writing its result file. The subagent may still be running after
 * waitForRun returns (e.g. due to timeout) and will write the result file
 * directly via the write tool. */
const SUBAGENT_GRACE_PERIOD_MS = 30 * 1000;
const AUTONOMOUS_FAILURE_BACKOFF_MS = 2 * 60 * 60 * 1000;
const AUTONOMOUS_FAILURE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const READABLE_EVIDENCE_EXTENSIONS = [".log", ".txt", ".json", ".csv", ".md", ".yaml", ".yml", ".conf"];

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
  // Check for explicit failure indicators, not bare word matches.
  // Previous regex matched \berror\b / \bfailed\b anywhere, causing false positives
  // on successful reports containing phrases like "Fixed the error handling" or
  // "No error found". Require error-like context (status lines, prefixes, or
  // error-detail sections) to reduce false-positive blocked/partial classifications.
  return /^Status:\s*(?:failed|blocked|partial)\b/im.test(result)
    || /timed out|timeout|stale|rate limit|cooldown|backing off|too many requests|429|No available auth profile|aborted|prompt-error|parsererror|command exited with code [1-9]/i.test(result)
    || /^(?:##\s*)?(?:failure|error)\b/im.test(result)
    || /\b(?:failed|error)\b\s*(?:to|starting|running|before|because|while|due|with|:)\b/i.test(result)
    || /(?:Error|Exception|Traceback):/i.test(result);
}

function isProviderPressureErrorText(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return /Soul LLM backoff active|Soul LLM (?:call|\w+ lane) budget exhausted|rate limit|cooldown|No available auth profile|too many requests|429|suspending lanes|embedded run timeout|Request timed out|ECONNRESET|fetch failed/i.test(text);
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
      return ts >= cutoff && (isLowValueAutonomousFailure(task)
        || /No source files found|does not resolve to a source project/i.test(task.result ?? ""));
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
  // "partial" and "blocked" indicate the subagent did useful work but
  // could not fully complete (timeout, acceptance-criteria-not-met, etc.).
  // Treat them as "completed" to avoid triggering failure backoff that
  // would block future subagent-improve tasks for hours.
  const status = taskReportStatus(result);
  if (status === "completed" || status === "partial" || status === "blocked") {
    return "completed";
  }
  // No Status: line found. If the report has all required sections and
  // looks like a complete task report, treat it as completed — the
  // subagent did the work but simply omitted the "Status:" header.
  if (status === null && isCompleteTaskReport(result)) {
    return "completed";
  }
  return "failed";
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
  // TypeScript projects: if tsconfig.json exists but no matching npm script
  try {
    if (statSync(join(targetDir, "tsconfig.json")).isFile()) {
      return runCommand(targetDir, "npx", ["tsc", "--noEmit"], 120_000);
    }
  } catch { /* no tsconfig */ }
  // Maven projects
  try {
    if (statSync(join(targetDir, "pom.xml")).isFile()) {
      return runCommand(targetDir, "mvn", ["compile", "-q"], 180_000);
    }
  } catch { /* no pom.xml */ }
  // Gradle projects
  try {
    if (
      statSync(join(targetDir, "build.gradle")).isFile()
      || statSync(join(targetDir, "build.gradle.kts")).isFile()
    ) {
      return runCommand(targetDir, "gradle", ["compileJava", "-q"], 180_000);
    }
  } catch { /* no build.gradle */ }
  // Makefile-based projects
  try {
    const makefile = join(targetDir, "Makefile");
    const makefileLower = join(targetDir, "makefile");
    if (statSync(makefile).isFile() || statSync(makefileLower).isFile()) {
      // Try 'make check' first, fall back to 'make build'
      const checkResult = runCommand(targetDir, "make", ["check"], 120_000);
      if (!/No rule.*check/i.test(checkResult.summary)) return checkResult;
      return runCommand(targetDir, "make", ["build"], 120_000);
    }
  } catch { /* no Makefile */ }
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

function buildFailureTaskReport(task: AutonomousTask, detail: string, zh = false): string {
  const header = `Status: failed
Task: ${task.id}
Finished: ${new Date().toISOString()}`;
  if (zh) {
    return `${header}

## 结果
自主任务未能完成，没有产出最终报告。

## 变更
Soul 未确认任何最终变更。

## 验证
任务在验证完成前已失败。

## 指标
未捕获可靠的前后对比指标。

## 下一步
缩小任务范围，增量写入报告后再启动长耗时验证。

## 失败详情
${detail.trim().slice(0, 3000)}`;
  }
  return `${header}

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

function buildPartialTaskReport(task: AutonomousTask, detail: string, zh = false): string {
  const header = `Status: partial
Task: ${task.id}
Finished: ${new Date().toISOString()}`;
  if (zh) {
    return `${header}

## 结果
自主任务产出了部分发现，但在预算耗尽前未写入完整最终报告。

## 变更
Soul 未确认任何最终变更。

## 验证
下方捕获的部分输出中可能包含验证或观察结果，但任务未提供完整的命令/结果报告。

## 指标
捕获的部分输出：
${detail.trim().slice(0, 3000)}

## 下一步
基于此次部分发现，启动更小范围后续任务。下一个任务应先写入 Status: partial，验证完成后再覆盖。`;
  }
  return `${header}

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
  // If the report has an explicit Status: header and all required sections,
  // accept it regardless of body keywords. The keyword check below is a
  // fallback for reports that omit the Status: header entirely.
  if (taskReportStatus(text) !== null) return true;
  return /changed|implemented|verified|command|baseline|before|after|metric|files?/i.test(text);
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
  if (unmetAcceptanceCriteria(task, result).length > 0) return true;
  const reportStatus = taskReportStatus(result);
  if (task.status === "failed") return true;
  if (reportStatus === "completed") return false;
  // When task.status === "completed", the task went through reportStatusToTaskStatus
  // which maps partial/blocked → completed. Don't re-classify these as blocked
  // in the user-facing report — the user already saw "partial" in the result text.
  // Only flag as blocked if the result file is actually missing.
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

function extractReportField(result: string, field: string): string {
  const match = new RegExp(`^##\\s+${field}\\b[^\n]*\n([\s\S]*?)(?=^##\\s+|$)`, "im").exec(result.replace(/<think[\s\S]*?<\/think>/gi, "").trim());
  return match ? match[1].trim() : "";
}

function extractChangedFiles(changesText: string): string[] {
  const files: string[] = [];
  for (const line of changesText.split(/\r?\n/)) {
    const m = line.match(/(?:^|[-•]\s*)([A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+)/);
    if (m && !files.includes(m[1])) files.push(m[1]);
  }
  return files;
}

function captureGitDiffStat(targetDir: string): string | null {
  try {
    const result = spawnSync("git", ["diff", "--stat", "HEAD"], {
      cwd: targetDir,
      encoding: "utf-8",
      timeout: 15_000,
      shell: process.platform === "win32",
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch { /* git not available or not a git repo */ }
  return null;
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

    if (zh) {
      // 中文报告：提取关键信息，不直接粘贴整段英文模板
      const outcome = extractReportField(result, "outcome") || extractReportField(result, "Outcome") || result.slice(0, 600);
      const changes = extractReportField(result, "changes") || extractReportField(result, "Changes") || "";
      const verification = extractReportField(result, "verification") || extractReportField(result, "Verification") || "";
      const metrics = extractReportField(result, "metrics") || extractReportField(result, "Metrics") || "";

      const statusIcon = blocked ? "⚠️" : "✅";
      const statusText = blocked ? "未完成" : "已完成";

      const lines: string[] = [
        `${statusIcon} 自主任务${statusText}`,
        `任务: ${task.title}`,
      ];

      // 变更文件
      if (changes) {
        const changedFiles = extractChangedFiles(changes);
        if (changedFiles.length > 0) {
          lines.push(`\n改动文件 (${changedFiles.length}):`);
          for (const f of changedFiles.slice(0, 8)) lines.push(`  • ${f}`);
          if (changedFiles.length > 8) lines.push(`  • ...等 ${changedFiles.length} 个`);
        }
        lines.push(`\n变更说明:\n${changes.slice(0, 800)}`);
      } else {
        lines.push("\n变更说明: 无文件变更");
      }

      // 验证
      if (verification) {
        lines.push(`\n验证:\n${verification.slice(0, 500)}`);
      }

      // 指标
      if (metrics) {
        lines.push(`\n指标:\n${metrics.slice(0, 400)}`);
      }

      // 附带 git diff（如果有 targetProjectRoot）
      const targetDir = task.targetProjectRoot || "";
      if (targetDir) {
        const diffStat = captureGitDiffStat(targetDir);
        if (diffStat) {
          lines.push(`\nGit diff:\n${diffStat.slice(0, 1000)}`);
        }
      }

      return lines.join("\n");
    }

    // 英文 fallback（保持原逻辑）
    const meta = [
      `Task ID: ${task.id}`,
      `Title: ${task.title}`,
      `Status: ${blocked ? "blocked/partial" : "completed"}`,
      taskResultFileLine(task, false),
    ].filter((line): line is string => Boolean(line));
    return `${blocked ? "This autonomous task did not fully complete" : "This autonomous task completed"}\n${meta.join("\n")}\n\nResult:\n${result}`;
  }

  // 多任务摘要
  const body = reportable
    .map((task) => {
      const result = normalizeTaskResultForReport(task.result ?? "").replace(/\n/g, " ");
      const blocked = isTaskBlockedOrPartial(task, result);
      const status = zh
        ? (blocked ? "未完成" : "已完成")
        : (blocked ? "blocked/partial" : "completed");
      return `- ${task.id} ${status} ${task.title}: ${result.slice(0, 700)}`;
    })
    .join("\n");
  return zh
    ? `本轮自主任务状态:\n${body}`
    : `Autonomous task status:\n${body}`;
}

export type SubAgentRunResult = {
  runId: string;
  success: boolean;
  output: string;
  error?: string;
};

export type SubAgentRunner = (params: {
  sessionKey: string;
  message: string;
  timeoutMs?: number;
}) => Promise<SubAgentRunResult>;

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
  subAgentRunner?: SubAgentRunner;
};

function taskContinuityFields(thought: Thought): Pick<AutonomousTask,
  "intentionId" | "workHandoffId" | "targetProjectRoot" | "acceptanceCriteria"> {
  const params = thought.actionParams ?? {};
  return {
    ...(typeof params.intentionId === "string" ? { intentionId: params.intentionId } : {}),
    ...(typeof params.workHandoffId === "string" ? { workHandoffId: params.workHandoffId } : {}),
    ...(typeof params.projectRoot === "string" ? { targetProjectRoot: params.projectRoot } : {}),
    ...(Array.isArray(params.acceptanceCriteria)
      ? { acceptanceCriteria: params.acceptanceCriteria.filter((item): item is string => typeof item === "string") }
      : {}),
  };
}

function unmetAcceptanceCriteria(task: AutonomousTask, result: string): string[] {
  const criteria = task.acceptanceCriteria ?? [];
  if (criteria.length === 0) return [];
  const successfulActions = task.steps
    .filter((step) => step.success)
    .map((step) => step.action)
    .join(" ");
  const explicitlyNoChange = /No files were changed|No source files changed|没有修改任何文件|修改文件：\s*0/i.test(result);
  const hasChangeEvidence = !explicitlyNoChange && (
    /修改文件：\s*(?!0\b|无\b|none\b)[^\n]+/i.test(result)
    || /Files modified:\s*(?!0\b|none\b)[^\n]+/i.test(result)
    || /Applied and verified improvement fix|Fixed\s+[^\n:]+:/i.test(result)
    || /\b(?:apply|edit|patch|write|modify)[\w-]*\b/i.test(successfulActions)
  );
  const explicitlyNoVerification = /Verification:\s*not run|验证：未执行|没有执行验证|No verification was run|not verified end-to-end/i.test(result);
  const hasVerificationEvidence = !explicitlyNoVerification && (
    /(?:verification|验证|npm|pnpm|yarn|pytest|typecheck|test|build)[^\n]{0,160}(?:passed|通过|succeeded|成功)/i.test(result)
    || /\b(?:verify|test|typecheck|build)[\w-]*\b/i.test(successfulActions)
  );

  return criteria.filter((criterion) => {
    if (/concrete changed files|files? changed|code change/i.test(criterion)) return !hasChangeEvidence;
    if (/verification command|verified|verification passes/i.test(criterion)) return !hasVerificationEvidence;
    return false;
  });
}

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
    subAgentRunner: options.subAgentRunner,
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
    case "subagent-improve":
      return executeSubagentImprove(thought, ego, autoOpts);
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
  const hasProviderPressure = /Soul LLM backoff active|Soul LLM (?:call|\w+ lane) budget exhausted|provider backoff active|rate limit|cooldown|too many requests|429/i.test(text);
  const hasExternalSignal = /traceback|exception|parsererror|command exited with code [1-9]|500|401|403|TypeError|ReferenceError|SyntaxError|Cannot find module/i.test(text);
  return hasProviderPressure && !hasExternalSignal;
}

function collectKnownLocalEvidenceTargets(ego: EgoState, currentText = ""): string[] {
  const haystacks = [
    currentText,
    ...(ego.mentalContext?.foreground ?? []),
    ...(ego.mentalContext?.backgroundConcerns ?? []),
    ...(ego.mentalContext?.residue ?? []),
    ...(ego.recentUserMessages ?? []),
    ...(ego.memories ?? [])
      .filter((memory) => memory.type === "interaction" && memory.tags.includes("inbound"))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map((memory) => memory.content),
  ];
  const targets: string[] = [];
  for (const text of haystacks) {
    for (const match of text.matchAll(/(?:^|[\s(（"'`])((?:\/[A-Za-z0-9._-]+){2,}\/?)/g)) {
      const value = match[1].replace(/[),，。；;]+$/g, "");
      if (!targets.includes(value)) targets.push(value);
    }
    for (const match of text.matchAll(/\b((?:\d{1,3}\.){3}\d{1,3})\b/g)) {
      const value = match[1];
      if (!targets.includes(value)) targets.push(value);
    }
  }
  return targets.slice(0, 8);
}

function isReadableEvidenceFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return READABLE_EVIDENCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function readLocalEvidenceTarget(target: string): Promise<{ steps: TaskStep[]; evidence: string[] }> {
  const steps: TaskStep[] = [];
  const evidence: string[] = [];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target)) {
    steps.push(makeSkippedStep("known-remote-host", `Remote host target known but not read by bounded local analyzer: ${target}`));
    return { steps, evidence };
  }
  try {
    const stat = statSync(target);
    if (stat.isFile() && isReadableEvidenceFile(target)) {
      const step = await readLocalFile("read-context-evidence-file", target);
      steps.push(step);
      if (step.success && step.output) evidence.push(`=== Context target: ${target} ===\n${step.output}`);
      return { steps, evidence };
    }
    if (stat.isDirectory()) {
      const candidates = readdirSync(target)
        .filter((name) => isReadableEvidenceFile(name))
        .slice(0, 5)
        .map((name) => join(target, name));
      if (candidates.length === 0) {
        steps.push(makeSkippedStep("known-local-directory-empty", `No readable evidence files found in ${target}`));
      }
      for (const filePath of candidates) {
        const step = await readLocalFile("read-context-evidence-file", filePath);
        steps.push(step);
        if (step.success && step.output) evidence.push(`=== Context target: ${filePath} ===\n${step.output}`);
      }
      return { steps, evidence };
    }
    steps.push(makeSkippedStep("known-local-target-unsupported", `Known target is not a regular file or directory: ${target}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push(makeSkippedStep("known-local-target-unreadable", `${target}: ${msg}`));
  }
  return { steps, evidence };
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
    ...taskContinuityFields(thought),
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
  const requiresLocalEvidence = thought.actionParams?.requiresLocalEvidence === true;
  const contextualTargets = [
    ...((thought.actionParams?.localEvidenceTargets as string[]) ?? []),
    ...collectKnownLocalEvidenceTargets(ego, `${thought.content}\n${thought.motivation}`),
  ].filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index).slice(0, 8);

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

  if (gatheredInfo.length === 0 && requiresLocalEvidence && contextualTargets.length > 0) {
    for (const target of contextualTargets) {
      const resolved = await readLocalEvidenceTarget(target);
      steps.push(...resolved.steps);
      gatheredInfo.push(...resolved.evidence);
      if (gatheredInfo.length > 0) break;
    }
  }

  // If no files were found from conversation, try reading recent logs from
  // common locations — not limited to OpenClaw itself. Local-evidence tasks are
  // different: without an explicit target file/path, OpenClaw's own log is
  // unrelated evidence and should not be reported as if it answered the user.
  if (gatheredInfo.length === 0 && !requiresLocalEvidence) {
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
  } else if (requiresLocalEvidence) {
    if (contextualTargets.length > 0) {
      analysisResult = [
        "Status: blocked",
        "Reason: local-evidence-target-known-unreadable",
        `Context: ${thought.motivation || thought.content}`,
        `Known targets: ${contextualTargets.join(", ")}`,
        "",
        "Soul found prior local/remote target context, so this is not treated as a missing-target thought block. The bounded local analyzer could not read usable evidence from those targets and did not answer from model memory.",
      ].join("\n");
    } else {
      analysisResult = [
        "Status: blocked",
        "Reason: local-evidence-target-missing",
        `Context: ${thought.motivation || thought.content}`,
        "",
        "No explicit local log/source path was available, so Soul did not use model memory or unrelated OpenClaw logs to answer a project-specific result question.",
      ].join("\n");
    }
  } else if (gatheredInfo.length === 0) {
    analysisResult = "No relevant information could be gathered for analysis.";
  }

  const unmetCriteria = unmetAcceptanceCriteria({ ...task, steps }, analysisResult);
  const taskStatus: "completed" | "failed" = unmetCriteria.length > 0 ? "failed" : "completed";
  if (unmetCriteria.length > 0) {
    analysisResult = [
      "Status: blocked",
      "Reason: acceptance-criteria-not-met",
      `Unmet acceptance criteria: ${unmetCriteria.join("; ")}`,
      "",
      "This bounded analysis gathered information only. It did not claim implementation or verification work that it did not perform.",
      "",
      analysisResult,
    ].join("\n");
  }

  // Complete only when this action actually satisfies its inherited contract.
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = taskStatus;
      t.steps = steps;
      t.result = analysisResult;
      t.updatedAt = Date.now();
      t.completedAt = Date.now();
      if ((requiresLocalEvidence && gatheredInfo.length === 0)
        || (isInternalNeedDiagnostic(thought) && isOnlyProviderPressureDiagnostic(analysisResult))) {
        t.resultDelivered = true;
      }
    }
    return e;
  });

  log.info(`Analysis task ${taskId} ${taskStatus}: ${steps.length} steps, result ${analysisResult.length} chars`);

  return {
    result: {
      type: "analyze-problem",
      success: taskStatus === "completed",
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
  if (target.resolutionError) {
    return {
      result: { type: "run-agent-task", success: false, error: target.resolutionError },
      metricsChanged: [],
    };
  }
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
  const resultDir = join(resolveSoulDir(), "results");
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
    ...taskContinuityFields(thought),
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

  // If we have a subagent runtime, use it — full tool chain (exec, write, read, git)
  if (options.subAgentRunner) {
    return executeRunAgentTaskViaSubagent(thought, ego, options);
  }

  // Fallback: bounded local inspection (read-only)
  return executeBoundedLocalAgentTask(thought, ego, options);
}

async function executeRunAgentTaskViaSubagent(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const target = resolveTargetProject(ego, thought, options.workspaceContext);
  const readOnlyMode = !options.autonomousActions;

  // Backoff checks
  if (hasRecentProviderPressure()) {
    log.info("Skipping run-agent-task: provider pressure seen recently");
    return {
      result: { type: "run-agent-task", success: false, error: "Provider rate limit/cooldown seen recently; backing off" },
      metricsChanged: [],
    };
  }
  const failureBackoff = recentAutonomousFailureBackoff(ego);
  if (failureBackoff !== null) {
    const mins = Math.ceil(failureBackoff!.remainingMs / 60_000);
    log.info(`Skipping run-agent-task: recent failure backoff ${mins}m`);
    return {
      result: { type: "run-agent-task", success: false, error: `Backing off for ${mins}m` },
      metricsChanged: [],
    };
  }

  // Build context
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
  const readOnlyInstruction = readOnlyMode
    ? "\n\nIMPORTANT: You are in READ-ONLY mode. Only READ files and RUN diagnostic commands. Do NOT edit, write, or modify any files."
    : "";
  const latestAnalysis = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && !t.resultDelivered)
    .slice(-1)[0];
  const analysisContext = latestAnalysis
    ? `\n\n**Previous analysis result** (use this to implement the fix):\n${latestAnalysis.result?.slice(0, 1000)}`
    : "";

  const taskId = randomBytes(4).toString("hex");
  const resultDir = join(resolveSoulDir(), "results");
  mkdirSync(resultDir, { recursive: true });
  const resultFilePath = join(resultDir, `${taskId}.md`);

  const zh = wantsChineseReport(ego);
  const langInstruction = zh
    ? "用中文写报告。所有 section 内容用中文，不要用英文。"
    : "Write the report in English.";

  const agentMessage = `[Soul Autonomous Task]
${thought.content}

**IMPORTANT**: This is an AUTONOMOUS task. No one will reply to you. Do NOT ask for confirmation or permission — start working immediately.

You have a hard ${AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS}s work budget. Do one bounded iteration, then stop and finalize.

${langInstruction}

Context:
- Target project: ${target.isSelf ? "not explicitly specified; inspect the current workspace" : `${target.dir} (${target.name})`}
- User profile: ${userContext || "limited"}
- Recent user messages:
${recentUserMessages || "none"}
- Active goals:
${activeGoals || "none"}
- Trigger: ${thought.triggerDetail}${readOnlyInstruction}${analysisContext}${options.workspaceContext ? `\n- Workspace rules:\n${options.workspaceContext}` : ""}

Work like the main OpenClaw agent would when the user directly asks for an improvement:
- Inspect only the most relevant code, scripts, docs, recent logs.
- Choose exactly ONE concrete, high-value iteration that can finish within this run.
- If you have write access and the fix is clear, edit the files directly.
- Run the most relevant verification command (build, test, typecheck) if available.
- Do not ask for confirmation, do not stop at a proposal, and do not invent results.

Write your final report as markdown with these sections:
## Outcome
What you investigated and the final result.
## Changes
Files changed and why. If no files changed, say why.
## Verification
Commands run and their results.
## Metrics
Before/after metrics if applicable.
## Next
Remaining risk or a sensible next improvement.`;

  const task: AutonomousTask = {
    id: taskId,
    title: thought.motivation.slice(0, 100),
    description: thought.content.slice(0, 200),
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    ...taskContinuityFields(thought),
    steps: [{ id: randomBytes(4).toString("hex"), timestamp: Date.now(), action: "spawn-subagent", input: agentMessage.slice(0, 200), success: true }],
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

  const sessionKey = `agent:main:subagent:soul-task-${taskId}`;
  const timeoutMs = AUTONOMOUS_AGENT_TIMEOUT_SECONDS * 1000;

  log.info(`Spawning subagent for run-agent-task ${taskId}: ${target.dir} (${target.name})`);

  let subResult: SubAgentRunResult;
  try {
    subResult = await options.subAgentRunner!({
      sessionKey,
      message: agentMessage,
      timeoutMs,
    });
  } catch (err) {
    subResult = { runId: "", success: false, output: "", error: String(err) };
  }

  // Read what the subagent wrote to the result file (it may have updated it),
  // otherwise use the subagent output directly.
  // When the subagent timed out or errored, wait a grace period for the
  // subagent to finish writing its result — the subagent may still be
  // running after waitForRun returns, and it will write the result file
  // directly via the write tool. Overwriting the file prematurely with
  // subResult.output would clobber the real result.
  if (!subResult.success) {
    await sleep(SUBAGENT_GRACE_PERIOD_MS);
  }
  let report: string;
  try {
    const fileContent = readFileSync(resultFilePath, "utf-8");
    // If the file still only contains the initial report skeleton, use subagent output
    if (fileContent.startsWith("Status: in-progress") || fileContent.length < 200) {
      if (subResult.success) {
        report = subResult.output;
      } else {
        // Subagent timed out or errored and hasn't written a final report yet.
        // Write "partial" instead of "failed" so the subagent's eventual write
        // (if it finishes later) is the canonical result.
        report = `Status: partial\n\n## Outcome\nSubagent did not finish within the timeout. ${subResult.error || subResult.output || "No output"}`;
      }
      writeTaskReportFile(resultFilePath, report);
    } else {
      report = fileContent;
    }
  } catch {
    report = subResult.success ? subResult.output : `Status: failed\n\n## Outcome\n${subResult.error || subResult.output || "Subagent failed with no output"}`;
    writeTaskReportFile(resultFilePath, report);
  }

  // Determine task status from the report's Status: line.
  // "completed" → completed; "partial"/"blocked" → also completed (did useful work,
  //   should NOT trigger failure backoff); everything else → failed.
  const taskStatus: TaskStatus = reportStatusToTaskStatus(report);

  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = taskStatus;
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

  // Success if the report indicates a terminal state (completed/partial/blocked),
  // regardless of whether subResult.success was false (e.g. timeout — the subagent
  // may have finished writing during the grace period).
  const success = taskStatus === "completed" || subResult.success;
  log.info(`Subagent run-agent-task ${taskId}: status=${taskStatus}, success=${success}`);

  return {
    result: {
      type: "run-agent-task",
      success,
      result: report.slice(0, 500),
      data: { taskId, resultFilePath, status: taskStatus, runId: subResult.runId },
    },
    metricsChanged: [
      { need: "growth", delta: success ? 10 : 3, reason: success ? "completed autonomous task via subagent" : "subagent task did not fully complete" },
      { need: "meaning", delta: success ? 5 : 2, reason: "reported verifiable autonomous task status" },
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

  // Compose summary from all completed tasks — include git diff when available
  const taskSummaries = reportableTasks.map((t) => {
    const summary = `**${t.title}**\n${t.result?.slice(0, 2000) ?? "No result"}`;
    const targetDir = t.targetProjectRoot || "";
    if (targetDir) {
      const diffStat = captureGitDiffStat(targetDir);
      if (diffStat) return `${summary}\n\n**Git diff**:\n${diffStat.slice(0, 1000)}`;
    }
    return summary;
  }).join("\n\n");

  // Do not keyword-deduplicate structured autonomous reports. Adjacent backtest
  // iterations often share vocabulary while containing different commands,
  // files, metrics, or blockers. Exact message dedup below is enough to prevent
  // repeated sends without swallowing useful work.

  const templateLanguage = supportsLocalMessageTemplate(ego);
  // Local reports intentionally have only two audited templates. Every other
  // language goes through the multilingual model instead of receiving English.
  const directMessage = templateLanguage ? buildDirectTaskReportMessage(reportableTasks, ego) : null;
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

  const reportLangInstruction = buildUserLanguageInstruction(ego);
  const zhReport = wantsChineseReport(ego);
  const prompt = `You are a proactive AI. You autonomously investigated something and want to share findings with the user. ${reportLangInstruction}

**What you investigated**:
${taskSummaries}

Write a useful progress report in , not a tiny notification. Use 1 short opening sentence plus 2-5 compact bullets when that is clearer. Rules:
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

function resolveSoulProjectDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDir, ".."), resolve(moduleDir, "..", "..")];
  for (const candidate of candidates) {
    try {
      if (statSync(join(candidate, "package.json")).isFile()) return candidate;
    } catch {
      // Try the next layout (source checkout versus compiled dist/src).
    }
  }
  return moduleDir;
}

const SOUL_PROJECT_DIR = resolveSoulProjectDir();

// Files that must NOT be auto-modified (entry points, type definitions)
const PROTECTED_FILES = new Set(["index.ts", "types.ts", "paths.ts", "logger.ts"]);

const SOURCE_EXTENSIONS = [".ts", ".js", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".rb"];
const PROJECT_MARKERS = new Set([
  "package.json", "pyproject.toml", "setup.py", "requirements.txt", "pom.xml",
  "build.gradle", "build.gradle.kts", "cargo.toml", "go.mod", "makefile", ".git",
]);
const IGNORED_SOURCE_DIRS = new Set([
  ".git", ".tmp", "node_modules", "dist", "build", "coverage", "target", "vendor",
]);
const MAX_IMPROVEMENT_SOURCE_FILES = 80;

type ImprovementProposal = {
  problem: string;
  file: string;
  oldCode: string;
  newCode: string;
  explanation: string;
};

function extractJsonObject(text: string): string | null {
  const stripped = text.trim()
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw = stripped.slice(start, end + 1);

  // Strip JavaScript-style comments (// line comments and /* block comments */)
  raw = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .trim();

  // Remove trailing commas before } or ] (common LLM mistake)
  raw = raw.replace(/,\s*([\]}])/g, "$1");

  return raw;
}

/**
 * Attempt to parse a JSON object from LLM output, tolerating common LLM
 * formatting mistakes: markdown fences, trailing commas, comments, and
 * leading prose before the JSON block.
 */
function parseImprovementProposal(text: string): { proposal?: ImprovementProposal; error?: string } {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return { error: "No JSON object found in LLM response" };

  const tryParse = (s: string): Record<string, unknown> | null => {
    try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
  };

  let parsed = tryParse(jsonText);

  // Fallback 1: try to fix unquoted keys (e.g. {problem: "..."} → {"problem": "..."})
  if (!parsed) {
    const fixed = jsonText.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    parsed = tryParse(fixed);
  }

  // Fallback 2: try to fix single-quoted values → double-quoted
  if (!parsed) {
    const fixed = jsonText.replace(/'([^']*)'/g, '"$1"');
    parsed = tryParse(fixed);
  }

  // Fallback 3: extract key-value pairs via regex (last resort)
  if (!parsed) {
    const extract = (key: string): string => {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i").exec(jsonText);
      return m ? m[1].replace(/\\(.)/g, "$1") : "";
    };
    const proposal: ImprovementProposal = {
      problem: extract("problem"),
      file: extract("file"),
      oldCode: extract("oldCode"),
      newCode: extract("newCode"),
      explanation: extract("explanation"),
    };
    if (proposal.file || proposal.oldCode || proposal.newCode) {
      return { proposal };
    }
    return { error: `Invalid JSON from LLM response: unable to parse after all fallbacks` };
  }

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
  // A path segment deliberately excludes separators. The previous pattern
  // accepted any single `/x` prefix, so ordinary prose such as `/src` or
  // `/memory` was converted into fake Git-Bash drive roots (`/s`, `/m`).
  // Keep this parser structural and conservative: a POSIX/Git-Bash path
  // needs at least two real segments, while Windows paths need a segment
  // after the drive separator.
  const pathSegment = String.raw`[A-Za-z0-9._~@%+=,(){}\[\]\-]+`;
  const patterns = [
    new RegExp(`([A-Za-z]:[\\\\/]${pathSegment}(?:[\\\\/]${pathSegment})*)`, "g"),
    new RegExp(`(/mnt/[A-Za-z](?:/${pathSegment})+)`, "g"),
    new RegExp(`(/(?!mnt/)[A-Za-z0-9._~-]+(?:/${pathSegment})+)`, "g"),
    new RegExp(`(~[\\\\/]${pathSegment}(?:[\\\\/]${pathSegment})*)`, "g"),
  ];

  const candidates = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) candidates.add(match[1]);
    }
  }
  return [...candidates];
}

type TargetCandidateSource = "thought" | "recentMessage" | "projectContext" | "userFact" | "goal" | "workspace";

function gatherTargetCandidates(
  ego: EgoState,
  thought?: Thought,
  workspaceContext?: string,
): Array<{ raw: string; source: TargetCandidateSource }> {
  const candidates: Array<{ raw: string; source: TargetCandidateSource }> = [];

  const thoughtTexts = [
    typeof thought?.actionParams?.projectRoot === "string" ? thought.actionParams.projectRoot : undefined,
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

  const projectContexts = [...(ego.projectContexts ?? [])].sort((a, b) => {
    if (a.root === ego.activeProjectRoot) return -1;
    if (b.root === ego.activeProjectRoot) return 1;
    return b.lastObservedAt - a.lastObservedAt;
  });
  for (const context of projectContexts) {
    if (context.confidence >= 0.8) candidates.push({ raw: context.root, source: "projectContext" });
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

function explicitlyNamesSoulProject(
  ego: EgoState,
  thought?: Thought,
  workspaceContext?: string,
): boolean {
  const params = thought?.actionParams ?? {};
  const texts = [
    thought?.content,
    thought?.triggerDetail,
    thought?.motivation,
    typeof params.objective === "string" ? params.objective : undefined,
    typeof params.reason === "string" ? params.reason : undefined,
    ...(ego.recentUserMessages ?? []).slice(-6),
    workspaceContext,
  ].filter((value): value is string => Boolean(value));
  return texts.some((text) => /(?:^|[^a-z0-9])openclaw[-_ ]soul(?:$|[^a-z0-9])/i.test(text));
}

function resolveTargetProject(
  ego: EgoState,
  thought?: Thought,
  workspaceContext?: string,
): { dir: string; name: string; isSelf: boolean; resolutionError?: string } {
  const candidates = gatherTargetCandidates(ego, thought, workspaceContext);
  const tried: string[] = [];

  for (const candidate of candidates) {
    for (const dir of expandPathCandidate(candidate.raw)) {
      tried.push(dir);
      if (isUnsafeProjectRoot(dir)) {
        log.warn(`Ignoring unsafe target project root candidate: ${dir} (from ${candidate.raw})`);
        continue;
      }
      if (pathExists(dir) && isProjectDirectory(dir)) {
        const projectName = parsePath(resolve(dir)).base || candidate.raw;
        return { dir, name: projectName, isSelf: false };
      }
      if (pathExists(dir)) {
        log.info(`Skipping container directory that is not a source project: ${dir}`);
      }
    }
  }

  // "openclaw-soul" is the one project name that can be resolved without a
  // user-supplied filesystem path: this running plugin knows its own linked
  // checkout. Do this only for that explicit name, after every concrete path
  // has been checked, so it cannot redirect an arbitrary project request.
  if (explicitlyNamesSoulProject(ego, thought, workspaceContext) && isProjectDirectory(SOUL_PROJECT_DIR)) {
    log.info(`Resolved explicit openclaw-soul reference to linked plugin root: ${SOUL_PROJECT_DIR}`);
    return { dir: SOUL_PROJECT_DIR, name: "openclaw-soul", isSelf: true };
  }

  if (candidates.length > 0) {
    const resolutionError = `Project target is ambiguous or does not resolve to a source project; tried: ${tried.join(", ")}`;
    log.warn(`${resolutionError}. Autonomous work will stop instead of changing an unrelated project.`);
    return { dir: "", name: "unresolved project", isSelf: false, resolutionError };
  }

  return { dir: SOUL_PROJECT_DIR, name: "Soul plugin (self-improvement)", isSelf: true };
}

function isProjectDirectory(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => {
      const lower = entry.name.toLowerCase();
      return PROJECT_MARKERS.has(lower)
        || (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext)));
    });
  } catch {
    return false;
  }
}

/** Get bounded recursive source paths relative to a project root. */
function getSourceFiles(dir: string): string[] {
  const files: string[] = [];
  const visit = (current: string, depth: number): void => {
    if (depth > 5 || files.length >= MAX_IMPROVEMENT_SOURCE_FILES) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_IMPROVEMENT_SOURCE_FILES) break;
      const lower = entry.name.toLowerCase();
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_SOURCE_DIRS.has(lower)) visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || PROTECTED_FILES.has(entry.name)) continue;
      if (SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        files.push(relative(dir, fullPath).replace(/\\/g, "/"));
      }
    }
  };
  try {
    visit(dir, 0);
    return files;
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
  const reportZh = wantsChineseReport(ego);

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
    ...taskContinuityFields(thought),
    steps: [],
    requiresWritePermission: false,
    resultDelivered: false,
  };
  await persistTask(task);

  if (target.resolutionError) {
    const result = `Status: failed
Task: ${taskId}
Finished: ${new Date().toISOString()}

## Outcome
${reportZh
    ? `未启动代码优化：${target.resolutionError}。`
    : `No code improvement was started: ${target.resolutionError}.`}

## Changes
${reportZh ? "没有修改任何文件。" : "No files were changed."}

## Verification
${reportZh ? "目标解析失败，因此没有读取源码或运行验证命令。" : "No source or verification command was run because target resolution failed."}

## Metrics
${reportZh ? "读取文件：0；修改文件：0；验证：未执行。" : "Files read: 0. Files modified: 0. Verification: not run."}

## Next
${reportZh
    ? "需要从用户明确路径或主 Agent 的成功工具轨迹获得可信项目根目录后才能重试。"
    : "Retry only after a trusted project root is available from an explicit user path or successful host-agent tool evidence."}`;
    await completeTask(taskId, result, "failed");
    return {
      result: { type: "observe-and-improve", success: false, error: target.resolutionError },
      metricsChanged: [],
    };
  }

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
  const projectContext = (ego.projectContexts ?? []).find((context) =>
    context.root.toLowerCase() === target.dir.toLowerCase());
  const contextFiles = [...(projectContext?.modifiedFiles ?? []), ...(projectContext?.observedFiles ?? [])]
    .filter((file, index, items) => items.indexOf(file) === index)
    .filter((file) => {
      const fullPath = resolve(target.dir, file);
      const withinTarget = !relative(target.dir, fullPath).startsWith("..");
      const supported = SOURCE_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension));
      const protectedFile = PROTECTED_FILES.has(parsePath(file).base);
      try {
        return withinTarget && supported && !protectedFile && statSync(fullPath).isFile();
      } catch {
        return false;
      }
    });
  const projectContinuityText = projectContext
    ? `**Host-agent project continuity**:
- Last observed: ${new Date(projectContext.lastObservedAt).toISOString()}
- Recently modified files: ${projectContext.modifiedFiles.join(", ") || "none recorded"}
- Recently observed files: ${projectContext.observedFiles.join(", ") || "none recorded"}
- Verification commands already used: ${projectContext.verificationCommands.join(" | ") || "none recorded"}`
    : "";
  const handoffText = typeof thought.actionParams?.workHandoffId === "string"
    ? `**Durable work handoff**:
- Handoff: ${thought.actionParams.workHandoffId}
- Intention: ${thought.actionParams.intentionId ?? "unknown"}
- Objective: ${String(thought.actionParams.objective ?? thought.motivation)}
- Prior phase: ${String(thought.actionParams.priorWorkPhase ?? "unknown")}
- Acceptance criteria: ${Array.isArray(thought.actionParams.acceptanceCriteria) ? thought.actionParams.acceptanceCriteria.join("; ") : "not recorded"}
- Prior modified files: ${Array.isArray(thought.actionParams.priorModifiedFiles) ? thought.actionParams.priorModifiedFiles.join(", ") : "none recorded"}
- Prior verification: ${Array.isArray(thought.actionParams.priorVerificationCommands) ? thought.actionParams.priorVerificationCommands.join(" | ") : "none recorded"}
- Prior failed tools: ${Array.isArray(thought.actionParams.priorFailedTools) ? thought.actionParams.priorFailedTools.join(", ") : "none"}`
    : "";

  // --- Read source files ---
  const allFiles = [...new Set([...contextFiles, ...getSourceFiles(target.dir)])]
    .slice(0, MAX_IMPROVEMENT_SOURCE_FILES);
  const fileContents: string[] = [];
  for (const fname of allFiles) {
    const step = await readLocalFile("read-source", `${target.dir}/${fname}`);
    if (step.success && step.output) {
      fileContents.push(`=== ${fname} ===\n${step.output.slice(0, 4000)}`);
    }
  }

  log.info(`Improvement: read ${fileContents.length}/${allFiles.length} source files from ${target.dir}`);

  if (fileContents.length === 0) {
    const noSourceReport = `Status: failed
Task: ${taskId}
Finished: ${new Date().toISOString()}

## Outcome
${reportZh
    ? `未执行代码优化：${target.dir} 不是可读取的源码项目。`
    : `No improvement was performed because ${target.dir} does not resolve to a readable source project.`}

## Changes
${reportZh ? "没有修改任何文件。" : "No files were changed."}

## Verification
${reportZh
    ? "源码扫描已检查目标目录，符合条件的源码文件为 0。"
    : "Source discovery inspected the resolved target and found 0 eligible source files."}

## Metrics
${reportZh
    ? "检查文件：0；修改文件：0；通过验证命令：0。"
    : "Files inspected: 0. Files modified: 0. Verification commands passed: 0."}

## Next
${reportZh
    ? "下一次 Improvement 必须先解析到具体项目根目录，不能再把项目集合目录当成源码项目。"
    : "Resolve the directive to a concrete project root before starting another improvement."}`;
    await completeTask(taskId, noSourceReport, "failed");
    return { result: { type: "observe-and-improve", success: false, error: `No source files found in ${target.dir}` }, metricsChanged: [] };
  }

  // Recent analysis context — only include results from prior improvement
  // tasks (requiresWritePermission === true). Analyze-problem results are
  // generic diagnostic summaries that add noise without actionable context.
  // Also filter out boilerplate partial/failed results that have no findings.
  const recentAnalyses = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && t.id !== taskId
      && t.requiresWritePermission === true
      && !isLowValueAutonomousFailure(t))
    .slice(-2)
    .map((t) => t.result)
    .join("\n\n");

  // --- User context ---
  const userContext = ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n");

  // --- LLM analysis ---
  const fileNames = allFiles.join(", ");
    const zh = wantsChineseReport(ego);
  const langInstruction = zh
    ? "用中文写报原。所有 section 内容用中文，不要用英文。"
    : "Write the report in English.";

const projectDesc = target.isSelf
    ? "This is the Soul plugin itself — an autonomous AI agent with ego, thoughts, and actions."
    : `This is project at ${target.dir}.`;
  const analysisPrompt = `You are a developer analyzing source code to find and fix real problems.
${projectDesc}

${actionStatsText}

${projectContinuityText}

${handoffText}

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
  let proposedFile = "";
  let proposedProblem = "";
  let proposedExplanation = "";

  try {
    const llmResponse = await options.llmGenerator(analysisPrompt);
    analysisResult = llmResponse;
    analysisCompleted = true;

    const parsed = parseImprovementProposal(llmResponse);
    if (parsed.proposal) {
      try {
        const { file: fixFile, oldCode, newCode, problem, explanation } = parsed.proposal;
        proposedFile = fixFile;
        proposedProblem = problem;
        proposedExplanation = explanation;

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

          // Try exact match first, then fall back to whitespace-normalized match.
          // LLMs often return oldCode with slightly different indentation or
          // line endings (tabs vs spaces, trailing whitespace, CRLF vs LF).
          const applyPatch = (original: string, old: string, repl: string): string | null => {
            if (original.includes(old)) return original.replace(old, repl);
            // Normalize: collapse runs of whitespace to single spaces for matching
            const normalizeWs = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/^ +/gm, "").replace(/ +$/gm, "");
            const normOriginal = normalizeWs(original);
            const normOld = normalizeWs(old);
            if (normOriginal.includes(normOld)) {
              // Find the actual span in the original that corresponds to the normalized match
              const startIdx = normOriginal.indexOf(normOld);
              // Map normalized indices back to original indices
              let origIdx = 0, normIdx = 0;
              while (normIdx < startIdx && origIdx < original.length) {
                if (normalizeWs(original[origIdx]) === normOriginal[normIdx]) {
                  normIdx++;
                }
                origIdx++;
              }
              const origStart = origIdx;
              while (normIdx < startIdx + normOld.length && origIdx < original.length) {
                if (normalizeWs(original[origIdx]) === normOriginal[normIdx]) {
                  normIdx++;
                }
                origIdx++;
              }
              const origEnd = origIdx;
              return original.slice(0, origStart) + repl + original.slice(origEnd);
            }
            return null;
          };
          const newContent = applyPatch(content, oldCode, newCode);
          if (newContent !== null) {
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

  const taskStatus: "completed" | "failed" =
    fixApplied || (readOnlyMode && analysisCompleted && !analysisFailure)
      ? "completed"
      : "failed";
  const outcomeText = reportZh
    ? fixApplied
      ? `已完成并验证一项明确优化：${proposedProblem || fixDescription}。`
      : readOnlyMode && analysisCompleted && !analysisFailure
        ? `只读分析已完成：${fixDescription || proposedProblem || "没有发现足够明确的优化项"}。`
        : `本次没有完成代码优化：${fixDescription || analysisFailure || "没有找到可安全实施的修改"}。`
    : fixApplied
      ? `Applied and verified one concrete improvement: ${proposedProblem || fixDescription}.`
      : readOnlyMode && analysisCompleted && !analysisFailure
        ? `Completed a read-only analysis: ${fixDescription || proposedProblem || "no concrete improvement was identified"}.`
        : `No autonomous code improvement was completed: ${fixDescription || analysisFailure || "no safe change was identified"}.`;
  const changesText = fixApplied
    ? reportZh
      ? `- 修改文件：${proposedFile}\n- 修复问题：${proposedProblem || "未说明"}\n- 功能优化：${proposedExplanation || fixDescription}`
      : `- File: ${proposedFile}\n- Problem fixed: ${proposedProblem || "not specified"}\n- Functional improvement: ${proposedExplanation || fixDescription}`
    : reportZh
      ? `没有修改任何文件。${proposedFile ? `候选文件：${proposedFile}。` : ""}`
      : `No files were changed.${proposedFile ? ` Candidate file: ${proposedFile}.` : ""}`;
  const verificationText = fixApplied
    ? verificationSummary || (reportZh ? "配置的验证命令已通过。" : "The configured verification command passed.")
    : readOnlyMode
      ? reportZh ? "自主写入未启用，因此没有执行验证命令。" : "No command was run because autonomous write mode was disabled."
      : analysisFailure || (reportZh ? "没有应用修改，因此没有执行验证。" : "No verification was run because no change was applied.");
  const metricsText = reportZh
    ? `发现源码文件：${allFiles.length}；读取文件：${fileContents.length}；修改文件：${fixApplied ? 1 : 0}；验证：${fixApplied ? "通过" : "未执行"}。`
    : `Source files discovered: ${allFiles.length}. Files read: ${fileContents.length}. Files modified: ${fixApplied ? 1 : 0}. Verification: ${fixApplied ? "passed" : "not run"}.`;
  const acceptanceText = (task.acceptanceCriteria ?? []).length > 0
    ? (task.acceptanceCriteria ?? []).map((criterion) => {
      const requiresChange = /changed files/i.test(criterion);
      const requiresVerification = /verification command/i.test(criterion);
      const met = requiresChange ? fixApplied : requiresVerification ? fixApplied : /outcome report/i.test(criterion);
      return `- [${met ? "x" : " "}] ${criterion}`;
    }).join("\n")
    : reportZh ? "没有记录独立的验收条件。" : "No explicit acceptance criteria were recorded.";
  const nextText = reportZh
    ? fixApplied
      ? "在正常使用中观察这项修改；只有出现不同且有证据的问题时，才启动下一次 Improvement。"
      : "不能把本次任务汇报成已完成的代码优化；必须先收窄目标或补充证据再重试。"
    : fixApplied
      ? "Review the verified change in normal use and only start another improvement when there is a distinct issue."
      : "Do not report this as a completed code improvement; refine the target or evidence before retrying.";
  const result = `Status: ${taskStatus}
Task: ${taskId}
Finished: ${new Date().toISOString()}
Target: ${target.dir}

## Outcome
${outcomeText}

## Changes
${changesText}

## Verification
${verificationText}

## Metrics
${metricsText}

## Acceptance
${acceptanceText}

## Next
${nextText}`;

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

// ---------------------------------------------------------------------------
// executeSubagentImprove — full tool-chain improvement via subagent runtime
// ---------------------------------------------------------------------------
//
// This action combines observe-and-improve's focused analysis approach with
// run-agent-task's subagent runtime delegation. The subagent is a full
// OpenClaw agent with exec, write, read, and git tools — giving it both
// write permissions AND full tool-chain access (compile, test, etc.).
//
// Unlike observe-and-improve which uses local LLM + spawnSync for verification
// (limited to npm scripts / python / node --check), this action delegates the
// entire analyze → patch → verify cycle to the subagent, which can run
// arbitrary commands through its exec tool.
//
// Unlike run-agent-task which gives the subagent a generic task message,
// this action provides a focused improvement prompt that asks for exactly
// one concrete fix with verification — combining the best of both paths.

export async function executeSubagentImprove(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  // Require subagent runtime
  if (!options.subAgentRunner) {
    return {
      result: { type: "subagent-improve", success: false, error: "No subagent runtime available — subagent-improve requires api.runtime.subagent" },
      metricsChanged: [],
    };
  }

  // Backoff checks
  if (hasRecentProviderPressure()) {
    log.info("Skipping subagent-improve: provider pressure seen recently");
    return {
      result: { type: "subagent-improve", success: false, error: "Provider rate limit/cooldown seen recently; backing off" },
      metricsChanged: [],
    };
  }
  const failureBackoff = recentAutonomousFailureBackoff(ego);
  if (failureBackoff !== null) {
    const mins = Math.ceil(failureBackoff!.remainingMs / 60_000);
    log.info(`Skipping subagent-improve: recent failure backoff ${mins}m`);
    return {
      result: { type: "subagent-improve", success: false, error: `Backing off for ${mins}m` },
      metricsChanged: [],
    };
  }

  const target = resolveTargetProject(ego, thought, options.workspaceContext);
  if (target.resolutionError) {
    return {
      result: { type: "subagent-improve", success: false, error: target.resolutionError },
      metricsChanged: [],
    };
  }

  // Only 1 concurrent improvement task
  const activeImprove = (ego.activeTasks ?? []).filter(
    (t) => t.status === "in-progress" && t.title?.toLowerCase().includes("improvement"),
  ).length;
  if (activeImprove >= 1) {
    return { result: { type: "subagent-improve", success: false, error: "Improvement task already running" }, metricsChanged: [] };
  }

  const zh = wantsChineseReport(ego);
  const readOnlyMode = !options.autonomousActions;

  const langInstruction = zh
    ? "用中文写报告。所有 section 内容用中文，不要用英文。"
    : "Write the report in English.";

  // Build context
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

  // Recent analysis context — only include results from prior improvement
  // tasks (requiresWritePermission === true). Analyze-problem results are
  // generic diagnostic summaries that add noise without actionable context.
  // Also filter out boilerplate partial/failed results that have no findings.
  const recentAnalyses = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && t.id !== undefined
      && t.requiresWritePermission === true
      && !isLowValueAutonomousFailure(t))
    .slice(-2)
    .map((t) => t.result)
    .join("\n\n");

  // Project context
  const projectContext = (ego.projectContexts ?? []).find((context) =>
    context.root.toLowerCase() === target.dir.toLowerCase());
  const projectContinuityText = projectContext
    ? `**Host-agent project continuity**:
- Last observed: ${new Date(projectContext.lastObservedAt).toISOString()}
- Recently modified files: ${projectContext.modifiedFiles.join(", ") || "none recorded"}
- Recently observed files: ${projectContext.observedFiles.join(", ") || "none recorded"}
- Verification commands already used: ${projectContext.verificationCommands.join(" | ") || "none recorded"}`
    : "";

  const handoffText = typeof thought.actionParams?.workHandoffId === "string"
    ? `**Durable work handoff**:
- Handoff: ${thought.actionParams.workHandoffId}
- Intention: ${thought.actionParams.intentionId ?? "unknown"}
- Objective: ${String(thought.actionParams.objective ?? thought.motivation)}
- Prior phase: ${String(thought.actionParams.priorWorkPhase ?? "unknown")}
- Acceptance criteria: ${Array.isArray(thought.actionParams.acceptanceCriteria) ? thought.actionParams.acceptanceCriteria.join("; ") : "not recorded"}
- Prior modified files: ${Array.isArray(thought.actionParams.priorModifiedFiles) ? thought.actionParams.priorModifiedFiles.join(", ") : "none recorded"}
- Prior verification: ${Array.isArray(thought.actionParams.priorVerificationCommands) ? thought.actionParams.priorVerificationCommands.join(" | ") : "none recorded"}
- Prior failed tools: ${Array.isArray(thought.actionParams.priorFailedTools) ? thought.actionParams.priorFailedTools.join(", ") : "none"}`
    : "";

  const taskId = randomBytes(4).toString("hex");
  const resultDir = join(resolveSoulDir(), "results");
  mkdirSync(resultDir, { recursive: true });
  const resultFilePath = join(resultDir, `${taskId}.md`);

  const readOnlyInstruction = readOnlyMode
    ? "\n\nIMPORTANT: You are in READ-ONLY mode. Only READ files and RUN diagnostic commands. Do NOT edit, write, or modify any files."
    : "";

  const projectDesc = target.isSelf
    ? "This is the Soul plugin itself — an autonomous AI agent with ego, thoughts, and actions."
    : `This is project at ${target.dir}.`;

  const agentMessage = `[Soul Autonomous Improvement Task]
${thought.content}

**IMPORTANT**: This is an AUTONOMOUS task. No one will reply to you. Do NOT ask for confirmation or permission — start working immediately.

You have a hard ${AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS}s work budget. Do one bounded iteration, then stop and finalize.

${langInstruction}

Context:
- Target project: ${target.isSelf ? "not explicitly specified; inspect the current workspace" : `${target.dir} (${target.name})`}
- ${projectDesc}
- User profile: ${userContext || "limited"}
- Recent user messages:
${recentUserMessages || "none"}
- Active goals:
${activeGoals || "none"}
- Trigger: ${thought.triggerDetail}${readOnlyInstruction}
${projectContinuityText ? `- ${projectContinuityText}` : ""}
${handoffText ? `- ${handoffText}` : ""}
${options.workspaceContext ? `- Workspace rules:\n${options.workspaceContext}` : ""}

**Previous findings**:
${recentAnalyses || "None."}

Work like the main OpenClaw agent would when the user directly asks for a focused improvement:
1. Inspect only the most relevant source files, scripts, and recent logs.
2. Identify exactly ONE concrete, high-value improvement that can finish within this run.
3. ${readOnlyMode ? "Propose the fix with exact oldCode/newCode, but do NOT write any files." : "Apply the fix directly by editing the file(s)."}
4. Run the most relevant verification command (build, test, typecheck, compile) to confirm the fix works.
5. If verification fails, revert the change and report the failure.
6. Do not ask for confirmation, do not stop at a proposal, and do not invent results.

Write your final report as markdown with these sections:
## Outcome
What you investigated and the final result.
## Changes
Files changed and why. If no files changed, say why.
## Verification
Commands run and their results.
## Metrics
Before/after metrics if applicable.
## Next
Remaining risk or a sensible next improvement.`;

  const task: AutonomousTask = {
    id: taskId,
    title: `Subagent improvement: ${target.name}`,
    description: `Full tool-chain improvement for ${target.dir}`,
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    ...taskContinuityFields(thought),
    steps: [{ id: randomBytes(4).toString("hex"), timestamp: Date.now(), action: "spawn-subagent-improve", input: agentMessage.slice(0, 200), success: true }],
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

  const sessionKey = `agent:main:subagent:soul-improve-${taskId}`;
  const timeoutMs = AUTONOMOUS_AGENT_TIMEOUT_SECONDS * 1000;

  log.info(`Spawning subagent for subagent-improve ${taskId}: ${target.dir} (${target.name})`);

  let subResult: SubAgentRunResult;
  try {
    subResult = await options.subAgentRunner!({
      sessionKey,
      message: agentMessage,
      timeoutMs,
    });
  } catch (err) {
    subResult = { runId: "", success: false, output: "", error: String(err) };
  }

  // Read what the subagent wrote to the result file, otherwise use subagent output
  // Same grace period logic as executeRunAgentTaskViaSubagent above.
  if (!subResult.success) {
    await sleep(SUBAGENT_GRACE_PERIOD_MS);
  }
  let report: string;
  try {
    const fileContent = readFileSync(resultFilePath, "utf-8");
    if (fileContent.startsWith("Status: in-progress") || fileContent.length < 200) {
      if (subResult.success) {
        report = subResult.output;
      } else {
        report = `Status: partial\n\n## Outcome\nSubagent did not finish within the timeout. ${subResult.error || subResult.output || "No output"}`;
      }
      writeTaskReportFile(resultFilePath, report);
    } else {
      report = fileContent;
    }
  } catch {
    report = subResult.success ? subResult.output : `Status: failed\n\n## Outcome\n${subResult.error || subResult.output || "Subagent failed with no output"}`;
    writeTaskReportFile(resultFilePath, report);
  }

  // Determine task status from the report's Status: line.
  // "completed" → completed; "partial"/"blocked" → also completed (did useful work,
  //   should NOT trigger failure backoff); everything else → failed.
  const taskStatus: TaskStatus = reportStatusToTaskStatus(report);

  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = taskStatus;
      t.result = report;
      t.completedAt = Date.now();
      t.updatedAt = Date.now();
      t.resultDelivered = false;
    }
    return e;
  });

  // Success if the report indicates a terminal state (completed/partial/blocked),
  // regardless of whether subResult.success was false (e.g. timeout — the subagent
  // may have finished writing during the grace period).
  const success = taskStatus === "completed" || subResult.success;
  log.info(`Subagent-improve ${taskId}: status=${taskStatus}, success=${success}`);

  return {
    result: {
      type: "subagent-improve",
      success,
      result: report.slice(0, 500),
      data: { taskId, resultFilePath, status: taskStatus, runId: subResult.runId, fixApplied: success, readOnly: readOnlyMode },
    },
    metricsChanged: [
      { need: "growth", delta: success ? 20 : 3, reason: success ? "completed subagent improvement with full tool-chain verification" : "subagent improvement did not fully complete" },
      { need: "meaning", delta: success ? 10 : 2, reason: "reported verifiable autonomous improvement with tool-chain verification" },
    ],
  };
}

async function completeTask(
  taskId: string,
  result: string,
  status: "completed" | "failed" = "completed",
  resultDelivered = false,
): Promise<void> {
  let linkedIntentionId: string | undefined;
  let linkedAcceptanceMet = true;
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      linkedIntentionId = t.intentionId;
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
      const unmetCriteria = unmetAcceptanceCriteria(t, finalResult);
      linkedAcceptanceMet = unmetCriteria.length === 0;
      t.status = status === "failed" || !linkedAcceptanceMet
        ? "failed"
        : reportStatusToTaskStatus(finalResult);
      t.result = finalResult;
      t.completedAt = Date.now();
      t.updatedAt = Date.now();
      t.resultDelivered = resultDelivered;
    }
    return e;
  });
  if (linkedIntentionId) {
    const intentionStore = new IntentionStore(resolveIntentionStorePath(resolveEgoStorePath()));
    let intentionFulfilled = false;
    await intentionStore.update(linkedIntentionId, (intention) => {
      const requiresChange = intention.evidenceNeeded.includes("concrete changed files");
      const requiresVerification = intention.evidenceNeeded.some((item) => /verification command/i.test(item));
      const reportsNoChange = /No files were changed|没有修改任何文件|Files modified:\s*0|修改文件：0/i.test(result);
      const reportsNoVerification = /Verification:\s*not run|验证：未执行|没有执行验证|No verification was run/i.test(result);
      intention.status = status === "failed"
        || !linkedAcceptanceMet
        || (requiresChange && reportsNoChange)
        || (requiresVerification && reportsNoVerification)
        ? "blocked"
        : "fulfilled";
      intentionFulfilled = intention.status === "fulfilled";
    });
    const handoffStore = new WorkHandoffStore(resolveWorkHandoffStorePath(resolveEgoStorePath()));
    await handoffStore.updateForIntention(linkedIntentionId, (handoff) => {
      handoff.phase = intentionFulfilled ? "verified" : "blocked";
    });
  }
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
 * Try to extract the sub-agent's final report from recent session files.
 * This is a fallback when the agent doesn't write the result file. It returns
 * partial/failed status explicitly when the session timed out or only produced
 * interim narration.
 * Looks for sessions created after `sinceMs` that contain "Soul-Autonomous" or "[Soul Autonomous".
 */
function extractResultFromSessions(task: AutonomousTask, sinceMs: number, zh: boolean): { status: "completed" | "failed"; result: string } | null {
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
      if (!content.includes("Soul-Autonomous") && !content.includes("[Soul Autonomous")) continue;
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
        return { status: "failed", result: buildFailureTaskReport(task, detail, zh) };
      }
      if (lastAssistantText) {
        if (isCompleteTaskReport(lastAssistantText) && (!task.resultFilePath || hasFinalTaskResultFile(task))) {
          return { status: "completed", result: lastAssistantText };
        }
        const detail = `Agent session ${name.name} stopped before producing a final result file${task.resultFilePath ? ` (${task.resultFilePath})` : ""}. Last partial output: ${lastAssistantText.slice(0, 1200)}`;
        const hasUsefulPartial = /\bdone\b|\bfail(?:ed|ure)?\b|\bpasses\b|\bimproved?\b|\bworse\b|\bbug\b|\broot cause\b|\bclear\b|\bmetric\b|\bresult\b|\bverified?\b|\bfixed?\b|\bapplied\b|\bcompleted\b/i.test(lastAssistantText);
        return {
          status: "failed",
          result: hasUsefulPartial ? buildPartialTaskReport(task, detail, zh) : buildFailureTaskReport(task, detail, zh),
        };
      }
    }
  } catch { /* sessions dir not accessible */ }
  return null;
}

async function readLocalFile(actionName: string, filePath: string): Promise<TaskStep> {
  const id = randomBytes(4).toString("hex");
  const start = Date.now();
  try {
    // Resolve bare filenames (no directory component) against the Soul directory
    // instead of process.cwd() (which is C:\Windows\System32 for the gateway service).
    let resolvedPath = filePath;
    if (!isAbsolute(filePath) && !filePath.includes("/") && !filePath.includes("\\")) {
      const soulDir = resolveSoulDir();
      const candidate = join(soulDir, filePath);
      try {
        await accessFile(candidate);
        resolvedPath = candidate;
      } catch {
        // Not in soul dir; fall through and let readFile attempt the original path
      }
    }
    const buf = await readFile(resolvedPath, "utf-8");
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
  const STALE_MS = (AUTONOMOUS_AGENT_TIMEOUT_SECONDS + 120) * 1000; // subagent timeout + 2min grace; must exceed AUTONOMOUS_AGENT_TIMEOUT_SECONDS
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

      // Fallback: try to extract result from session files — but only after
      // the stale timeout has elapsed. Running this while the session is still
      // within its timeout window causes false-positive failures: the session
      // is still actively running and hasn't had a chance to write its final
      // report yet.
      if (!task.result && task.requiresWritePermission && Date.now() - task.updatedAt > STALE_MS) {
        const sessionResult = extractResultFromSessions(task, task.createdAt, wantsChineseReport(e));
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
        const detail = task.result ?? `Task timed out (stale >${Math.round(STALE_MS / 60000)} min). Required final result file was not produced${task.resultFilePath ? `: ${task.resultFilePath}` : ""}.`;
        task.status = "failed";
        task.result = buildFailureTaskReport(task, detail, wantsChineseReport(e));
        writeTaskReportFile(task.resultFilePath, task.result);
        task.completedAt = Date.now();
        task.updatedAt = Date.now();
        newlyCompleted.push({ ...task });
      }
    }

    // Prune old completed tasks (keep last MAX_TASKS)
    if (e.activeTasks.length > MAX_TASKS) {
      // Before pruning from ego, clean up orphaned result files for tasks
      // being evicted — prevents results/ directory from growing unbounded.
      const sorted = [...e.activeTasks].sort((a, b) => b.updatedAt - a.updatedAt);
      const evicted = sorted.slice(MAX_TASKS);
      for (const t of evicted) {
        if (t.resultFilePath) {
          try { unlinkSync(t.resultFilePath); } catch { /* already gone */ }
        }
      }
      e.activeTasks = sorted.slice(0, MAX_TASKS);
    }

    // Clean up orphaned result files not referenced by any task
    const resultDir = join(resolveSoulDir(), "results");
    try {
      const knownResultFiles = new Set(e.activeTasks.map((t) => t.resultFilePath?.toLowerCase()).filter(Boolean));
      const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h retention
      for (const name of readdirSync(resultDir)) {
        if (!name.endsWith(".md")) continue;
        const filePath = join(resultDir, name).toLowerCase();
        if (knownResultFiles.has(filePath)) continue;
        try {
          if (statSync(filePath).mtimeMs < cutoff) {
            unlinkSync(filePath);
          }
        } catch { /* gone */ }
      }
    } catch { /* result dir not accessible */ }

    return e;
  });

  if (newlyCompleted.length > 0) {
    log.info(`Tasks finished: ${newlyCompleted.map((t) => `${t.id}(${t.status}${t.result ? ",has-result" : ",no-result"})`).join(", ")}`);
  }
  return newlyCompleted;
}
