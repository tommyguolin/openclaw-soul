import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

/** Max concurrent active tasks. */
const MAX_ACTIVE_TASKS = 5;

/** Track recently sent report messages to prevent duplicates. */
const recentReportedMessages: Map<string, number> = new Map();

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

  // Phase 2: Analyze with LLM
  let analysisResult = "";
  if (options.llmGenerator && gatheredInfo.length > 0) {
    const totalContext = gatheredInfo.join("\n\n").slice(0, 12_000);
    const lang = ego.userLanguage === "zh-CN" ? "Chinese"
      : ego.userLanguage === "ja" ? "Japanese"
        : ego.userLanguage === "ko" ? "Korean"
        : undefined;
    const userSamples = ego.recentUserMessages ?? [];
    const langInstruction = lang
      ? `Please analyze and respond in ${lang}.`
      : userSamples.length > 0
        ? `The user writes in this language:\n${userSamples.slice(0, 3).join("\n")}\nRespond in the same language.`
        : "Respond in English.";

    const prompt = `You are an AI assistant that has autonomously read some files to investigate a problem or question. Based on the information below, provide a concise analysis.

**Context**: ${thought.content.slice(0, 300)}

**Gathered information**:
${totalContext}

${langInstruction}
1. What is the root cause or key finding (if identifiable)?
2. What is the recommended fix, next step, or useful insight?
3. Any relevant code or config changes needed?

Keep your response under 300 words. Be specific and actionable.`;

    try {
      analysisResult = await options.llmGenerator(prompt);
    } catch (err) {
      log.warn(`LLM analysis failed: ${String(err)}`);
      analysisResult = "LLM analysis failed — raw data gathered but no interpretation available.";
    }
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

export async function executeRunAgentTask(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  if (!options.hooksToken) {
    return { result: { type: "run-agent-task", success: false, error: "No hooks token configured" }, metricsChanged: [] };
  }

  const activeCount = (ego.activeTasks ?? []).filter((t) => t.status === "in-progress").length;
  if (activeCount >= MAX_ACTIVE_TASKS) {
    return { result: { type: "run-agent-task", success: false, error: "Too many active tasks" }, metricsChanged: [] };
  }

  // Build a detailed prompt for the agent
  const userContext = ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n");
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

Context:
- User profile: ${userContext || "limited"}
- Trigger: ${thought.triggerDetail}${readOnlyInstruction}${analysisContext}${options.workspaceContext ? `\n- Workspace rules:\n${options.workspaceContext}` : ""}

Please investigate and report your findings. If a concrete fix is identified and you have write access, implement it.

**CRITICAL**: After completing your work, write a summary to:
${resultFilePath}
Keep it to 1-2 sentences: what you found and what you did (if anything).`;

  const fireResult = await fireAgentTask({
    message: agentMessage,
    gatewayPort: options.gatewayPort,
    hooksToken: options.hooksToken,
    timeoutSeconds: 300,
  });

  if (!fireResult.ok) {
    return {
      result: { type: "run-agent-task", success: false, error: fireResult.error },
      metricsChanged: [],
    };
  }

  // Create task record
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

  await persistTask(task);

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
    (t) => t.status === "completed" && !t.resultDelivered && t.result,
  );

  if (completedTasks.length === 0) {
    return { result: { type: "report-findings", success: true, result: "no completed tasks to report" }, metricsChanged: [] };
  }

  if (!options.llmGenerator || !options.sendMessage || !options.channel || !options.target) {
    // Can't compose or send — just mark as delivered to stop retrying
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      for (const t of e.activeTasks ?? []) {
        if (t.status === "completed" && !t.resultDelivered) t.resultDelivered = true;
      }
      return e;
    });
    return { result: { type: "report-findings", success: false, error: "Missing message sending capability" }, metricsChanged: [] };
  }

  // Compose summary from all completed tasks
  const taskSummaries = completedTasks.map((t) =>
    `**${t.title}**\n${t.result?.slice(0, 500) ?? "No result"}`,
  ).join("\n\n");

  // Dedup: check against ALL previously delivered tasks (not just last 5).
  // Skip if keyword overlap is >50% with any delivered task.
  const allDelivered = (ego.activeTasks ?? [])
    .filter((t) => t.resultDelivered && t.result);
  if (allDelivered.length > 0) {
    const newKeywords = extractKeywords(taskSummaries);
    for (const old of allDelivered) {
      const oldKeywords = extractKeywords(old.result ?? "");
      const overlap = newKeywords.filter((w) => oldKeywords.includes(w)).length;
      const similarity = overlap / Math.max(newKeywords.length, 1);
      if (similarity > 0.5) {
        log.info(`Skipping report-findings: ${Math.round(similarity * 100)}% similar to delivered task ${old.id}`);
        await updateEgoStore(resolveEgoStorePath(), (e) => {
          for (const t of e.activeTasks ?? []) {
            if (t.status === "completed" && !t.resultDelivered) t.resultDelivered = true;
          }
          return e;
        });
        return { result: { type: "report-findings", success: true, result: "skipped-duplicate" }, metricsChanged: [] };
      }
    }
  }

  const cjkLang = ego.userLanguage === "zh-CN" ? "Chinese (中文)"
    : ego.userLanguage === "ja" ? "Japanese"
      : ego.userLanguage === "ko" ? "Korean"
      : undefined;
  const userSamples = ego.recentUserMessages ?? [];
  const reportLangInstruction = cjkLang
    ? `Write the message in ${cjkLang}.`
    : userSamples.length > 0
      ? `The user writes in this language:\n${userSamples.slice(0, 3).join("\n")}\nWrite the message in the SAME language.`
      : "Write the message in English.";
  const prompt = `You are a proactive AI. You autonomously investigated something and want to share findings with the user. ${reportLangInstruction}

**What you investigated**:
${taskSummaries}

Write 3-5 sentences in flowing prose (NOT a numbered list). Rules:
- Start by mentioning WHAT you investigated and WHY (e.g. "我后来查了一下飞书消息发送超时的问题——", "我研究了一下那个 413 错误——", "I looked into the Discord delivery issue —")
- Then share the CONCRETE finding: actual error messages, root causes, or actionable insights
- If you investigated multiple things, pick the ONE most interesting finding — do NOT list them all
- Sound natural, like a knowledgeable friend sharing something useful they discovered
- Do NOT describe your own behavior, configuration changes, or self-modifications
- Do NOT mention "Soul" by name — the user knows who you are
- Do NOT report about fixing your own bugs, adding keywords, tuning your config, or improving yourself — that is internal maintenance, NOT a user-facing finding
- Do NOT use numbered lists or bullet points — they get truncated and look bad in chat
- Only report if you found a CONCRETE root cause or actionable insight about an EXTERNAL system or real-world fact
- If the task was about self-improvement (modifying your own code/config/keywords), output exactly: NO_MESSAGE

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

If the investigation didn't find a concrete root cause, output exactly: NO_MESSAGE
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
    message = completedTasks[0].result?.slice(0, 300) ?? "Analysis completed.";
  }

  // Reject messages that are clearly not useful
  if (!message || message.length < 10 || message.toUpperCase() === "NO_MESSAGE") {
    log.info("Report-findings: no valuable content to report, skipping");
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      for (const t of e.activeTasks ?? []) {
        if (t.status === "completed" && !t.resultDelivered) t.resultDelivered = true;
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
        if (t.status === "completed" && !t.resultDelivered) t.resultDelivered = true;
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
        if (t.status === "completed" && !t.resultDelivered) t.resultDelivered = true;
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
    log.info(`Reported findings: ${completedTasks.length} tasks, message ${message.length} chars`);
  } catch (err) {
    log.warn(`Failed to send report: ${String(err)}`);
    return { result: { type: "report-findings", success: false, error: String(err) }, metricsChanged: [] };
  }

  // Mark tasks as delivered
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    for (const t of e.activeTasks ?? []) {
      if (t.status === "completed" && !t.resultDelivered) t.resultDelivered = true;
    }
    return e;
  });

  return {
    result: { type: "report-findings", success: true, result: `Reported ${completedTasks.length} tasks` },
    metricsChanged: [
      { need: "connection", delta: 10, reason: "proactively shared useful findings" },
      { need: "meaning", delta: 8, reason: "delivered value to user" },
    ],
  };
}

// ---------------------------------------------------------------------------
// executeObserveAndImprove — analyze and fix code in any project
// ---------------------------------------------------------------------------

const SOUL_SRC_DIR = dirname(fileURLToPath(import.meta.url));

// Files that must NOT be auto-modified (entry points, type definitions)
const PROTECTED_FILES = new Set(["index.ts", "types.ts", "paths.ts", "logger.ts"]);

const SOURCE_EXTENSIONS = [".ts", ".js", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".rb"];

/**
 * Resolve the target project directory from ego goals.
 * Looks for goals containing a file path (starts with / or ~/).
 * Falls back to Soul's own src dir for self-improvement.
 */
function resolveTargetProject(ego: EgoState): { dir: string; name: string; isSelf: boolean } {
  // Check goals for project paths
  const pathRe = /(?:^|\s|["'`])(\/[\w/.@-]+(?:\/src|\/lib)?)(?:["'`\s,.]|$)/;
  for (const goal of ego.goals ?? []) {
    if (goal.status !== "active") continue;
    const m = goal.title.match(pathRe) || goal.description?.match(pathRe);
    if (m) {
      const dir = m[1].startsWith("~") ? resolve(homedir(), m[1].slice(1)) : m[1];
      return { dir, name: goal.title.slice(0, 60), isSelf: false };
    }
  }
  // Check userFacts for project paths
  for (const fact of ego.userFacts ?? []) {
    const m = fact.content.match(pathRe);
    if (m) {
      const dir = m[1].startsWith("~") ? resolve(homedir(), m[1].slice(1)) : m[1];
      return { dir, name: `user directive: ${fact.content.slice(0, 60)}`, isSelf: false };
    }
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
    (t) => t.status === "in-progress" && t.title?.includes("improvement"),
  ).length;
  if (activeImprove >= 1) {
    return { result: { type: "observe-and-improve", success: false, error: "Improvement task already running" }, metricsChanged: [] };
  }

  // Resolve target project from goals
  const target = resolveTargetProject(ego);
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

  try {
    const llmResponse = await options.llmGenerator(analysisPrompt);
    analysisResult = llmResponse;

    // Strip markdown code blocks first (LLM often wraps JSON in ```json ... ```)
    const stripped = llmResponse.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "");

    // Extract fields by name boundaries
    const fileMatch = stripped.match(/"file"\s*:\s*"([^"]+)"/);
    const oldCodeMatch = stripped.match(/"oldCode"\s*:\s*"([\s\S]*?)"\s*,\s*"newCode"/);
    const newCodeMatch = stripped.match(/"newCode"\s*:\s*"([\s\S]*?)"\s*,\s*"explanation"/);
    const problemMatch = stripped.match(/"problem"\s*:\s*"([\s\S]*?)"\s*,\s*"file"/);
    const explanationMatch = stripped.match(/"explanation"\s*:\s*"([\s\S]*?)"\s*[}\n]/);

    if (fileMatch && oldCodeMatch && newCodeMatch) {
      try {
        const fixFile = fileMatch[1];
        const oldCode = oldCodeMatch[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
        const newCode = newCodeMatch[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
        const problem = problemMatch ? problemMatch[1] : "unknown";
        const explanation = explanationMatch ? explanationMatch[1] : "";

        if (readOnlyMode) {
          fixDescription = `Read-only recommendation for ${fixFile}: ${explanation || problem}`;
        } else if (PROTECTED_FILES.has(fixFile)) {
          fixDescription = `Fix not applied: ${fixFile} is a protected file`;
        } else {
          const fullPath = `${target.dir}/${fixFile}`;
          const content = await readFile(fullPath, "utf-8");

          if (content.includes(oldCode)) {
            const newContent = content.replace(oldCode, newCode);
            writeFileSync(fullPath, newContent);

            fixApplied = true;
            fixDescription = `Fixed ${fixFile}: ${explanation || problem}`;
            log.info(`Applied improvement fix to ${target.dir}/${fixFile}: ${problem}`);
          } else {
            fixDescription = `Fix not applied: oldCode not found verbatim in ${fixFile}`;
          }
        }
      } catch (parseErr) {
        fixDescription = `Fix parse failed: ${String(parseErr)}`;
      }
    }
  } catch (err) {
    analysisResult = `LLM analysis failed: ${String(err)}`;
    log.warn(`Improvement LLM call failed: ${String(err)}`);
  }

  log.info(`Improvement analysis done: fixApplied=${fixApplied}, ${fixDescription || "no fix"}`);

  const result = fixApplied
    ? fixDescription
    : `Analysis of ${target.dir}. ${fixDescription || "No concrete fix identified."} ${analysisResult.slice(0, 300)}`;

  await completeTask(taskId, result);

  return {
    result: {
      type: "observe-and-improve",
      success: true,
      result: result.slice(0, 500),
      data: { readOnly: readOnlyMode, fixApplied },
    },
    metricsChanged: [
      { need: "growth", delta: fixApplied ? 20 : 10, reason: fixApplied ? "applied improvement fix" : "code analysis" },
      { need: "meaning", delta: fixApplied ? 15 : 8, reason: readOnlyMode ? "observing self-improvement opportunities" : "working on user's assigned goal" },
    ],
  };
}

async function completeTask(taskId: string, result: string): Promise<void> {
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = "completed";
      t.result = result;
      t.completedAt = Date.now();
      t.updatedAt = Date.now();
      t.resultDelivered = false;
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
 * Try to extract the sub-agent's final assistant message from recent session files.
 * This is a fallback when the agent doesn't write the result file.
 * Looks for sessions created after `sinceMs` that contain "Soul-Autonomous".
 */
function extractResultFromSessions(sinceMs: number): string | null {
  const sessionsDir = join(homedir(), ".openclaw/agents/main/sessions");
  try {
    const files = readdirSync(sessionsDir);
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const fp = join(sessionsDir, name);
      const stat = statSync(fp);
      // Only check sessions modified after the task was created
      if (stat.mtimeMs < sinceMs - 60_000) continue;
      const content = readFileSync(fp, "utf-8");
      if (!content.includes("Soul-Autonomous")) continue;
      // Find last assistant text message
      let lastAssistantText = "";
      for (const line of content.split("\n")) {
        try {
          const obj = JSON.parse(line.trim());
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
        } catch { /* skip malformed lines */ }
      }
      if (lastAssistantText) {
        return lastAssistantText.slice(0, 1000);
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
  const STALE_MS = 30 * 60 * 1000; // 30 minutes
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
          if (content) {
            task.result = content;
            task.status = "completed";
            task.completedAt = Date.now();
            task.updatedAt = Date.now();
            newlyCompleted.push({ ...task });
            try { unlinkSync(task.resultFilePath); } catch { /* ignore cleanup failure */ }
            continue;
          }
        } catch { /* file not ready yet */ }
      }

      // Fallback: try to extract result from session files
      if (!task.result && task.requiresWritePermission) {
        const sessionResult = extractResultFromSessions(task.createdAt);
        if (sessionResult) {
          task.result = sessionResult;
          task.status = "completed";
          task.completedAt = Date.now();
          task.updatedAt = Date.now();
          newlyCompleted.push({ ...task });
          continue;
        }
      }

      // Final fallback: stale timeout
      if (Date.now() - task.updatedAt > STALE_MS) {
        task.status = "completed";
        task.result = task.result ?? "Task timed out (stale >10 min)";
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
    log.info(`Tasks completed: ${newlyCompleted.map((t) => `${t.id}(${t.result ? "has-result" : "timeout"})`).join(", ")}`);
  }
  return newlyCompleted;
}
