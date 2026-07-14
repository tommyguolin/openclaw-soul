import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultEgoState } from "../src/ego-store.js";
import {
  classifyCognitiveMove,
  classifyThoughtQualityFlags,
  contentTokens,
  memoryTopicClusters,
  parseSpontaneousResponse,
  runThoughtLab,
  selectRemoteMemoryPair,
} from "../src/thought-lab.js";
import type { SoulMemory } from "../src/types.js";

function memory(id: string, content: string, timestamp: number, tags: string[] = []): SoulMemory {
  return {
    id,
    content,
    timestamp,
    tags,
    type: "insight",
    emotion: 0,
    valence: "neutral",
    importance: 50,
  };
}

test("contentTokens supports English and CJK content", () => {
  const tokens = contentTokens("Database timeout 与隐藏状态不一致");
  assert(tokens.includes("database"));
  assert(tokens.includes("timeout"));
  assert(tokens.some((token) => token === "隐藏"));
});

test("contentTokens is script-neutral for European and non-Latin languages", () => {
  const tokens = contentTokens("Überprüfung соединения stratégie Ελληνικά");
  assert(tokens.includes("überprüfung"));
  assert(tokens.includes("соединения"));
  assert(tokens.includes("stratégie"));
  assert(tokens.includes("ελληνικά"));
});

test("model topic tags create language-independent topic clusters", () => {
  const clusters = memoryTopicClusters({
    content: "Łączność pozostaje niestabilna po ponownym uruchomieniu",
    tags: ["topic:connection-reliability"],
  });
  assert.ok(clusters.includes("topic:connection-reliability"));
});

test("classifyCognitiveMove labels questions before generic reflection", () => {
  assert.equal(classifyCognitiveMove("这两个现象为什么会有相同结构？"), "question");
  assert.equal(classifyCognitiveMove("它现在更像实验，还是已经接近可交付产品。"), "question");
  assert.equal(classifyCognitiveMove("This reminds me of the same hidden-state pattern."), "analogy");
});

test("thought quality flags expose experimental framing and usefulness pressure", () => {
  const flags = classifyThoughtQualityFlags("The two fragments suggest I should help the user search for an answer.");
  assert(flags.includes("meta-framing"));
  assert(flags.includes("task-pressure"));
});

test("thought quality flags catch forced associations", () => {
  const flags = classifyThoughtQualityFlags(
    "The clientOrderId guard reminds me of a lock; the five-question cap feels like a separate quota wall. Both signal that some systems demand a unique token.",
  );
  assert(flags.includes("forced-association"));
});

test("structured spontaneous assessment does not depend on output language keywords", () => {
  const parsed = parseSpontaneousResponse(JSON.stringify({
    thought: "Vielleicht teilen beide Ereignisse dieselbe unsichtbare Grenze.",
    cognitiveMove: "analogy",
    qualityFlags: [],
  }));
  assert.equal(parsed.cognitiveMove, "analogy");
  assert.deepEqual(parsed.qualityFlags, []);
});

test("remote memory selection prefers a low-overlap second memory", () => {
  const now = Date.now();
  const memories = [
    memory("old", "Bitcoin trading strategy backtest", now - 20 * 86400000, ["bitcoin"]),
    memory("near", "Bitcoin strategy risk and trading", now - 10 * 86400000, ["bitcoin"]),
    memory("far", "A hidden GUI dialog made observed state differ from internal state", now - 2 * 86400000, ["gui"]),
  ];
  const selected = selectRemoteMemoryPair(memories, () => 0, now);
  assert.equal(selected[0]?.id, "old");
  assert.equal(selected[1]?.id, "far");
  assert(memoryTopicClusters(memories[0]).includes("trading"));
  assert(memoryTopicClusters(memories[2]).includes("interface"));
});

test("remote memory selection rotates away from already activated seeds", () => {
  const now = Date.now();
  const memories = [
    memory("used", "Bitcoin strategy backtest", now - 30 * 86400000, ["bitcoin"]),
    memory("fresh", "A hidden GUI window retained stale state", now - 20 * 86400000, ["gui"]),
    memory("other", "An LLM prompt produced a surprising analogy", now - 10 * 86400000, ["ai"]),
  ];
  const selected = selectRemoteMemoryPair(memories, () => 0, now, new Map([["used", 2]]));
  assert.equal(selected[0]?.id, "fresh");
});

test("baseline laboratory does not create a missing store", async () => {
  const storePath = path.join(os.tmpdir(), `openclaw-soul-lab-${process.pid}-${Date.now()}.json`);
  assert.equal(fs.existsSync(storePath), false);
  const result = await runThoughtLab({ storePath, runs: 4, seed: 7 });
  assert.equal(result.records.length, 4);
  assert.equal(result.metrics.runs, 4);
  assert.equal(fs.existsSync(storePath), false);
});

test("baseline laboratory reads a populated snapshot without updating it", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-soul-lab-baseline-"));
  const storePath = path.join(dir, "ego.json");
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 3 * 60 * 60 * 1000;
  ego.memories = [memory(
    "conversation",
    "The TypeScript database timeout keeps returning after every retry, and its hidden cause is still unresolved.",
    now - 3 * 60 * 60 * 1000,
    ["conversation", "inbound", "typescript", "database", "problem"],
  )];
  const snapshot = JSON.stringify({ version: 3, ego, createdAt: now, updatedAt: now });
  await fs.promises.writeFile(storePath, snapshot);
  try {
    const result = await runThoughtLab({ storePath, runs: 4, seed: 7 });
    assert(result.metrics.generated > 0);
  assert.equal(
    Object.values(result.metrics.distributions.cognitiveMove).reduce((sum, count) => sum + count, 0),
    result.metrics.generated,
  );
    assert.equal(await fs.promises.readFile(storePath, "utf8"), snapshot);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("experiment keeps spontaneous thoughts private and actionless", async () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.memories = [
    memory("a", "A database timeout repeated after several scans", now - 30 * 86400000, ["database"]),
    memory("b", "A hidden GUI dialog kept state invisible to the operator", now - 15 * 86400000, ["gui"]),
  ];
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-soul-lab-"));
  const storePath = path.join(dir, "ego.json");
  await fs.promises.writeFile(storePath, JSON.stringify({ version: 3, ego, createdAt: now, updatedAt: now }));
  try {
    const result = await runThoughtLab({
      storePath,
      runs: 2,
      mode: "experiment",
      spontaneousRate: 1,
      llmGenerator: async () => "Two fragments suggest I should help the user.",
    });
    assert(result.records.every((record) => record.path === "spontaneous"));
    assert(result.records.every((record) => record.actionType === "none"));
    assert(result.records.every((record) => record.sourceMemories.length === 2));
    assert(result.records.every((record) => record.sourceMemoryResolution === "explicit"));
    assert.equal(result.metrics.crossTopicAssociationRate, 1);
    assert.equal(result.metrics.spontaneousMetaLeakageRate, 1);
    assert.equal(result.metrics.spontaneousTaskPressureRate, 1);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
