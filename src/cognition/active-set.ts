import { createHash } from "node:crypto";
import { contentTokens, jaccard, memoryTopicClusters } from "../thought-emergence.js";
import type { EgoState, SoulMemory } from "../types.js";
import type { CognitiveTrace, TraceActivationState } from "./types.js";

function provenance(memory: SoulMemory): CognitiveTrace["provenance"] {
  if (memory.type === "interaction" && memory.tags.includes("inbound")) return "user";
  if (memory.evidenceKind === "web" || memory.evidenceKind === "user" || memory.evidenceKind === "tool" || memory.evidenceKind === "model") {
    return memory.evidenceKind;
  }
  return "system";
}

function isInternalModelTranscript(memory: SoulMemory): boolean {
  return memory.type === "interaction"
    && memory.tags.includes("outbound")
    && memory.sourceChannel === "openai"
    && /^agent:[^:]+:openai:[^:]+$/i.test(memory.sourceConversationId ?? "");
}

export function memoryToTrace(memory: SoulMemory): CognitiveTrace {
  return {
    id: `memory:${memory.id}`,
    sourceType: memory.type === "interaction" ? "interaction" : "memory",
    sourceId: memory.id,
    content: memory.content,
    provenance: provenance(memory),
    topicClusters: memoryTopicClusters(memory),
    timestamp: memory.timestamp,
    importance: Math.max(0, Math.min(1, memory.importance > 1 ? memory.importance / 100 : memory.importance)),
    memory,
  };
}

export interface ActiveSetOptions {
  maxSize?: number;
  recentLimit?: number;
  relatedLimit?: number;
}

function contextTrace(
  kind: "residue" | "background" | "environment" | "echo",
  content: string,
  ego: EgoState,
): CognitiveTrace {
  const digest = createHash("sha256").update(`${kind}:${content}`).digest("hex").slice(0, 16);
  return {
    id: `context:${kind}:${digest}`,
    sourceType: kind === "environment" ? "environment" : "tension",
    sourceId: `mental-context:${kind}:${digest}`,
    content,
    provenance: "system",
    topicClusters: memoryTopicClusters({ content, tags: [kind] }),
    timestamp: ego.mentalContext?.updatedAt || ego.lastInteractionTime || ego.birthTime,
    importance: kind === "residue" ? 0.8 : kind === "background" ? 0.65 : 0.5,
  };
}

const CONTEXT_TASK_DIRECTIVE = /(?:请|你|自己).{0,24}(?:修改|重启|测试|执行|实现|优化|分析代码|配置|设置)|\b(?:please|you should|restart|edit|test|implement|optimi[sz](?:e|ed|ing)|improv(?:e|ed|ing)|fix(?:ed|ing)?|configur(?:e|ed|ing)|set|apply|run|execute)\b/i;

function isUsableMentalContext(content: string, ego: EgoState): boolean {
  const trimmed = content.trim();
  if (contentTokens(trimmed).length < 3) return false;
  const tokens = contentTokens(trimmed);
  const semanticDirective = ego.memories.some((memory) =>
    memory.semanticSignals?.includes("execution-directive")
      && jaccard(tokens, contentTokens(memory.content)) >= 0.45);
  // The semantic link is the primary path. The regex only cleans legacy
  // context written before multilingual semantic labels were persisted.
  if (semanticDirective || CONTEXT_TASK_DIRECTIVE.test(trimmed)) return false;
  // Topic labels are indexing residue, not a proposition or unresolved tension.
  if (/^[\p{L}\p{N}_-]+(?:\s*,\s*[\p{L}\p{N}_-]+)+$/u.test(trimmed)) return false;
  if ((ego.projectContexts ?? []).some((project) => {
    const normalized = project.root.replace(/\\/g, "/").toLocaleLowerCase();
    const mentioned = trimmed.replace(/\\/g, "/").toLocaleLowerCase();
    const drive = normalized.match(/^[a-z]:/)?.[0];
    const driveLetter = drive?.[0];
    return mentioned.includes(normalized) || (!!drive && mentioned.includes(drive))
      || (!!driveLetter && new RegExp(`\\b${driveLetter}\\s*[:/\\\\]`, "i").test(mentioned));
  })) return false;
  return true;
}

export function buildActiveSet(
  ego: EgoState,
  states: ReadonlyMap<string, TraceActivationState>,
  stimulusMemoryId?: string,
  options: ActiveSetOptions = {},
): CognitiveTrace[] {
  const maxSize = options.maxSize ?? 120;
  const usable = ego.memories.filter((memory) => memory.content.trim().length >= 5 && !isInternalModelTranscript(memory));
  const byId = new Map(usable.map((memory) => [memory.id, memory]));
  const selected = new Map<string, SoulMemory>();
  const add = (memory: SoulMemory | undefined) => { if (memory) selected.set(memory.id, memory); };

  [...usable].sort((a, b) => b.timestamp - a.timestamp).slice(0, options.recentLimit ?? 50).forEach(add);
  const stimulus = stimulusMemoryId ? byId.get(stimulusMemoryId) : undefined;
  add(stimulus);
  if (stimulus) {
    const tokens = contentTokens(`${stimulus.content} ${stimulus.tags.join(" ")}`);
    usable
      .filter((memory) => memory.id !== stimulus.id)
      .map((memory) => ({ memory, score: jaccard(tokens, contentTokens(`${memory.content} ${memory.tags.join(" ")}`)) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.timestamp - a.memory.timestamp)
      .slice(0, options.relatedLimit ?? 30)
      .forEach((entry) => add(entry.memory));
  }
  for (const state of states.values()) {
    if (state.activation < 0.05) continue;
    const sourceId = state.traceId.startsWith("memory:") ? state.traceId.slice(7) : state.traceId;
    add(byId.get(sourceId));
  }

  const memoryTraces = [...selected.values()]
    .sort((a, b) => (b.id === stimulusMemoryId ? 1 : 0) - (a.id === stimulusMemoryId ? 1 : 0) || b.timestamp - a.timestamp)
    .slice(0, maxSize)
    .map(memoryToTrace);
  const mental = ego.mentalContext ?? {
    residue: [], backgroundConcerns: [], environmentalChanges: [], associativeEcho: [],
  };
  const contextTraces = [
    ...mental.residue.slice(0, 8).map((content) => contextTrace("residue", content, ego)),
    ...mental.backgroundConcerns.slice(0, 6).map((content) => contextTrace("background", content, ego)),
    ...mental.environmentalChanges.slice(0, 4).map((content) => contextTrace("environment", content, ego)),
    ...mental.associativeEcho.slice(0, 4).map((content) => contextTrace("echo", content, ego)),
  ].filter((trace) => isUsableMentalContext(trace.content, ego));
  return [...memoryTraces, ...contextTraces]
    .filter((trace, index, all) => all.findIndex((item) => item.id === trace.id) === index)
    .slice(0, maxSize);
}
