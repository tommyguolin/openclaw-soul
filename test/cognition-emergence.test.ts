import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWorkspaceEmergencePrompt, emergeFromWorkspace } from "../src/cognition/emergence.js";
import { ActivationStore } from "../src/cognition/activation-store.js";
import { CognitiveJournal } from "../src/cognition/cognitive-journal.js";
import { CognitionRunner } from "../src/cognition/runner.js";
import type { CognitiveWorkspace } from "../src/cognition/types.js";
import type { EgoState, SoulMemory } from "../src/types.js";

function workspace(allowEmergence = true): CognitiveWorkspace {
  return {
    id: "w1", createdAt: 1, stimulusId: "m1", distribution: "single-dominant", relations: [],
    aggregateActivation: allowEmergence ? 0.8 : 0, allowEmergence,
    ...(allowEmergence ? {} : { silenceReason: "insufficient-activation-structure" }),
    items: allowEmergence ? [{
      trace: { id: "memory:m1", sourceType: "interaction", sourceId: "m1",
        content: "The timeout only appears when embedding inputs are long.", provenance: "user",
        topicClusters: ["software"], timestamp: 1, importance: 0.8 },
      activation: 0.8, fatigue: 0, contributions: [], selectionReason: "highest activation",
    }] : [],
  };
}

test("workspace prompt allows a complete main-conversation-quality thought", () => {
  const prompt = buildWorkspaceEmergencePrompt(workspace());
  assert.match(prompt, /private attention/i);
  assert.doesNotMatch(prompt, /preferred move|cognitive move|actionType/i);
  assert.match(prompt, /same depth and completeness as a response in the main conversation/i);
  assert.match(prompt, /no sentence, word, or character limit/i);
});

test("workspace emergence accepts thought and NO_THOUGHT without external behavior", async () => {
  let calls = 0;
  const thought = await emergeFromWorkspace(workspace(), async () => {
    calls += 1;
    return "Maybe input length is the hidden boundary behind the timeout.";
  });
  assert.equal(thought.outcome, "thought");
  if (thought.outcome === "thought") assert.equal(thought.cognitiveMove, "speculation");
  const silence = await emergeFromWorkspace(workspace(), async () => "NO_THOUGHT");
  assert.deepEqual(silence, { outcome: "silence", reason: "model-no-thought" });
  assert.equal(calls, 1);
});

test("workspace emergence preserves long thoughts without truncation", async () => {
  const longThought = "完整分析。".repeat(180);
  const result = await emergeFromWorkspace(workspace(), async () => JSON.stringify({
    thought: longThought,
    cognitiveMove: "reflection",
    qualityFlags: [],
  }));
  assert.equal(result.outcome, "thought");
  if (result.outcome === "thought") assert.equal(result.content, longThought);
});

test("pre-generation silence never calls the emergence model", async () => {
  let calls = 0;
  const result = await emergeFromWorkspace(workspace(false), async () => {
    calls += 1;
    return "should not happen";
  });
  assert.deepEqual(result, { outcome: "silence", reason: "pre-generation" });
  assert.equal(calls, 0);
});

function memory(id: string, content: string): SoulMemory {
  return { id, type: "interaction", content, emotion: 0, valence: "neutral", importance: 0.8,
    timestamp: 1, tags: ["conversation", "inbound"] };
}

test("shadow runner journals private emergence but writes no Thought Pool", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-cognition-shadow-"));
  const runner = new CognitionRunner({
    store: new ActivationStore(path.join(dir, "activation-state.json")),
    journal: new CognitiveJournal(path.join(dir, "cognitive-cycles.jsonl")),
    now: () => 1000,
    random: () => 1,
    config: { hardDominantThreshold: 0.6 },
  });
  runner.enqueueStimulus({ type: "interaction", sourceId: "m1", timestamp: 1 });
  const ego = { memories: [memory("m1", "Embedding timeout appears on long input requests")] } as EgoState;
  const result = await runner.run(ego, {
    mode: "shadow",
    emerge: (item) => emergeFromWorkspace(item, async () => "The input boundary may be more important than retry timing."),
  });
  assert.equal(result?.record.mode, "shadow");
  assert.equal(result?.record.emergence.outcome, "thought");
  assert.equal(fs.existsSync(path.join(dir, "thought-pool.json")), false);
});
