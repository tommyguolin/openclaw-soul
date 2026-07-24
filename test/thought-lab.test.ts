import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultEgoState } from "../src/ego-store.js";
import {
  assessThoughtAdvance,
  buildThoughtProgressSnapshot,
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

test("cognitive moves distinguish open-minded reasoning operations", () => {
  assert.equal(classifyCognitiveMove("根因是结果回收没有持久化检查点。"), "causal-analysis");
  assert.equal(classifyCognitiveMove("一个反例是重启后任务仍可从检查点恢复。"), "counterexample");
  assert.equal(classifyCognitiveMove("可以设计对照实验比较两种冷却时间。"), "experiment-design");
  assert.equal(classifyCognitiveMove("综合这些证据，问题在调度而不是生成。"), "synthesis");
});

test("thought advance gate rejects paraphrases and permits a new reasoning operation", () => {
  const repeated = assessThoughtAdvance(
    "I can reach out and share recent learning with the user.",
    ["I can reach out to the user and share my recent learning."],
    ["outreach"],
  );
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.reason, "semantic-repeat");

  const fresh = assessThoughtAdvance(
    "A controlled experiment can compare whether six-hour topic rest improves useful follow-ups.",
    ["The user has been quiet, so I can reach out."],
    ["outreach", "outreach"],
  );
  assert.equal(fresh.accepted, true);
  assert.equal(fresh.cognitiveMove, "experiment-design");
});

test("complex problem may repeat a reasoning move only after grounded evidence advances", () => {
  const prior = "The timeout is caused by the checkpoint write racing the gateway restart.";
  const repeated = assessThoughtAdvance(
    "The timeout is caused by the checkpoint write racing the gateway restart.",
    [prior],
    ["causal-analysis", "causal-analysis"],
    {
      evidenceIds: ["log-1"],
      previousEvidenceIds: ["log-1"],
      stateFingerprint: "checkpoint|gateway|restart|timeout",
      previousStateFingerprint: "checkpoint|gateway|restart|timeout",
    },
  );
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.reason, "semantic-repeat");
  assert.equal(repeated.verifiedProgress, false);

  const advanced = assessThoughtAdvance(
    "The new trace confirms the timeout is caused by the checkpoint write racing the gateway restart.",
    [prior],
    ["causal-analysis", "causal-analysis"],
    {
      evidenceIds: ["log-1", "trace-2"],
      previousEvidenceIds: ["log-1"],
      stateFingerprint: "checkpoint|gateway|restart|timeout",
      previousStateFingerprint: "checkpoint|gateway|restart|timeout",
    },
  );
  assert.equal(advanced.accepted, true);
  assert.equal(advanced.cognitiveMove, "causal-analysis");
  assert.equal(advanced.verifiedProgress, true);
});

test("progress snapshot ignores model repetition and elapsed-time numbers", () => {
  const opportunity = {
    triggerDetail: "Gateway retry has been unresolved for 90 minutes",
    motivation: "Find the gateway retry root cause",
  };
  const grounded = memory(
    "tool-log",
    "Gateway retry log shows a checkpoint race",
    Date.now(),
    ["tool"],
  );
  grounded.evidenceKind = "tool";
  const modelOnly = memory(
    "model-guess",
    "Gateway retry might have a checkpoint race",
    Date.now(),
    ["thought"],
  );
  modelOnly.evidenceKind = "model";
  const first = buildThoughtProgressSnapshot(opportunity, [grounded, modelOnly]);
  const later = buildThoughtProgressSnapshot({
    ...opportunity,
    triggerDetail: "Gateway retry has been unresolved for 180 minutes",
  }, [grounded, modelOnly]);
  assert.deepEqual(first.evidenceIds, ["tool-log"]);
  assert.equal(first.stateFingerprint, later.stateFingerprint);
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

test("empty helping intentions are rejected until they contain substantive value", () => {
  const content = "I recently learned some things, want to organize or share them.";
  assert(classifyThoughtQualityFlags(content).includes("empty-intention"));
  const assessment = assessThoughtAdvance(content, [], []);
  assert.equal(assessment.accepted, false);
  assert.equal(assessment.reason, "quality-flag");
});

test("timed laboratory simulation advances a virtual day without waiting or mutating Ego", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-soul-lab-time-"));
  const storePath = path.join(dir, "ego.json");
  const ego = createDefaultEgoState();
  const startTime = Date.UTC(2026, 6, 24, 0, 0, 0);
  ego.lastInteractionTime = startTime - 3 * 60 * 60 * 1000;
  ego.lastThoughtTime = 0;
  ego.memories = [memory(
    "unresolved",
    "Gateway restart interrupts the autonomous verification checkpoint.",
    startTime - 3 * 60 * 60 * 1000,
    ["conversation", "inbound", "problem"],
  )];
  const snapshot = JSON.stringify({ version: 3, ego, createdAt: startTime, updatedAt: startTime });
  await fs.promises.writeFile(storePath, snapshot);
  try {
    const result = await runThoughtLab({
      storePath,
      simulatedHours: 24,
      stepMinutes: 30,
      startTime,
      thoughtFrequency: 1,
      seed: 11,
    });

    assert.equal(result.records.length, 49);
    assert.equal(result.records[0].simulatedAt, startTime);
    assert.equal(result.records.at(-1)?.simulatedAt, startTime + 24 * 60 * 60 * 1000);
    assert.equal(result.metrics.simulatedHours, 24);
    assert(result.metrics.generated > 0);
    assert(result.metrics.generated < result.metrics.runs);
    assert.equal(await fs.promises.readFile(storePath, "utf8"), snapshot);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("a quiet virtual week becomes selective instead of repeating one proactive thought", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-soul-lab-week-"));
  const storePath = path.join(dir, "ego.json");
  const startTime = Date.UTC(2026, 6, 24, 0, 0, 0);
  const ego = createDefaultEgoState();
  ego.lastInteractionTime = startTime - 3 * 60 * 60 * 1000;
  ego.memories = [
    memory(
      "project",
      "The user is testing whether Soul produces useful proactive thoughts without repetition.",
      startTime - 2 * 60 * 60 * 1000,
      ["conversation", "inbound", "topic:soul-quality"],
    ),
    memory(
      "evidence",
      "A virtual week previously showed repeated proactive content pushes.",
      startTime - 24 * 60 * 60 * 1000,
      ["tool", "topic:soul-quality"],
    ),
    memory(
      "checkpoint",
      "Topic cooldown must preserve explicit user-directed execution.",
      startTime - 48 * 60 * 60 * 1000,
      ["learning", "topic:execution-safety"],
    ),
  ];
  const snapshot = JSON.stringify({ version: 3, ego, createdAt: startTime, updatedAt: startTime });
  await fs.promises.writeFile(storePath, snapshot);
  try {
    const result = await runThoughtLab({
      storePath,
      simulatedHours: 168,
      stepMinutes: 30,
      startTime,
      thoughtFrequency: 0.5,
      seed: 20260724,
    });
    assert(result.metrics.generated >= 2);
    assert(result.metrics.generated < 20);
    assert(result.metrics.sameTopicRepetitionRate <= 0.1);
    assert(result.metrics.meaningfulThoughtRate >= 0.5);
    assert(result.metrics.averageNoveltyScore >= 0.65);
    assert(result.metrics.skipped > result.metrics.generated);
    assert.equal(await fs.promises.readFile(storePath, "utf8"), snapshot);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("virtual timeline permits one same-move iteration for new evidence, then suppresses looping", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-soul-lab-episode-"));
  const storePath = path.join(dir, "ego.json");
  const startTime = Date.UTC(2026, 6, 24, 0, 0, 0);
  const ego = createDefaultEgoState();
  ego.lastInteractionTime = startTime - 3 * 60 * 60 * 1000;
  ego.memories = [memory(
    "user-problem",
    "The user interaction stopped while the Soul evidence decision remained unresolved.",
    startTime - 3 * 60 * 60 * 1000,
    ["conversation", "inbound", "problem"],
  )];
  await fs.promises.writeFile(
    storePath,
    JSON.stringify({ version: 3, ego, createdAt: startTime, updatedAt: startTime }),
  );
  try {
    const result = await runThoughtLab({
      storePath,
      simulatedHours: 72,
      stepMinutes: 12 * 60,
      startTime,
      thoughtFrequency: 0.5,
      llmGenerator: async () =>
        "The interaction gap is caused by the unresolved Soul evidence decision.",
      evidenceTimeline: [{
        atHour: 24,
        memory: {
          ...memory(
            "tool-result",
            "A tool result about the user interaction confirms the Soul evidence decision is still unresolved.",
            startTime,
            ["tool", "problem"],
          ),
          evidenceKind: "tool",
        },
      }],
    });
    const relationshipHours = result.records
      .filter((record) => record.thoughtType === "bond-deepen")
      .map((record) => record.elapsedMinutes / 60);
    assert.deepEqual(relationshipHours, [0, 24]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("laboratory reports novelty, grounding, and meaningful-thought metrics", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-soul-lab-value-"));
  const storePath = path.join(dir, "ego.json");
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 2 * 60 * 60 * 1000;
  ego.memories = [
    memory(
      "evidence",
      "A result file arrives after the parent settle window closes.",
      now - 2 * 60 * 60 * 1000,
      ["conversation", "inbound", "problem"],
    ),
    memory(
      "checkpoint",
      "A durable checkpoint lets work resume after a gateway restart.",
      now - 8 * 24 * 60 * 60 * 1000,
      ["operations", "recovery"],
    ),
  ];
  await fs.promises.writeFile(storePath, JSON.stringify({ version: 3, ego, createdAt: now, updatedAt: now }));
  try {
    const result = await runThoughtLab({
      storePath,
      runs: 2,
      mode: "experiment",
      spontaneousRate: 1,
      seed: 3,
      llmGenerator: async () =>
        "The late result is not another timeout; it shows the parent needs to reopen settlement when file evidence advances.",
    });
    assert(result.records.some((record) => record.grounded));
    assert(result.metrics.groundedThoughtRate > 0);
    assert(result.metrics.averageNoveltyScore >= 0);
    assert(result.metrics.meaningfulThoughtRate >= 0);
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
