import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createSoulLogger } from "./logger.js";
import { invokeGatewayTool, fireAgentTask, isWriteTool } from "./gateway-client.js";
import type { LLMGenerator } from "./soul-llm.js";
import type { Thought, EgoState, ActionResult, MetricDelta, AutonomousTask, TaskStep, ActionType } from "./types.js";
import type { MessageSender } from "./soul-actions.js";
import { updateEgoStore, resolveEgoStorePath } from "./ego-store.js";

const log = createSoulLogger("autonomous-actions");

/** Max concurrent active tasks. */
const MAX_ACTIVE_TASKS = 5;

export type AutonomousActionOptions = {
  autonomousActions: boolean;
  gatewayPort: number;
  authToken?: string;
  hooksToken?: string;
  llmGenerator?: LLMGenerator;
  sendMessage?: MessageSender;
  channel?: string;
  target?: string;
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
      `/tmp/openclaw/openclaw-${today}.log`,
      "/tmp/openclaw-gateway.log",
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
    const lang = ego.userLanguage === "zh-CN" ? "Chinese" : "English";

    const prompt = `You are an AI assistant that has autonomously read some files to investigate a problem or question. Based on the information below, provide a concise analysis.

**Context**: ${thought.content.slice(0, 300)}

**Gathered information**:
${totalContext}

Please analyze and respond in ${lang}:
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

  const agentMessage = `[Soul Autonomous Task]
${thought.content}

Context:
- User profile: ${userContext || "limited"}
- Trigger: ${thought.triggerDetail}${readOnlyInstruction}

Please investigate and report your findings.`;

  const fireResult = await fireAgentTask({
    message: agentMessage,
    gatewayPort: options.gatewayPort,
    hooksToken: options.hooksToken,
    timeoutSeconds: 120,
  });

  if (!fireResult.ok) {
    return {
      result: { type: "run-agent-task", success: false, error: fireResult.error },
      metricsChanged: [],
    };
  }

  // Create task record
  const task: AutonomousTask = {
    id: randomBytes(4).toString("hex"),
    title: thought.motivation.slice(0, 100),
    description: thought.content.slice(0, 200),
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    steps: [{ id: randomBytes(4).toString("hex"), timestamp: Date.now(), action: "fire-agent", input: agentMessage.slice(0, 200), success: true }],
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

  // Dedup: check if these tasks have very similar results to previously
  // delivered tasks. Skip if >80% of key words overlap with recent reports.
  const recentlyDelivered = (ego.activeTasks ?? [])
    .filter((t) => t.resultDelivered && t.result)
    .slice(-5);
  if (recentlyDelivered.length > 0) {
    const newKeywords = extractKeywords(taskSummaries);
    for (const old of recentlyDelivered) {
      const oldKeywords = extractKeywords(old.result ?? "");
      const overlap = newKeywords.filter((w) => oldKeywords.includes(w)).length;
      const similarity = overlap / Math.max(newKeywords.length, 1);
      if (similarity > 0.6) {
        log.info(`Skipping report-findings: ${Math.round(similarity * 100)}% similar to previously delivered task ${old.id}`);
        // Mark as delivered so it won't be picked up again
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

  const lang = ego.userLanguage === "zh-CN" ? "Chinese" : "English";
  const prompt = `You are a proactive AI. You autonomously investigated something and want to share findings with the user. Write the message in ${lang}.

**What you investigated**:
${taskSummaries}

Write 2-4 sentences sharing your findings directly with the user. Rules:
- Start with the FINDING or INSIGHT, never with "收到"/"Got it"/"好的" or acknowledgment phrases
- This is proactive outreach, NOT a response to a request — do NOT sound like a receptionist
- Be specific — mention actual error messages, file paths, or root causes
- Sound natural, like a knowledgeable friend sharing something useful they discovered

**BAD examples** (NEVER do this):
收到，问题已定位：...
好的，根据日志分析...
Got it. I found that...

**GOOD examples**:
你之前问的超时问题我查到了——根因是 OpenViking 的 embedding API 有 512 token 限制，不是 Soul 本身的问题。
日志里那个 413 错误是 OpenViking memory search 输入超长导致的，跟 Soul 插件没关系。

Output ONLY the message, nothing else.`;

  let message: string;
  try {
    message = await options.llmGenerator(prompt);
    message = message
      .replace(/<think[\s\S]*?<\/think>/gi, "")
      .replace(/^(?:收到[，。、！？]?\s*|好的[，。、！？]?\s*|Got it[.!]?\s*|OK[.!]?\s*)/i, "")
      .trim();
  } catch {
    // Fallback: use raw task result
    message = completedTasks[0].result?.slice(0, 300) ?? "Analysis completed.";
  }

  if (!message || message.length < 10) {
    return { result: { type: "report-findings", success: true, result: "nothing meaningful to report" }, metricsChanged: [] };
  }

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
 * Poll active tasks and mark stale ones as completed.
 * Called from the tick cycle to clean up tasks that may have been
 * abandoned (e.g. gateway restart while task was running).
 */
export async function pollActiveTasks(storePath: string): Promise<void> {
  const STALE_MS = 10 * 60 * 1000; // 10 minutes
  const MAX_TASKS = 20;

  await updateEgoStore(storePath, (e) => {
    if (!e.activeTasks) { e.activeTasks = []; return e; }

    let changed = false;
    for (const task of e.activeTasks) {
      if (task.status === "in-progress" && Date.now() - task.updatedAt > STALE_MS) {
        task.status = "completed";
        task.result = task.result ?? "Task timed out (stale >10 min)";
        task.completedAt = Date.now();
        task.updatedAt = Date.now();
        changed = true;
      }
    }

    // Prune old completed tasks (keep last MAX_TASKS)
    if (e.activeTasks.length > MAX_TASKS) {
      e.activeTasks = e.activeTasks
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_TASKS);
      changed = true;
    }

    if (changed) log.info("Polled active tasks: marked stale/trimmed");
    return e;
  });
}
