import assert from "node:assert/strict";
import test from "node:test";
import type { EgoState, SoulMemory } from "../src/types.js";
import { buildActiveSet } from "../src/cognition/active-set.js";
import { updateActivations } from "../src/cognition/activation-engine.js";
import { buildCognitiveWorkspace, consumeWorkspace } from "../src/cognition/workspace.js";

function memory(id: string, content: string, timestamp = 1): SoulMemory {
  return { id, type: "interaction", content, emotion: 0, valence: "neutral", importance: 0.8,
    timestamp, tags: ["conversation", "inbound"] };
}

function ego(memories: SoulMemory[]): EgoState {
  return { memories } as EgoState;
}

test("new interaction activates itself and semantically related memories", () => {
  const memories = [
    memory("new", "embedding timeout happens for long input requests", 3),
    memory("related", "the embedding request exceeded the token input limit", 2),
    memory("other", "the user likes landscape photography", 1),
  ];
  const traces = buildActiveSet(ego(memories), new Map(), "new");
  const results = updateActivations({ traces, states: new Map(), stimulusTraceId: "memory:new", now: 10,
    random: () => 1 });
  const own = results.find((item) => item.trace.sourceId === "new")!;
  const related = results.find((item) => item.trace.sourceId === "related")!;
  const other = results.find((item) => item.trace.sourceId === "other")!;
  assert.equal(own.state.activation, 0.72);
  assert.ok(related.state.activation > other.state.activation);
  assert.equal(related.contributions[0]?.mechanism, "semantic-similarity");
});

test("activation decays and workspace consumption applies fatigue and refractory period", () => {
  const traces = buildActiveSet(ego([memory("a", "one strong current concern")]), new Map(), "a");
  const first = updateActivations({ traces, states: new Map(), stimulusTraceId: "memory:a", now: 0,
    random: () => 1, config: { hardDominantThreshold: 0.6 } });
  const workspace = buildCognitiveWorkspace(first, 0, "a", { hardDominantThreshold: 0.6 });
  assert.equal(workspace.allowEmergence, true);
  consumeWorkspace(workspace, first, 0);
  assert.equal(first[0].state.fatigue, 0.15);
  assert.ok((first[0].state.refractoryUntil ?? 0) > 0);
  const states = new Map(first.map((item) => [item.trace.id, item.state]));
  const second = updateActivations({ traces, states, now: 30 * 60 * 1000, random: () => 1 });
  assert.ok(second[0].state.activation < 0.72);
});

test("workspace records pre-generation silence for diffuse weak activation", () => {
  const traces = buildActiveSet(ego([
    memory("a", "photography composition", 2),
    memory("b", "database migration", 1),
  ]), new Map());
  const results = updateActivations({ traces, states: new Map(), now: 10, random: () => 1 });
  const workspace = buildCognitiveWorkspace(results, 10);
  assert.equal(workspace.allowEmergence, false);
  assert.equal(workspace.silenceReason, "insufficient-activation-structure");
});
