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

  return [...selected.values()]
    .sort((a, b) => (b.id === stimulusMemoryId ? 1 : 0) - (a.id === stimulusMemoryId ? 1 : 0) || b.timestamp - a.timestamp)
    .slice(0, maxSize)
    .map(memoryToTrace);
}
