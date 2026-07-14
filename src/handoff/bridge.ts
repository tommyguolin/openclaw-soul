import { resolveEgoStorePath } from "../ego-store.js";
import { resolveIntentionStorePath, IntentionStore } from "../intention/store.js";
import { createSoulLogger } from "../logger.js";
import type { ProjectContext } from "../types.js";
import { resolveWorkHandoffStorePath, WorkHandoffStore } from "./store.js";
import type { WorkHandoff, WorkHandoffPhase } from "./types.js";

const log = createSoulLogger("work-handoff");

function lastUserText(messages: unknown[]): string {
  const records = messages.filter((message): message is Record<string, unknown> =>
    !!message && typeof message === "object" && !Array.isArray(message));
  const user = [...records].reverse().find((message) => message.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content.trim();
  if (!Array.isArray(user.content)) return "";
  return user.content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return "";
    const record = part as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? record.text : "";
  }).join(" ").trim();
}

function failedToolNames(messages: unknown[]): string[] {
  const records = messages.filter((message): message is Record<string, unknown> =>
    !!message && typeof message === "object" && !Array.isArray(message));
  let lastUserIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return [...new Set(records.slice(lastUserIndex >= 0 ? lastUserIndex + 1 : 0)
    .filter((message) => message.role === "toolResult"
      && (message.isError === true || (message.result && typeof message.result === "object"
        && (message.result as Record<string, unknown>).isError === true)))
    .map((message) => typeof message.toolName === "string" ? message.toolName : "unknown-tool"))];
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function choosePhase(context: ProjectContext, failedTools: string[]): WorkHandoffPhase {
  if (failedTools.length > 0 && context.modifiedFiles.length === 0) return "blocked";
  if (context.modifiedFiles.length > 0 && context.verificationCommands.length > 0 && failedTools.length === 0) return "verified";
  if (context.modifiedFiles.length > 0) return "implementing";
  return "investigating";
}

export async function recordAgentWorkHandoffs(
  messages: unknown[],
  projectContexts: ProjectContext[],
  sessionKey?: string,
  conversationId?: string,
): Promise<WorkHandoff[]> {
  if (projectContexts.length === 0) return [];
  const egoPath = resolveEgoStorePath();
  const intentionStore = new IntentionStore(resolveIntentionStorePath(egoPath));
  const intentionFile = await intentionStore.load();
  const userText = lastUserText(messages);
  const active = intentionFile.intentions
    .filter((intention) => intention.origin === "user-directive" && intention.status === "active"
      && (!conversationId || !intention.conversationId || intention.conversationId === conversationId)
      && Date.now() - intention.updatedAt < 48 * 60 * 60 * 1000)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const exact = userText ? active.find((intention) => normalized(intention.desiredState) === normalized(userText)) : undefined;
  const intention = exact ?? active[0];
  if (!intention) {
    log.info("Host-agent project evidence had no active user Intention to receive a handoff");
    return [];
  }

  const failedTools = failedToolNames(messages);
  const store = new WorkHandoffStore(resolveWorkHandoffStorePath(egoPath));
  const handoffs: WorkHandoff[] = [];
  for (const context of projectContexts) {
    handoffs.push(await store.upsert({
      intentionId: intention.id,
      objective: intention.desiredState,
      targetProjectRoot: context.root,
      sessionKey,
      phase: choosePhase(context, failedTools),
      acceptanceCriteria: intention.evidenceNeeded,
      observedFiles: context.observedFiles,
      modifiedFiles: context.modifiedFiles,
      verificationCommands: context.verificationCommands,
      failedTools,
    }));
  }
  log.info(`Recorded ${handoffs.length} host-agent work handoff(s) for Intention ${intention.id}`);
  return handoffs;
}
