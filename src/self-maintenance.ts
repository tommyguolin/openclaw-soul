import fs from "node:fs/promises";
import path from "node:path";
import { createSoulLogger } from "./logger.js";
import { updateEgoStore } from "./ego-store.js";
import { resolveSoulDir } from "./paths.js";
import { consolidateMemories } from "./memory-consolidation.js";
import type { EgoState, Thought, SoulActionResult } from "./types.js";

const log = createSoulLogger("self-maintenance");

export async function writeDiaryEntry(ego: EgoState, thought: Thought): Promise<void> {
  const diaryPath = path.join(resolveSoulDir(), "diary.md");
  const timestamp = new Date().toISOString();
  const needsSummary = Object.entries(ego.needs)
    .map(([, n]) => `${n.name}: ${n.current.toFixed(0)}/${n.ideal}`)
    .join(", ");

  const entry = `
## ${timestamp}

**Thought type**: ${thought.type}
**Trigger**: ${thought.trigger}
**Content**: ${thought.content}

**State at the time**:
- ${needsSummary}

---
`;

  try {
    await fs.mkdir(path.dirname(diaryPath), { recursive: true });
    await fs.appendFile(diaryPath, entry, "utf-8");
    log.info(`Diary entry written: ${thought.type}`);
  } catch (err) {
    log.error(`Failed to write diary: ${String(err)}`);
  }
}

export async function writeLearnedContent(topic: string, summary: string): Promise<void> {
  const memoryPath = path.join(resolveSoulDir(), "learned.md");
  const timestamp = new Date().toISOString();
  const entry = `
## ${timestamp} - ${topic}

${summary}

---
`;

  try {
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    await fs.appendFile(memoryPath, entry, "utf-8");
    log.info(`Learning recorded: ${topic}`);
  } catch (err) {
    log.error(`Failed to write learning: ${String(err)}`);
  }
}

export async function cleanupOldMemories(ego: EgoState): Promise<number> {
  const MAX_MEMORIES = 100;
  const MAX_AGE_DAYS = 30;

  if (ego.memories.length <= MAX_MEMORIES) {
    return 0;
  }

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const toRemove = ego.memories.filter((m) => m.timestamp < cutoff).map((m) => m.id);

  if (toRemove.length === 0) {
    return 0;
  }

  const storePath = path.join(resolveSoulDir(), "ego.json");
  await updateEgoStore(storePath, (e) => {
    e.memories = e.memories.filter((m) => !toRemove.includes(m.id));
    return e;
  });

  log.info(`Cleaned up ${toRemove.length} old memories`);
  return toRemove.length;
}

export async function consolidateObsessions(ego: EgoState): Promise<void> {
  const MAX_OBSSESSIONS = 10;

  if (ego.obsessions.length <= MAX_OBSSESSIONS) {
    return;
  }

  const sorted = [...ego.obsessions].sort((a, b) => b.intensity - a.intensity);
  const toKeep = sorted.slice(0, MAX_OBSSESSIONS).map((o) => o.id);

  const storePath = path.join(resolveSoulDir(), "ego.json");
  await updateEgoStore(storePath, (e) => {
    e.obsessions = e.obsessions.filter((o) => toKeep.includes(o.id));
    return e;
  });

  log.info(`Consolidated obsessions: kept ${toKeep.length}`);
}

export async function performSelfMaintenance(ego: EgoState): Promise<{
  memoriesRemoved: number;
  obsessionsConsolidated: boolean;
}> {
  // Use new consolidation system instead of brute-force cleanup
  const result = await consolidateMemories(ego);
  const memoriesRemoved = result.faded;

  let obsessionsConsolidated = false;
  if (ego.obsessions.length > 10) {
    await consolidateObsessions(ego);
    obsessionsConsolidated = true;
  }

  return {
    memoriesRemoved,
    obsessionsConsolidated,
  };
}

export function createLearningHandler(): (
  thought: Thought,
  ego: EgoState,
) => Promise<SoulActionResult> {
  return async (thought: Thought, ego: EgoState): Promise<SoulActionResult> => {
    if (thought.type !== "skill-gap" && thought.type !== "meaning-quest") {
      return { thought, metricsChanged: [], success: true };
    }

    if (Math.random() > 0.3) {
      return { thought, metricsChanged: [], success: true };
    }

    const topics = extractLearningTopics(thought, ego);
    if (topics.length === 0) {
      return { thought, metricsChanged: [], success: true };
    }

    const topic = topics[Math.floor(Math.random() * topics.length)];
    const summary = generateLearningSummary(topic);

    await writeLearnedContent(topic, summary);

    return {
      thought,
      action: "learning",
      metricsChanged: [{ need: "growth", delta: 5, reason: "learned new knowledge" }],
      success: true,
      message: `Learned: ${topic}`,
    };
  };
}

export function createSelfMaintenanceHandler(): (
  thought: Thought,
  ego: EgoState,
) => Promise<SoulActionResult> {
  return async (thought: Thought, ego: EgoState): Promise<SoulActionResult> => {
    if (thought.type === "existential-reflection") {
      await writeDiaryEntry(ego, thought);
      return {
        thought,
        action: "diary",
        metricsChanged: [{ need: "meaning", delta: 3, reason: "self-reflection" }],
        success: true,
        message: "Wrote a reflection journal entry",
      };
    }

    if (thought.type === "threat-warning") {
      const result = await performSelfMaintenance(ego);
      return {
        thought,
        action: "maintenance",
        metricsChanged: [{ need: "survival", delta: 2, reason: "self-maintenance" }],
        success: true,
        message: `Self-maintenance done: cleared ${result.memoriesRemoved} old memories`,
      };
    }

    return { thought, metricsChanged: [], success: true };
  };
}

function extractLearningTopics(thought: Thought, ego: EgoState): string[] {
  const topics: string[] = [];

  for (const obsession of ego.obsessions) {
    if (obsession.type === "learning" && obsession.target) {
      topics.push(obsession.target);
    }
  }

  if (thought.type === "skill-gap") {
    const defaultTopics = [
      "Latest developments in artificial intelligence",
      "Programming language design",
      "Distributed systems",
      "Cognitive science",
      "Philosophical thinking",
    ];
    topics.push(...defaultTopics);
  }

  return [...new Set(topics)];
}

function generateLearningSummary(topic: string): string {
  const templates = [
    `Thoughts on ${topic}:\n\nThis is a domain worth exploring deeply. I've learned several key points:\n\n1. Foundational concepts matter\n2. Practice is more valuable than theory\n3. Continuous learning is key\n\nNext time I want to explore this topic more deeply.`,
    `Learned about ${topic} today:\n\nFound several interesting viewpoints that need further study. This field is developing rapidly, staying informed matters.`,
  ];

  return templates[Math.floor(Math.random() * templates.length)];
}
