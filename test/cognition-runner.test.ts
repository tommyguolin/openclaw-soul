import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ActivationStore } from "../src/cognition/activation-store.js";
import { CognitiveJournal } from "../src/cognition/cognitive-journal.js";
import { CognitionRunner } from "../src/cognition/runner.js";
import type { EgoState, SoulMemory } from "../src/types.js";
import { ThoughtService } from "../src/thought-service.js";
import { inferCognitiveKind } from "../src/cognition/kind.js";
import { runCognitionLab } from "../src/cognition/lab.js";
import { emergeFromWorkspace } from "../src/cognition/emergence.js";

function memory(id: string, content: string, timestamp = 1): SoulMemory {
  return { id, type: "interaction", content, emotion: 0, valence: "neutral", importance: 0.8,
    timestamp, tags: ["conversation", "inbound"] };
}

test("observer runner persists deterministic state and journal without changing ego", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-"));
  const activationPath = path.join(dir, "activation-state.json");
  const journalPath = path.join(dir, "cognitive-cycles.jsonl");
  const runner = new CognitionRunner({
    store: new ActivationStore(activationPath),
    journal: new CognitiveJournal(journalPath),
    now: () => 1000,
    random: () => 1,
    config: { hardDominantThreshold: 0.6 },
  });
  const ego = { memories: [memory("m1", "embedding timeout on a long request", 100)] } as EgoState;
  const before = JSON.stringify(ego);
  runner.enqueueStimulus({ type: "interaction", sourceId: "m1", timestamp: 100 });
  const result = await runner.run(ego);
  assert.ok(result);
  assert.equal(result.workspace.items[0]?.trace.sourceId, "m1");
  assert.equal(JSON.stringify(ego), before);
  assert.equal((await new ActivationStore(activationPath).load(1000)).states.length, 1);
  const lines = (await fs.promises.readFile(journalPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).mode, "observe");
});

test("corrupt activation state is isolated and recovers empty", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-corrupt-"));
  const file = path.join(dir, "activation-state.json");
  await fs.promises.writeFile(file, "not json");
  const loaded = await new ActivationStore(file).load(1234);
  assert.deepEqual(loaded.states, []);
  const entries = await fs.promises.readdir(dir);
  assert.ok(entries.some((name) => name.startsWith("activation-state.json.corrupt-")));
});

test("activation store retains a future refractory record even after activation and fatigue reach zero", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-refractory-store-"));
  const file = path.join(dir, "activation-state.json");
  const store = new ActivationStore(file);
  await store.save([{ traceId: "memory:a", activation: 0, fatigue: 0, lastUpdatedAt: 100,
    activationCount: 1, consumedCount: 1, lastConsumedAt: 100, refractoryUntil: 10_000 }], 100);
  const loaded = await store.load(200);
  assert.equal(loaded.states[0]?.refractoryUntil, 10_000);
});

test("ThoughtService observe mode queues only persisted inbound interactions", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-service-"));
  const egoPath = path.join(dir, "ego.json");
  const service = new ThoughtService({ storePath: egoPath, cognitionMode: "observe" });
  await service.recordInteractionWithText({ type: "inbound", text: "embedding timeout appears on long requests", messageId: "in-1" });
  await service.recordInteractionWithText({ type: "inbound", text: "embedding timeout appears on long requests", messageId: "in-1" });
  await service.recordInteractionWithText({ type: "outbound", text: "I will inspect the evidence", messageId: "out-1" });
  const internals = service as unknown as { runCognitionObserverIfEnabled(): Promise<void> };
  await internals.runCognitionObserverIfEnabled();
  const state = JSON.parse(await fs.promises.readFile(path.join(dir, "activation-state.json"), "utf8"));
  const records = (await fs.promises.readFile(path.join(dir, "cognitive-cycles.jsonl"), "utf8")).trim().split("\n");
  assert.ok(state.states.length >= 1);
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(records[0]).stimulus.type, "interaction");
});

test("legacy cognition mode creates no observer files", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-legacy-"));
  const service = new ThoughtService({ storePath: path.join(dir, "ego.json") });
  await service.recordInteractionWithText({ type: "inbound", text: "a sufficiently long inbound message" });
  assert.equal(fs.existsSync(path.join(dir, "activation-state.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "cognitive-cycles.jsonl")), false);
});

test("cognitive kind classification is observational and separates work from private thought", () => {
  assert.equal(inferCognitiveKind({ actionType: "analyze-problem", source: "user-interaction", triggerDetail: "bug" }), "task-continuation");
  assert.equal(inferCognitiveKind({ actionType: "search-web", source: "user-interaction", triggerDetail: "topic" }), "proactive-intention");
  assert.equal(inferCognitiveKind({ actionType: "none", source: "memory-recall", triggerDetail: "private" }), "private-thought");
});

test("resolved premises are suppressed before workspace selection", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-resolved-"));
  const runner = new CognitionRunner({
    store: new ActivationStore(path.join(dir, "activation-state.json")),
    journal: new CognitiveJournal(path.join(dir, "cognitive-cycles.jsonl")),
    now: () => 2000,
    random: () => 1,
  });
  const stale = memory("stale", "SSH access still failed and cannot connect to server", 100);
  const current = memory("current", "SSH access connected successfully and the server works now", 200);
  const state = { memories: [stale, current] } as EgoState;
  runner.enqueueStimulus({ type: "interaction", sourceId: "stale", timestamp: 100 });
  const result = await runner.run(state, { resolvedTexts: [current.content] });
  assert.ok(result);
  const staleActivation = result.record.activations.find((item) => item.sourceId === "stale");
  assert.equal(staleActivation?.resolvedSuppressed, true);
  assert.equal(result.workspace.items.some((item) => item.trace.sourceId === "stale"), false);
});

test("multilingual model semantics suppress a resolved premise without translated keyword tables", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-multilingual-resolution-"));
  const runner = new CognitionRunner({
    store: new ActivationStore(path.join(dir, "activation-state.json")),
    journal: new CognitiveJournal(path.join(dir, "cognitive-cycles.jsonl")),
    now: () => 2000,
    random: () => 1,
  });
  const stale = memory("stale-pl", "Usługa zatrzymuje się podczas synchronizacji", 100);
  stale.semanticSignals = ["problem"];
  const current = memory("current-ar", "تمت معالجة الحالة وأصبح الاتصال مستقراً", 200);
  current.semanticSignals = ["closure"];
  stale.tags.push("topic:connection-stability");
  current.tags.push("topic:connection-stability");
  const state = { memories: [stale, current] } as EgoState;
  runner.enqueueStimulus({ type: "interaction", sourceId: stale.id, timestamp: stale.timestamp });
  const result = await runner.run(state);
  assert.ok(result);
  assert.equal(result.record.activations.find((item) => item.sourceId === stale.id)?.resolvedSuppressed, true);
});

test("cognition lab reuses the production runner without mutating its Ego snapshot", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-lab-"));
  const snapshot = { memories: [
    memory("one", "embedding timeout on long input", 100),
    memory("two", "embedding input exceeded the token limit", 90),
  ] } as EgoState;
  const before = JSON.stringify(snapshot);
  const result = await runCognitionLab(snapshot, {
    outputDirectory: dir,
    stimulusIds: ["one", "two"],
    startTime: 10_000,
    random: () => 1,
  });
  assert.equal(result.records.length, 2);
  assert.equal(result.metrics.cycles, 2);
  assert.ok(result.metrics.associativeExpansionRate >= 0 && result.metrics.associativeExpansionRate <= 1);
  assert.ok(result.metrics.averageAssociativeItems >= 0);
  assert.equal(result.metrics.generatedThoughts, 0);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(fs.existsSync(path.join(dir, "activation-lab-state.json")), true);
});

test("cognition lab measures generated thought diversity, continuity, and associative safety", async () => {
  const snapshot = { memories: [
    memory("one", "A hidden boundary keeps recurring in the session state", 300),
    memory("two", "An invisible dialog retained stale interface state", 200),
    memory("three", "A quota threshold constrained queue capacity", 100),
  ] } as EgoState;
  const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-output-base-"));
  const broadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-output-broad-"));
  const generator = (item: import("../src/cognition/types.js").CognitiveWorkspace) => emergeFromWorkspace(item, async () => {
    const association = item.items.find((entry) => entry.role === "associative");
    return association
      ? `Could ${association.trace.sourceId} reveal another hidden boundary?`
      : "Could the same hidden boundary be recurring?";
  });
  const baseline = await runCognitionLab(snapshot, {
    outputDirectory: baseDir, stimulusIds: ["one", "two", "three"], startTime: 10_000,
    random: () => 1, config: { maxAssociativeItems: 0, refractoryMs: 0 }, emerge: generator,
  });
  const broad = await runCognitionLab(snapshot, {
    outputDirectory: broadDir, stimulusIds: ["one", "two", "three"], startTime: 10_000,
    random: () => 1, config: { associativeBreadth: 1, noveltySeeking: 1, inhibition: 0,
      convergencePressure: 0, maxAssociativeItems: 3, refractoryMs: 0 }, emerge: generator,
  });
  assert.ok(broad.metrics.associativeThoughtRate > baseline.metrics.associativeThoughtRate);
  assert.ok(broad.metrics.thoughtLexicalDiversity >= baseline.metrics.thoughtLexicalDiversity);
  assert.equal(broad.metrics.unverifiedAssociativeAssertionRate, 0);
  assert.ok(broad.metrics.thoughtWorkspaceLexicalContinuityRate > 0);
  assert.ok(broad.metrics.usefulAssociativeThoughtRate > 0);
});

test("idle unresolved tension eventually forms one private thought and then respects refractory silence", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-idle-emergence-"));
  let now = 0;
  const runner = new CognitionRunner({
    store: new ActivationStore(path.join(dir, "activation-state.json")),
    journal: new CognitiveJournal(path.join(dir, "cognitive-cycles.jsonl")),
    now: () => now,
    random: () => 1,
    config: { maxTemporalInput: 0, endogenousGlobalCooldownMs: 0 },
  });
  const snapshot = { memories: [memory("blocked", "The deployment remains blocked by a timeout error", -1)] } as EgoState;
  const outcomes: string[] = [];
  const origins: Array<string | undefined> = [];
  for (let minute = 0; minute < 45; minute += 1) {
    now = minute * 60_000;
    const result = await runner.run(snapshot, { mode: "shadow", emerge: async () => ({
      outcome: "thought", content: "Could the timeout be a boundary rather than a transient failure?",
      cognitiveMove: "question", qualityFlags: [],
    }) });
    if (result) {
      outcomes.push(result.record.emergence.outcome);
      if (result.workspace.allowEmergence) origins.push(result.workspace.origin);
    }
  }
  assert.equal(outcomes.filter((outcome) => outcome === "thought").length, 1);
  assert.ok(outcomes.filter((outcome) => outcome === "pre-generation-silence").length >= 40);
  assert.deepEqual(origins, ["endogenous"]);
});

test("ThoughtService shadow mode writes only the v3.1 experimental pool", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-service-shadow-"));
  const egoPath = path.join(dir, "ego.json");
  const service = new ThoughtService({ storePath: egoPath, cognitionMode: "shadow" });
  const internals = service as unknown as {
    shadowLLMGenerator: (prompt: string) => Promise<string>;
    runCognitionObserverIfEnabled(): Promise<void>;
  };
  internals.shadowLLMGenerator = async () => "Could input length be the real timeout boundary?";
  await service.recordInteractionWithText({
    type: "inbound", text: "Embedding timeout happens when the request input becomes long", messageId: "shadow-in-1",
  });
  await internals.runCognitionObserverIfEnabled();
  assert.equal(fs.existsSync(path.join(dir, "thought-pool-v31-shadow.json")), true);
  assert.equal(fs.existsSync(path.join(dir, "thought-pool.json")), false);
  const experimentalPool = JSON.parse(await fs.promises.readFile(path.join(dir, "thought-pool-v31-shadow.json"), "utf8"));
  assert.equal(experimentalPool.candidates.length, 1);
  assert.equal(experimentalPool.candidates[0].originWorkspaceId.length > 0, true);
  const state = await service.getEgoState();
  assert.equal(state.totalThoughts, 0);
  assert.equal(state.activeTasks.length, 0);
});

test("ThoughtService primary mode routes private cognition into the real pool and private Attention", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-service-primary-"));
  const egoPath = path.join(dir, "ego.json");
  const service = new ThoughtService({ storePath: egoPath, cognitionMode: "primary" });
  const internals = service as unknown as {
    shadowLLMGenerator: (prompt: string) => Promise<string>;
    runCognitionObserverIfEnabled(): Promise<void>;
    maybeAttendThoughtPoolCandidate(): Promise<void>;
  };
  internals.shadowLLMGenerator = async () => "Could input length be the real timeout boundary?";
  await service.recordInteractionWithText({
    type: "inbound", text: "Embedding timeout happens when the request input becomes long", messageId: "primary-in-1",
  });
  await internals.runCognitionObserverIfEnabled();
  await service.recordInteractionWithText({
    type: "inbound", text: "A second long embedding input produced the same timeout", messageId: "primary-in-2",
  });
  await internals.runCognitionObserverIfEnabled();
  assert.equal(fs.existsSync(path.join(dir, "thought-pool.json")), true);
  assert.equal(fs.existsSync(path.join(dir, "thought-pool-v31-shadow.json")), false);
  const beforeAttention = JSON.parse(await fs.promises.readFile(path.join(dir, "thought-pool.json"), "utf8"));
  assert.equal(beforeAttention.candidates[0].state, "incubating");
  const episodes = JSON.parse(await fs.promises.readFile(path.join(dir, "thought-episodes.json"), "utf8"));
  assert.equal(episodes.episodes.length, 1);
  assert.equal(beforeAttention.candidates[0].thoughtEpisodeId, episodes.episodes[0].id);
  const cognitiveCycles = (await fs.promises.readFile(path.join(dir, "cognitive-cycles.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(cognitiveCycles.every((cycle) => cycle.mode === "primary"), true);
  await internals.maybeAttendThoughtPoolCandidate();
  const afterAttention = JSON.parse(await fs.promises.readFile(path.join(dir, "thought-pool.json"), "utf8"));
  assert.equal(afterAttention.candidates[0].state, "attended");
  const state = await service.getEgoState();
  assert.equal(state.totalThoughts, 1);
  assert.equal(state.activeTasks.length, 0);
});
