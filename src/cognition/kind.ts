import type { CognitiveKind, Thought } from "../types.js";

const TASK_ACTIONS = new Set([
  "analyze-problem", "run-agent-task", "report-findings", "observe-and-improve", "invoke-tool",
]);
const INTENTION_ACTIONS = new Set([
  "learn-topic", "search-web", "create-goal", "proactive-research", "proactive-content-push",
]);

/** Observation-only compatibility classifier. It must never control routing. */
export function inferCognitiveKind(thought: Pick<Thought, "actionType" | "source" | "triggerDetail">): CognitiveKind {
  const action = thought.actionType ?? "none";
  if (TASK_ACTIONS.has(action) || thought.source === "system-monitor" && action !== "none") {
    return "task-continuation";
  }
  if (INTENTION_ACTIONS.has(action)) return "proactive-intention";
  if (action === "none" || action === "self-reflect" || action === "recall-memory") return "private-thought";
  if (action === "send-message" && /private|pool|incubat/i.test(thought.triggerDetail)) return "private-thought";
  return "legacy-unknown";
}
