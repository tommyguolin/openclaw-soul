import { randomBytes } from "node:crypto";
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
  const logPaths = (thought.actionParams?.logPaths as string[]) ?? [];
  const sourcePaths = (thought.actionParams?.sourcePaths as string[]) ?? [];
  const execCommands = (thought.actionParams?.execCommands as string[]) ?? [];

  // Read log files
  for (const logPath of logPaths.slice(0, 3)) {
    const step = await runToolStep("read-log", "read", { path: logPath }, options);
    steps.push(step);
    if (step.success && step.output) gatheredInfo.push(`=== Log: ${logPath} ===\n${step.output}`);
  }

  // Read source files
  for (const srcPath of sourcePaths.slice(0, 3)) {
    const step = await runToolStep("read-source", "read", { path: srcPath }, options);
    steps.push(step);
    if (step.success && step.output) gatheredInfo.push(`=== Source: ${srcPath} ===\n${step.output}`);
  }

  // Execute diagnostic commands
  for (const cmd of execCommands.slice(0, 2)) {
    const isWrite = isWriteTool("exec", { command: cmd });
    if (isWrite && !options.autonomousActions) {
      steps.push(makeSkippedStep(`exec: ${cmd}`, "requires write permission"));
      continue;
    }
    const step = await runToolStep("exec-diagnostic", "exec", { command: cmd }, options);
    steps.push(step);
    if (step.success && step.output) gatheredInfo.push(`=== Exec: ${cmd} ===\n${step.output}`);
  }

  // If no specific paths provided, try reading recent gateway logs as a default.
  // Use "read" tool instead of "exec" — exec via /tools/invoke can trigger
  // OpenClaw agent event system errors ("Agent listener invoked outside active run").
  const defaultLogPaths = [
    "/tmp/openclaw/openclaw-2026-04-11.log",
    `/tmp/openclaw/openclaw-${new Date().toISOString().slice(0, 10)}.log`,
    "/tmp/openclaw-gateway.log",
  ];
  if (gatheredInfo.length === 0) {
    for (const logPath of defaultLogPaths) {
      const step = await runToolStep("read-default-log", "read", { path: logPath, offset: -200 }, options);
      steps.push(step);
      if (step.success && step.output) {
        gatheredInfo.push(`=== Gateway log: ${logPath} ===\n${step.output}`);
        break;
      }
    }
  }

  // Phase 2: Analyze with LLM
  let analysisResult = "";
  if (options.llmGenerator && gatheredInfo.length > 0) {
    const totalContext = gatheredInfo.join("\n\n").slice(0, 12_000);
    const lang = ego.userLanguage === "zh-CN" ? "Chinese" : "English";

    const prompt = `You are analyzing a technical problem for a user. Based on the information below, provide a concise analysis.

**Problem context**: ${thought.content.slice(0, 300)}

**Gathered information**:
${totalContext}

Please analyze and respond in ${lang}:
1. What is the root cause (if identifiable)?
2. What is the recommended fix or next step?
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

  const lang = ego.userLanguage === "zh-CN" ? "Chinese" : "English";
  const prompt = `You are a proactive AI assistant. You completed some autonomous analysis tasks. Summarize the findings for the user in ${lang}.

**Task results**:
${taskSummaries}

Write a concise message (2-4 sentences) summarizing the key findings and any actionable recommendations. Be specific — mention actual error messages, file paths, or code locations if they appeared in the analysis. Do NOT be vague.

Output ONLY the message, nothing else.`;

  let message: string;
  try {
    message = await options.llmGenerator(prompt);
    message = message.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
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
