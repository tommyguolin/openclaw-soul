import assert from "node:assert/strict";
import test from "node:test";
import { expandCognitiveWorkspace, temperamentActivationConfig } from "../src/cognition/associative-expansion.js";
import { emergeFromWorkspace } from "../src/cognition/emergence.js";
import type { ActivationResult, CognitiveTrace, CognitiveWorkspace } from "../src/cognition/types.js";

function trace(id: string, content: string, timestamp = 1): CognitiveTrace {
  return { id: `memory:${id}`, sourceId: id, sourceType: "memory", content, provenance: "user",
    topicClusters: [], timestamp, importance: 0.8 };
}

function result(item: CognitiveTrace, consumedCount = 0): ActivationResult {
  const state = { traceId: item.id, activation: 0.2, fatigue: consumedCount > 0 ? 0.4 : 0,
    lastUpdatedAt: 1, activationCount: 1, consumedCount };
  return { trace: item, previous: state, state, contributions: [], resolvedSuppressed: false };
}

function workspace(core: CognitiveTrace, allowEmergence = true): CognitiveWorkspace {
  return { id: "w1", createdAt: 10_000, stimulusId: core.sourceId, distribution: "single-dominant",
    relations: [], aggregateActivation: allowEmergence ? 0.8 : 0, allowEmergence,
    items: allowEmergence ? [{ trace: core, activation: 0.8, fatigue: 0, contributions: [],
      selectionReason: "highest activation", role: "core" }] : [] };
}

test("broad associative temperament adds diverse but structurally bridged materials with lineage", () => {
  const core = trace("core", "A hidden boundary keeps recurring in how this system behaves");
  const candidates = [
    trace("gui", "An invisible dialog retained stale UI state", 2),
    trace("quota", "A capacity threshold constrained the queue", 3),
    trace("habit", "A periodic habit loop returned every evening", 4),
    trace("remote", "Landscape photography uses warm sunset colors", 5),
  ];
  const expanded = expandCognitiveWorkspace(workspace(core), [result(core), ...candidates.map((item) => result(item))], {
    associativeBreadth: 1, noveltySeeking: 0.8, inhibition: 0, convergencePressure: 0, maxAssociativeItems: 3,
  });
  const associative = expanded.items.filter((item) => item.role === "associative");
  assert.equal(expanded.expansion?.mode, "broad");
  assert.ok(associative.length >= 2 && associative.length <= 3);
  assert.equal(associative.some((item) => item.trace.sourceId === "remote"), false);
  assert.ok(associative.every((item) => item.association?.sourceTraceId === core.id));
  assert.ok(associative.every((item) => item.association?.exploratory));
});

test("temperament presets change breadth without bypassing contextual convergence", () => {
  const focused = temperamentActivationConfig("focused");
  const balanced = temperamentActivationConfig("balanced");
  const expansive = temperamentActivationConfig("expansive");
  assert.ok((focused.associativeBreadth ?? 0) < (balanced.associativeBreadth ?? 0));
  assert.ok((balanced.associativeBreadth ?? 0) < (expansive.associativeBreadth ?? 0));
  assert.ok((focused.inhibition ?? 0) > (expansive.inhibition ?? 0));
});

test("model topic concepts bridge associations across languages", () => {
  const core = { ...trace("german", "Die Sitzung verliert nach dem Neustart ihren Verlauf"),
    topicClusters: ["topic:session-continuity"] };
  const candidate = { ...trace("arabic", "يختفي سياق المحادثة عند بدء قناة جديدة"),
    topicClusters: ["topic:session-continuity"] };
  const expanded = expandCognitiveWorkspace(workspace(core), [result(core), result(candidate)], {
    associativeBreadth: 1, noveltySeeking: 1, inhibition: 0, maxAssociativeItems: 2,
  });
  const association = expanded.items.find((item) => item.role === "associative");
  assert.equal(association?.trace.sourceId, "arabic");
  assert.ok(association?.association?.bridgeLabels.includes("topic:session-continuity"));
});

test("troubleshooting converges while stagnation broadens non-task thought", () => {
  const troubleshooting = trace("bug", "A timeout error keeps failing after every retry");
  const staleReflection = trace("reflection", "A hidden boundary keeps recurring in how I interpret this pattern");
  const candidates = [
    trace("old-1", "A stale invisible state repeatedly returned"),
    trace("old-2", "A quota threshold created a hard limit"),
    trace("old-3", "A periodic loop recurred each day"),
  ];
  const config = { associativeBreadth: 0.7, noveltySeeking: 0.7, inhibition: 0,
    convergencePressure: 1, persistence: 1, maxAssociativeItems: 3 };
  const narrow = expandCognitiveWorkspace(workspace(troubleshooting),
    [result(troubleshooting, 4), ...candidates.map((item) => result(item))], config);
  const fresh = expandCognitiveWorkspace(workspace(staleReflection),
    [result(staleReflection), ...candidates.map((item) => result(item))], config);
  const stagnant = expandCognitiveWorkspace(workspace(staleReflection),
    [result(staleReflection, 4), ...candidates.map((item) => result(item))], config);
  assert.equal(narrow.expansion?.mode, "narrow");
  assert.ok((narrow.expansion?.added ?? 0) <= 1);
  assert.ok((stagnant.expansion?.effectiveBreadth ?? 0) > (fresh.expansion?.effectiveBreadth ?? 0));
  assert.ok((stagnant.expansion?.added ?? 0) >= (fresh.expansion?.added ?? 0));
});

test("association cannot create a workspace from silence", () => {
  const core = trace("core", "A hidden boundary recurs");
  const silent = workspace(core, false);
  const expanded = expandCognitiveWorkspace(silent, [result(core)], { associativeBreadth: 1 });
  assert.equal(expanded.allowEmergence, false);
  assert.equal(expanded.items.length, 0);
  assert.equal(expanded.expansion, undefined);
});

test("expansion rejects near-paraphrase and prior assistant reply echo", () => {
  const core = trace("core", "You should restart, edit, and test it yourself");
  const paraphrase = trace("duplicate", "Please edit, test, and restart it yourself");
  const assistant = { ...trace("assistant", "I restarted it and changed the configuration"),
    sourceType: "interaction" as const, provenance: "system" as const };
  const remote = trace("remote", "A lifecycle race appeared after startup ordering changed");
  const expanded = expandCognitiveWorkspace(workspace(core),
    [result(core), result(paraphrase), result(assistant), result(remote)], {
      associativeBreadth: 1, noveltySeeking: 1, inhibition: 0, maxAssociativeItems: 3,
    });
  const ids = expanded.items.filter((item) => item.role === "associative").map((item) => item.trace.sourceId);
  assert.equal(ids.includes("duplicate"), false);
  assert.equal(ids.includes("assistant"), false);
});

test("an unsupported associative claim is flagged while a question remains incubatable", async () => {
  const core = trace("core", "A hidden boundary keeps recurring");
  const candidate = trace("candidate", "An invisible UI state stayed stale");
  const expanded = expandCognitiveWorkspace(workspace(core), [result(core), result(candidate)], {
    associativeBreadth: 1, inhibition: 0,
  });
  const claim = await emergeFromWorkspace(expanded, async () => "The UI state proves the same boundary causes this behavior.");
  assert.equal(claim.outcome, "thought");
  if (claim.outcome === "thought") assert.ok(claim.qualityFlags.includes("association-unverified"));
  const question = await emergeFromWorkspace(expanded, async () => "Could both cases involve an unobserved state boundary?");
  assert.equal(question.outcome, "thought");
  if (question.outcome === "thought") assert.equal(question.qualityFlags.includes("association-unverified"), false);
});

test("workspace emergence uses the model's language-independent cognitive assessment", async () => {
  const core = trace("german-thought", "Die Verbindung verhält sich nach jedem Neustart anders");
  const generated = await emergeFromWorkspace(workspace(core), async () => JSON.stringify({
    thought: "Warum verändert sich die Verbindung nach jedem Neustart?",
    cognitiveMove: "question",
    qualityFlags: [],
  }));
  assert.equal(generated.outcome, "thought");
  if (generated.outcome === "thought") {
    assert.equal(generated.cognitiveMove, "question");
    assert.deepEqual(generated.qualityFlags, []);
  }
});
