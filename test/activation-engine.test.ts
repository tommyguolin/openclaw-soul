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
  assert.equal(workspace.origin, "external");
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

test("an unresolved trace accumulates endogenous activation across idle cycles", () => {
  const traces = buildActiveSet(ego([memory("stuck", "The deployment remains blocked by a timeout error")]), new Map());
  let states = new Map();
  let latest = updateActivations({ traces, states, now: 0, random: () => 1,
    config: { maxTemporalInput: 0 } });
  for (let minute = 1; minute < 22; minute += 1) {
    states = new Map(latest.map((item) => [item.trace.id, item.state]));
    latest = updateActivations({ traces, states, now: minute * 60_000, random: () => 1,
      config: { maxTemporalInput: 0 } });
  }
  assert.ok(latest[0].state.activation >= 0.68);
  assert.ok(latest[0].contributions.some((item) =>
    item.channel === "persistent-state" && item.mechanism === "unresolved-state"));
});

test("ordinary low-importance memories remain silent without a stimulus", () => {
  const traces = buildActiveSet(ego([memory("ordinary", "Landscape photography at sunset")]), new Map());
  let states = new Map();
  let latest = updateActivations({ traces, states, now: 0, random: () => 1 });
  for (let minute = 1; minute < 60; minute += 1) {
    states = new Map(latest.map((item) => [item.trace.id, item.state]));
    latest = updateActivations({ traces, states, now: minute * 60_000, random: () => 1 });
  }
  assert.equal(latest[0].state.activation, 0);
  assert.equal(buildCognitiveWorkspace(latest, 60 * 60_000).allowEmergence, false);
});

test("recent consumption enforces a global endogenous cooldown", () => {
  const traces = buildActiveSet(ego([memory("stuck", "The deployment remains blocked by a timeout error")]), new Map());
  const state = { traceId: traces[0].id, activation: 0, fatigue: 0, lastUpdatedAt: 0,
    lastConsumedAt: 1, activationCount: 1, consumedCount: 1 };
  const result = updateActivations({ traces, states: new Map([[state.traceId, state]]), now: 60 * 60_000,
    random: () => 1 });
  assert.equal(result[0].contributions.some((item) => item.channel === "persistent-state"), false);
  assert.equal(result[0].state.activation, 0);
});

test("resolved endogenous tension is suppressed rather than resurfaced", () => {
  const traces = buildActiveSet(ego([memory("fixed", "The deployment remains blocked by a timeout error")]), new Map());
  const result = updateActivations({ traces, states: new Map(), now: 1, random: () => 1,
    resolvedTraceIds: new Set([traces[0].id]) });
  assert.equal(result[0].resolvedSuppressed, true);
  assert.equal(result[0].state.activation, 0);
});

test("model semantic signals drive endogenous filtering independent of user language", () => {
  const polish = memory("problem-pl", "Wdrożenie nadal zatrzymuje się podczas synchronizacji");
  polish.semanticSignals = ["problem"];
  const arabic = memory("directive-ar", "راجع إعدادات الخدمة ثم أعد تشغيلها");
  arabic.semanticSignals = ["execution-directive"];
  const traces = buildActiveSet(ego([polish, arabic]), new Map());
  const results = updateActivations({ traces, states: new Map(), now: 10, random: () => 1,
    config: { maxTemporalInput: 0, maxRecurrenceInput: 0 } });
  const problem = results.find((item) => item.trace.sourceId === polish.id)!;
  const directive = results.find((item) => item.trace.sourceId === arabic.id)!;
  assert.equal(problem.contributions.some((item) => item.mechanism === "unresolved-state"), true);
  assert.equal(directive.contributions.length, 0);
});

test("associative echoes remain supporting material and cannot drive endogenous activation", () => {
  const state = { memories: [], mentalContext: {
    foreground: [], residue: [], backgroundConcerns: [], environmentalChanges: [],
    associativeEcho: ["能不能直接读到 K 盘上的项目？我想确认那里的代码是否真的可见。"], updatedAt: 1,
  } } as unknown as EgoState;
  const traces = buildActiveSet(state, new Map());
  assert.equal(traces.length, 1);
  const result = updateActivations({ traces, states: new Map(), now: 24 * 60 * 60_000,
    random: () => 0, config: { stochasticRecallProbability: 1 } });
  assert.equal(result[0].contributions.length, 0);
  assert.equal(result[0].state.activation, 0);
});

test("mental context keeps tensions and preferences but excludes label residue and task directives", () => {
  const directive = memory("directive-de", "Überarbeite das Plugin und starte anschließend den Dienst neu");
  directive.semanticSignals = ["execution-directive"];
  const state = { memories: [directive], projectContexts: [{ root: "K:\\test_code\\openclaw-soul" }], mentalContext: {
    foreground: [],
    residue: ["testing, project-management, optimization", "The reliability question remains unresolved",
      "能不能直接读取 K:\\test_code 上的项目？我想确认代码是否可见。",
      "Überarbeite das Plugin und starte anschließend den Dienst neu"],
    backgroundConcerns: [
      "User wants OpenClaw configured and improved automatically",
      "User prefers concrete usefulness over abstract product discussion",
    ],
    environmentalChanges: [], associativeEcho: [], updatedAt: 1,
  } } as unknown as EgoState;
  const traces = buildActiveSet(state, new Map());
  const contextTraces = traces.filter((item) => item.id.startsWith("context:"));
  assert.equal(contextTraces.some((item) => item.content.includes("testing, project-management")), false);
  assert.equal(contextTraces.some((item) => item.content.includes("configured and improved")), false);
  assert.equal(contextTraces.some((item) => item.content.includes("代码是否可见")), false);
  assert.equal(contextTraces.some((item) => item.content.includes("Überarbeite")), false);
  assert.equal(contextTraces.some((item) => item.content.includes("remains unresolved")), true);
  assert.equal(contextTraces.some((item) => item.content.includes("concrete usefulness")), true);
});
