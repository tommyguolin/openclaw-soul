import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThoughtCycleJournal, type ThoughtCycleJournalRecord } from "../src/thought-journal.js";
import { ThoughtService } from "../src/thought-service.js";
import { updateEgoStore } from "../src/ego-store.js";

function record(index: number, outcome: ThoughtCycleJournalRecord["outcome"] = "generated"): ThoughtCycleJournalRecord {
  return {
    version: 1,
    cycleId: `cycle-${index}`,
    timestamp: 1_000 + index,
    outcome,
    context: {
      currentHour: 10,
      dayOfWeek: 1,
      urgentNeeds: [],
      activeGoalIds: [],
      recentMemoryIds: [],
      totalMemories: 2,
    },
    opportunities: [],
    ...(outcome === "generated" ? {
      thought: {
        id: `thought-${index}`,
        type: index % 2 === 0 ? "memory-resurface" : "conversation-replay",
        content: `thought content ${index}`,
        source: "memory-recall",
        trigger: "memory",
        motivation: "test",
        actionType: index % 2 === 0 ? "none" : "self-reflect",
      },
    } : {}),
    recentStateBefore: { thoughtTypes: [], topicSignatures: [], actionTypes: [] },
  };
}

test("journal serializes concurrent appends and restores diversity state", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-journal-"));
  const filePath = path.join(directory, "thought-cycles.jsonl");
  try {
    const journal = new ThoughtCycleJournal(filePath);
    await Promise.all(Array.from({ length: 12 }, (_, index) => journal.append(record(index))));
    await journal.append(record(99, "skipped"));

    const recent = await journal.loadRecent(20);
    assert.equal(recent.length, 13);
    assert.equal(new Set(recent.map((item) => item.cycleId)).size, 13);

    const restored = await journal.restoreDiversityState();
    assert.equal(restored.thoughtTypes.length, 3);
    assert.equal(restored.thoughtContents.length, 10);
    assert.equal(restored.actionTypes.length, 5);
    assert(restored.actionTypes.every((action) => action === "self-reflect"));
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("journal ignores a partial trailing line after a crash", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-journal-"));
  const filePath = path.join(directory, "thought-cycles.jsonl");
  try {
    const journal = new ThoughtCycleJournal(filePath);
    await journal.append(record(1));
    await fs.promises.appendFile(filePath, "{partial");
    const recent = await journal.loadRecent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].cycleId, "cycle-1");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("ThoughtService journals a real generation cycle and restores diversity after restart", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-journal-service-"));
  const storePath = path.join(directory, "ego.json");
  const journalPath = path.join(directory, "thought-cycles.jsonl");
  type ServiceInternals = {
    checkAndGenerateThought(): Promise<void>;
    restoreDiversityState(): Promise<void>;
    recentThoughtTypes: string[];
    recentThoughtTopics: string[];
  };
  try {
    const first = new ThoughtService({ storePath });
    await first.recordInteractionWithText({
      type: "inbound",
      text: "The TypeScript database timeout keeps returning after every retry, and I need to understand the hidden cause.",
    });
    await updateEgoStore(storePath, (ego) => {
      ego.lastInteractionTime = Date.now() - 3 * 60 * 60 * 1000;
      ego.lastThoughtTime = null;
      return ego;
    });
    await (first as unknown as ServiceInternals).checkAndGenerateThought();
    const records = await new ThoughtCycleJournal(journalPath).loadRecent(10);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "generated");
    assert(records[0].opportunities.length > 0);
    assert(records[0].thought?.content);

    const restarted = new ThoughtService({ storePath });
    const internals = restarted as unknown as ServiceInternals;
    await internals.restoreDiversityState();
    assert.equal(internals.recentThoughtTypes.length, 1);
    assert.equal(internals.recentThoughtTopics.length, 1);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("ThoughtService uses the thought model for execution-focused opportunities", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-journal-execution-thought-"));
  const storePath = path.join(directory, "ego.json");
  const journalPath = path.join(directory, "thought-cycles.jsonl");
  const completeThought = "这不是一个搜索动作标签，而是围绕当前问题形成的完整分析。".repeat(30);
  type ServiceInternals = {
    checkAndGenerateThought(): Promise<void>;
    thoughtLLMGenerator?: (prompt: string) => Promise<string>;
  };
  try {
    const service = new ThoughtService({ storePath, thoughtFrequency: 0.1 });
    const internals = service as unknown as ServiceInternals;
    let calls = 0;
    internals.thoughtLLMGenerator = async () => {
      calls += 1;
      return completeThought;
    };
    await service.recordInteractionWithText({
      type: "inbound",
      text: "Please search for a solution to the recurring TypeScript database timeout problem.",
    });
    await updateEgoStore(storePath, (ego) => {
      ego.lastInteractionTime = Date.now() - 8 * 60 * 1000;
      ego.lastThoughtTime = null;
      return ego;
    });
    await internals.checkAndGenerateThought();
    const record = (await new ThoughtCycleJournal(journalPath).loadRecent(1))[0];
    assert.equal(record.selectedOpportunity?.suggestedAction, "search-web");
    assert.equal(calls, 1);
    assert.equal(record.thought?.content, completeThought);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
