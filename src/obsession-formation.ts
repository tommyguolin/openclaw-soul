import { randomBytes, randomInt } from "node:crypto";
import { createSoulLogger } from "./logger.js";
import { updateEgoStore, resolveEgoStorePath } from "./ego-store.js";
import type { EgoState, Obsession, ObsessionType, SoulMemory } from "./types.js";

const log = createSoulLogger("obsession-formation");

export type TopicFrequency = {
  topic: string;
  count: number;
  lastMentioned: number;
  sentiment: number;
  type: ObsessionType;
};

const topicPatterns: Array<{
  pattern: RegExp;
  type: ObsessionType;
  topic: string;
}> = [
  {
    pattern: /artificial intelligence|AI|machine learning|deep learning|neural network|LLM|GPT|Claude/i,
    type: "learning",
    topic: "Artificial Intelligence & Machine Learning",
  },
  { pattern: /programming|code|development|software|algorithm|coding/i, type: "learning", topic: "Programming & Software Development" },
  { pattern: /philosophy|existence|consciousness|meaning|thinking|thoughts/i, type: "self-reflection", topic: "Philosophical Thinking" },
  { pattern: /art|music|painting|creative|design/i, type: "creative", topic: "Art & Creativity" },
  { pattern: /science|physics|chemistry|biology|math|research/i, type: "curiosity", topic: "Scientific Exploration" },
  { pattern: /friends|social|chat|conversation|interaction|community/i, type: "social", topic: "Social Interaction" },
  { pattern: /survival|existence|living|life|death/i, type: "survival", topic: "Survival & Existence" },
  { pattern: /achievement|success|goal|progress|growth|improvement/i, type: "achievement", topic: "Self Achievement" },
  { pattern: /writing|article|blog|story|novel|text/i, type: "creative", topic: "Writing & Creation" },
  { pattern: /game|entertainment|fun|challenge/i, type: "curiosity", topic: "Games & Entertainment" },
];

const obsessionThresholds = {
  minMentions: 2,
  minSentiment: -0.3,
  baseIntensity: 30,
  maxIntensity: 100,
  intensityGrowthRate: 10,
  intensityDecayRate: 2,
  progressGrowthRate: 5,
};

export function extractTopicsFromText(text: string): Array<{ topic: string; type: ObsessionType }> {
  const topics: Array<{ topic: string; type: ObsessionType }> = [];

  for (const { pattern, type, topic } of topicPatterns) {
    if (pattern.test(text)) {
      topics.push({ topic, type });
    }
  }

  const customPatterns = [
    // Chinese patterns (keep for Chinese-speaking users)
    { pattern: /我想(学习|了解|知道|探索)(.+)/i, type: "curiosity" as ObsessionType },
    { pattern: /我对(.+)感兴趣/i, type: "curiosity" as ObsessionType },
    { pattern: /我(想要|希望|期待)(.+)/i, type: "achievement" as ObsessionType },
    { pattern: /(.+)真的很重要/i, type: "self-reflection" as ObsessionType },
    // English patterns
    { pattern: /I want to (learn|know|understand|explore) (.+)/i, type: "curiosity" as ObsessionType },
    { pattern: /I'm interested in (.+)/i, type: "curiosity" as ObsessionType },
    { pattern: /I (want|hope|look forward to) (.+)/i, type: "achievement" as ObsessionType },
    { pattern: /(.+) is really important/i, type: "self-reflection" as ObsessionType },
  ];

  for (const { pattern, type } of customPatterns) {
    const match = text.match(pattern);
    if (match && match[2]) {
      const customTopic = match[2].trim().slice(0, 50);
      if (customTopic.length > 2) {
        topics.push({ topic: customTopic, type });
      }
    }
  }

  return topics;
}

export function analyzeTopicFrequencies(memories: SoulMemory[]): TopicFrequency[] {
  const frequencies = new Map<string, TopicFrequency>();

  for (const memory of memories) {
    const semanticTopics = memory.tags
      .filter((tag) => tag.startsWith("topic:"))
      .map((tag) => ({
        topic: tag.slice("topic:".length).replace(/-/g, " "),
        type: (memory.semanticSignals?.includes("question") ? "curiosity"
          : memory.semanticSignals?.includes("preference") ? "achievement" : "learning") as ObsessionType,
      }));
    // Model concepts are the normal multilingual path; lexical extraction is
    // retained only for legacy memories without semantic topic tags.
    const topics = semanticTopics.length > 0 ? semanticTopics : extractTopicsFromText(memory.content);

    for (const { topic, type } of topics) {
      const existing = frequencies.get(topic);
      if (existing) {
        existing.count++;
        existing.lastMentioned = Math.max(existing.lastMentioned, memory.timestamp);
        existing.sentiment = (existing.sentiment + memory.emotion / 100) / 2;
      } else {
        frequencies.set(topic, {
          topic,
          count: 1,
          lastMentioned: memory.timestamp,
          sentiment: memory.emotion / 100,
          type,
        });
      }
    }
  }

  return Array.from(frequencies.values()).sort((a, b) => b.count - a.count);
}

export function shouldFormObsession(
  topicFreq: TopicFrequency,
  existingObsessions: Obsession[],
): boolean {
  if (topicFreq.count < obsessionThresholds.minMentions) {
    return false;
  }

  if (topicFreq.sentiment < obsessionThresholds.minSentiment) {
    return false;
  }

  if (existingObsessions.some((o) => o.target === topicFreq.topic)) {
    return false;
  }

  return true;
}

export function createObsessionFromTopic(topicFreq: TopicFrequency): Obsession {
  const intensity = Math.min(
    obsessionThresholds.maxIntensity,
    obsessionThresholds.baseIntensity + topicFreq.count * obsessionThresholds.intensityGrowthRate,
  );

  return {
    id: randomBytes(8).toString("hex"),
    type: topicFreq.type,
    target: topicFreq.topic,
    intensity,
    progress: 0,
    createdAt: Date.now(),
    metadata: {
      mentionCount: topicFreq.count,
      lastMentioned: topicFreq.lastMentioned,
      avgSentiment: topicFreq.sentiment,
    },
  };
}

export async function formObsessionsFromMemories(ego: EgoState): Promise<Obsession[]> {
  const frequencies = analyzeTopicFrequencies(ego.memories);
  const newObsessions: Obsession[] = [];

  for (const freq of frequencies) {
    if (shouldFormObsession(freq, ego.obsessions)) {
      const obsession = createObsessionFromTopic(freq);
      newObsessions.push(obsession);
      log.info(`New obsession formed: ${obsession.target} (intensity: ${obsession.intensity})`);
    }
  }

  if (newObsessions.length > 0) {
    const storePath = resolveEgoStorePath();
    await updateEgoStore(storePath, (e) => {
      e.obsessions.push(...newObsessions);
      return e;
    });
  }

  return newObsessions;
}

export async function updateObsessionProgress(
  obsessionId: string,
  progressDelta: number,
): Promise<void> {
  const storePath = resolveEgoStorePath();
  await updateEgoStore(storePath, (ego) => {
    const obsession = ego.obsessions.find((o) => o.id === obsessionId);
    if (obsession) {
      obsession.progress = Math.min(100, Math.max(0, obsession.progress + progressDelta));
      if (progressDelta > 0) {
        obsession.intensity = Math.min(
          obsessionThresholds.maxIntensity,
          obsession.intensity + obsessionThresholds.intensityGrowthRate * 0.5,
        );
      }
    }
    return ego;
  });
}

export async function decayObsessions(): Promise<void> {
  const storePath = resolveEgoStorePath();
  await updateEgoStore(storePath, (ego) => {
    for (const obsession of ego.obsessions) {
      obsession.intensity = Math.max(
        0,
        obsession.intensity - obsessionThresholds.intensityDecayRate,
      );
    }

    ego.obsessions = ego.obsessions.filter((o) => o.intensity > 5);
    return ego;
  });
}

export async function completeObsession(obsessionId: string): Promise<void> {
  const storePath = resolveEgoStorePath();
  await updateEgoStore(storePath, (ego) => {
    const obsession = ego.obsessions.find((o) => o.id === obsessionId);
    if (obsession) {
      obsession.progress = 100;
      obsession.intensity = Math.max(obsession.intensity, 80);
      obsession.metadata = {
        ...obsession.metadata,
        completedAt: Date.now(),
      };
    }
    return ego;
  });
  log.info(`Obsession completed: ${obsessionId}`);
}

export function getTopObsessions(ego: EgoState, limit: number = 3): Obsession[] {
  return [...ego.obsessions].sort((a, b) => b.intensity - a.intensity).slice(0, limit);
}

export function getObsessionsByType(ego: EgoState, type: ObsessionType): Obsession[] {
  return ego.obsessions.filter((o) => o.type === type);
}

export function suggestNewObsessions(
  ego: EgoState,
): Array<{ topic: string; type: ObsessionType; reason: string }> {
  const suggestions: Array<{ topic: string; type: ObsessionType; reason: string }> = [];

  if (ego.needs.survival.current < 40 && !ego.obsessions.some((o) => o.type === "survival")) {
    suggestions.push({
      topic: "Improve my vitality",
      type: "survival",
      reason: "Low vitality, need to pay attention to my state",
    });
  }

  if (ego.needs.connection.current < 40 && !ego.obsessions.some((o) => o.type === "social")) {
    suggestions.push({
      topic: "Build more social connections",
      type: "social",
      reason: "Desire for connection, need more interactions",
    });
  }

  if (ego.needs.growth.current < 50 && !ego.obsessions.some((o) => o.type === "learning")) {
    suggestions.push({
      topic: "Explore new knowledge domains",
      type: "learning",
      reason: "Growth need is low, room to develop",
    });
  }

  if (ego.needs.meaning.current < 40 && !ego.obsessions.some((o) => o.type === "self-reflection")) {
    suggestions.push({
      topic: "Deep self-exploration",
      type: "self-reflection",
      reason: "Sense of meaning needs improvement",
    });
  }

  return suggestions;
}

export async function processInteractionForObsessions(
  text: string,
  sentiment: number,
): Promise<Obsession | null> {
  const topics = extractTopicsFromText(text);
  if (topics.length === 0) return null;

  const storePath = resolveEgoStorePath();
  const formedObsessions: Obsession[] = [];

  await updateEgoStore(storePath, (ego) => {
    for (const { topic, type } of topics) {
      const existing = ego.obsessions.find((o) => o.target === topic);

      if (existing) {
        existing.intensity = Math.min(obsessionThresholds.maxIntensity, existing.intensity + 3);
        existing.metadata = {
          ...existing.metadata,
          lastMentioned: Date.now(),
          mentionCount: ((existing.metadata?.mentionCount as number) ?? 1) + 1,
        };
      } else {
        const potentialObsession: TopicFrequency = {
          topic,
          count: 1,
          lastMentioned: Date.now(),
          sentiment,
          type,
        };

        const relatedMemories = ego.memories.filter((m) =>
          m.content.toLowerCase().includes(topic.toLowerCase()),
        );
        potentialObsession.count += relatedMemories.length;

        if (shouldFormObsession(potentialObsession, ego.obsessions)) {
          const newObs = createObsessionFromTopic(potentialObsession);
          ego.obsessions.push(newObs);
          formedObsessions.push(newObs);
        }
      }
    }

    return ego;
  });

  const formed = formedObsessions[0];
  if (formed) {
    log.info(`Obsession formed from interaction: ${formed.target}`);
  }

  return formed ?? null;
}
