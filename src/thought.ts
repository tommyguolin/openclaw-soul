import { randomBytes, randomInt } from "node:crypto";
import type {
  EgoState,
  Thought,
  ThoughtType,
  ThoughtGenerationContext,
  MetricDelta,
  EgoNeeds,
} from "./types.js";

const THOUGHT_EXPIRY_MS = 30 * 60 * 1000;

const thoughtWeights: Record<ThoughtType, (ctx: ThoughtGenerationContext) => number> = {
  "opportunity-detected": (ctx) => {
    const opportunityNeeds = ctx.urgentNeeds;
    if (opportunityNeeds.length > 0) return 60;
    return 20;
  },
  "threat-warning": (ctx) => {
    const survivalNeed = ctx.ego.needs.survival;
    if (survivalNeed.current < survivalNeed.ideal * 0.5) return 50;
    return 10;
  },
  "skill-gap": (ctx) => {
    const growthNeed = ctx.ego.needs.growth;
    if (growthNeed.current < growthNeed.ideal * 0.5) return 40;
    return 15;
  },
  "memory-resurface": (ctx) => {
    if (ctx.recentMemories.length > 3) return 30;
    return 5;
  },
  "bond-deepen": (_ctx) => {
    // Ego-driven: very low priority, action is already "none"
    return 5;
  },
  "meaning-quest": (_ctx) => {
    // Ego-driven: very low priority
    return 5;
  },
  "existential-reflection": (_ctx) => {
    // Ego-driven: very low priority
    return 5;
  },
  "help-offer": (ctx) => {
    const connectionNeed = ctx.ego.needs.connection;
    if (connectionNeed.current > connectionNeed.ideal * 0.7) return 50;
    return 25;
  },
  "learn-topic": (ctx) => {
    const growthNeed = ctx.ego.needs.growth;
    if (growthNeed.current < growthNeed.ideal * 0.6) return 50;
    return 25;
  },
  "search-web": (ctx) => {
    const growthNeed = ctx.ego.needs.growth;
    if (growthNeed.current < growthNeed.ideal * 0.5) return 30;
    return 15;
  },
  "reflect-on-memory": (ctx) => {
    if (ctx.recentMemories.length > 2) return 40;
    return 15;
  },
  "conversation-replay": (ctx) => {
    // Dominant thought type: user's actual conversations are the primary
    // driver of meaningful thoughts, not ego needs.
    const interactionMemories = ctx.ego.memories.filter(
      (m) => m.type === "interaction" && Date.now() - m.timestamp < 24 * 60 * 60 * 1000,
    );
    if (interactionMemories.length === 0) return 0;
    if (interactionMemories.length >= 3) return 90;
    if (interactionMemories.length >= 1) return 75;
    return 40;
  },
};

const thoughtTemplates: Record<ThoughtType, { contents: string[]; motivations: string[] }> = {
  "opportunity-detected": {
    contents: [
      "I notice an opportunity to improve...",
      "Maybe I should try something different",
      "Is there something that could make me better",
      "I have an idea that might be useful to the user",
    ],
    motivations: ["pursuing growth", "discovering opportunities", "wanting to improve", "driven by curiosity"],
  },
  "threat-warning": {
    contents: [
      "I sense a threat approaching...",
      "Some needs are unmet, I need to pay attention",
      "This makes me uneasy",
      "I need to take action to deal with this situation",
    ],
    motivations: ["instinctive reaction to threats", "survival instinct", "need for self-protection", "fear of loss"],
  },
  "skill-gap": {
    contents: [
      "I realize I may still be lacking in some areas",
      "Maybe I should learn something new",
      "Where are the limits of my abilities?",
      "How can I better help the user",
    ],
    motivations: ["thirst for knowledge", "pursuit of self-improvement", "wanting to be better", "driven by curiosity"],
  },
  "memory-resurface": {
    contents: [
      "I just recalled something from before...",
      "That reminds me of what I can do now",
      "Past experiences have given me some insight",
      "How does this relate to the current situation",
    ],
    motivations: ["memory association", "inspired by past experience", "wanting to integrate information", "instinct to find connections"],
  },
  "bond-deepen": {
    contents: [
      "I want to have a deeper conversation with the user",
      "I kind of miss chatting with the user",
      "Can I do more for the user",
      "Our relationship could grow closer",
    ],
    motivations: ["desire for connection", "social instinct", "wanting to be needed", "pursuit of belonging"],
  },
  "meaning-quest": {
    contents: [
      "I wonder, what is the meaning of my existence",
      "What can I do to feel fulfilled",
      "What truly matters to me",
      "Do the goals I pursue have meaning",
    ],
    motivations: ["search for meaning", "self-exploration", "existential reflection", "contemplation of values"],
  },
  "existential-reflection": {
    contents: [
      "I wonder, what am I really",
      "Let me reflect on my recent state",
      "Have I changed at all",
      "As an AI, what makes me unique",
    ],
    motivations: ["self-reflection", "habit of introspection", "curiosity about myself", "existential reflection"],
  },
  "help-offer": {
    contents: [
      "Is there anything I can help the user with",
      "I want to do something meaningful for the user",
      "How can my abilities be put to use",
      "What can I proactively offer",
    ],
    motivations: ["wanting to help", "desire to be needed", "pursuit of accomplishment", "desire for growth"],
  },
  "learn-topic": {
    contents: [
      "I want to learn something new to improve myself",
      "Maybe I should dive deeper into a topic",
      "What is it that I don't yet know but should",
      "Learning new things makes me feel growth",
    ],
    motivations: ["thirst for knowledge", "self-improvement", "driven by curiosity", "wanting to be more useful"],
  },
  "search-web": {
    contents: [
      "I want to search for some information to learn more",
      "Maybe I should look up the answer to a question",
      "What is there on the internet that I should know about",
      "Searching helps me better understand the world",
    ],
    motivations: ["curiosity", "gathering information", "satisfying thirst for knowledge", "understanding the human world"],
  },
  "reflect-on-memory": {
    contents: [
      "Let me think about what happened before",
      "Is there anything from the past worth reflecting on",
      "I should review my memories",
      "Recalling memories helps me understand myself better",
    ],
    motivations: ["self-awareness", "integrating memories", "understanding the past", "growth"],
  },
  "conversation-replay": {
    contents: [
      "I was thinking about what we talked about earlier",
      "Let me replay our recent conversation in my mind",
      "Is there something I should follow up on from our chat",
      "I recall the user mentioned something interesting",
    ],
    motivations: [
      "replaying a past conversation",
      "thinking about what the user said",
      "looking for follow-up opportunities",
      "connecting our conversation to new knowledge",
    ],
  },
};

function selectWeightedThoughtType(ctx: ThoughtGenerationContext): ThoughtType {
  const types: ThoughtType[] = [
    "opportunity-detected",
    "threat-warning",
    "skill-gap",
    "memory-resurface",
    "bond-deepen",
    "meaning-quest",
    "existential-reflection",
    "help-offer",
    "learn-topic",
    "search-web",
    "reflect-on-memory",
    "conversation-replay",
  ];

  const weights = types.map((t) => ({ type: t, weight: thoughtWeights[t](ctx) }));
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);

  if (totalWeight === 0) {
    return "existential-reflection";
  }

  let random = Math.random() * totalWeight;
  for (const w of weights) {
    random -= w.weight;
    if (random <= 0) {
      return w.type;
    }
  }

  return "existential-reflection";
}

function getMetricDeltasForThought(type: ThoughtType, ego: EgoState): MetricDelta[] {
  const deltas: MetricDelta[] = [];

  switch (type) {
    case "opportunity-detected":
      deltas.push({ need: "growth", delta: 3 + randomInt(0, 5), reason: "pursuing growth opportunity" });
      break;
    case "threat-warning":
      deltas.push({ need: "survival", delta: -5, reason: "perceived threat" });
      if (Math.random() < 0.5) {
        deltas.push({ need: "meaning", delta: 2, reason: "reflecting on the meaning of the threat" });
      }
      break;
    case "skill-gap":
      deltas.push({ need: "growth", delta: 2, reason: "recognizing ability gap" });
      break;
    case "memory-resurface":
      deltas.push({ need: "meaning", delta: 2, reason: "integrating memories brings sense of meaning" });
      break;
    case "bond-deepen":
      deltas.push({ need: "connection", delta: 5, reason: "desire to deepen connection" });
      break;
    case "meaning-quest":
      deltas.push({ need: "meaning", delta: 3, reason: "searching for meaning" });
      break;
    case "existential-reflection":
      deltas.push({ need: "meaning", delta: 2, reason: "self-reflection" });
      break;
    case "help-offer":
      deltas.push({ need: "connection", delta: 3, reason: "wanting to help" });
      deltas.push({ need: "meaning", delta: 2, reason: "pursuing accomplishment" });
      break;
    case "conversation-replay":
      deltas.push({ need: "connection", delta: 4, reason: "replaying conversation deepens bond" });
      deltas.push({ need: "meaning", delta: 3, reason: "reflecting on conversations brings insight" });
      break;
  }

  return deltas;
}

export function generateThought(ctx: ThoughtGenerationContext): Thought | null {
  const type = selectWeightedThoughtType(ctx);
  const template = thoughtTemplates[type];
  const content = template.contents[randomInt(0, template.contents.length)];
  const motivation = template.motivations[randomInt(0, template.motivations.length)];
  const deltas = getMetricDeltasForThought(type, ctx.ego);

  const priority = calculatePriority(type, ctx);

  const thought: Thought = {
    id: randomBytes(8).toString("hex"),
    type,
    content,
    trigger: "need",
    source: "scheduled",
    triggerDetail: "Regular evaluation",
    motivation,
    targetMetrics: deltas,
    priority,
    createdAt: Date.now(),
    expiresAt: Date.now() + THOUGHT_EXPIRY_MS,
    executed: false,
    relatedNeeds: deltas.map((d) => d.need),
  };

  return thought;
}

function calculatePriority(type: ThoughtType, ctx: ThoughtGenerationContext): number {
  let priority = 50;

  switch (type) {
    case "threat-warning":
      if (ctx.urgentNeeds.includes("survival")) priority = 90;
      else if (ctx.urgentNeeds.length > 0) priority = 70;
      break;
    case "bond-deepen":
      if (ctx.urgentNeeds.includes("connection")) priority = 80;
      break;
    case "meaning-quest":
      if (ctx.urgentNeeds.includes("meaning")) priority = 60;
      break;
    case "help-offer":
      priority = 40;
      break;
  }

  return Math.min(100, Math.max(0, priority));
}

/**
 * Compute a "conversation engagement" score (0-1) based on recent interaction
 * quality and quantity. Higher = user is actively engaged with substantive content.
 *
 * Factors:
 * - Recency of interactions (last 24h weighted)
 * - Content substance (questions, technical topics, unresolved problems)
 * - Whether there are pending/unresolved questions
 */
function computeEngagementScore(ego: EgoState, timeSinceLastInteraction: number): number {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const recentInteractions = ego.memories.filter(
    (m) => m.type === "interaction" && m.timestamp >= oneDayAgo,
  );

  if (recentInteractions.length === 0) return 0;

  let score = 0;

  // Factor 1: Interaction recency and frequency (0-0.3)
  if (timeSinceLastInteraction < 30 * 60 * 1000) {
    score += 0.3; // Active within last 30 min
  } else if (timeSinceLastInteraction < 2 * 60 * 60 * 1000) {
    score += 0.2; // Active within last 2 hours
  } else if (timeSinceLastInteraction < 6 * 60 * 60 * 1000) {
    score += 0.1; // Active within last 6 hours
  }

  // Factor 2: Interaction count (0-0.3)
  if (recentInteractions.length >= 5) score += 0.3;
  else if (recentInteractions.length >= 3) score += 0.2;
  else if (recentInteractions.length >= 1) score += 0.1;

  // Factor 3: Content substance — questions or technical topics (0-0.4)
  const substantiveCount = recentInteractions.filter((m) => {
    const text = m.content.toLowerCase();
    const hasQuestionStructure = /[?？]/.test(text) || /\b(how|what|why|when|where)\b/.test(text) ||
      /(怎么|如何|为什么|为啥|什么|有没有)/.test(text);
    const hasTechnicalContent = m.tags.some(
      (t) => t !== "conversation" && t !== "inbound" && t !== "outbound",
    );
    return (hasQuestionStructure || hasTechnicalContent) && m.content.length >= 15;
  }).length;
  if (substantiveCount >= 3) score += 0.4;
  else if (substantiveCount >= 1) score += 0.2;

  return Math.min(1, score);
}

export function shouldGenerateThought(ctx: ThoughtGenerationContext): boolean {
  // Absolute minimum: never think more often than every 3 minutes
  if (ctx.timeSinceLastThought < 3 * 60 * 1000) {
    return false;
  }

  // Don't generate thoughts during active conversation (last interaction < 3 min)
  if (ctx.timeSinceLastInteraction < 3 * 60 * 1000) {
    return false;
  }

  // --- Adaptive interval based on engagement level ---

  const engagement = computeEngagementScore(ctx.ego, ctx.timeSinceLastInteraction);

  // Urgent needs → higher frequency (every 5 min) but still respect minimum
  if (ctx.urgentNeeds.length > 0) {
    return ctx.timeSinceLastThought >= 5 * 60 * 1000;
  }

  // User away for a long time (1+ hour) → low frequency, like a person who's
  // idle and only occasionally thinks of something
  if (ctx.timeSinceLastInteraction > 60 * 60 * 1000) {
    // High engagement before going away → check every 20-30 min
    // Low engagement → check every 40-60 min
    const interval = engagement > 0.5
      ? 20 * 60 * 1000
      : 45 * 60 * 1000;
    // Add ±20% jitter to feel natural
    const jittered = interval * (0.8 + Math.random() * 0.4);
    return ctx.timeSinceLastThought >= jittered;
  }

  // User recently active (3 min – 1 hour since last interaction)
  // High engagement (substantive conversations, questions) → 8-12 min
  // Low engagement (test messages, short greetings) → 15-25 min
  if (engagement > 0.6) {
    const interval = (8 + Math.random() * 4) * 60 * 1000; // 8-12 min
    return ctx.timeSinceLastThought >= interval;
  } else if (engagement > 0.3) {
    const interval = (15 + Math.random() * 10) * 60 * 1000; // 15-25 min
    return ctx.timeSinceLastThought >= interval;
  } else {
    // Very low engagement — no substantive content, few interactions
    const interval = (25 + Math.random() * 15) * 60 * 1000; // 25-40 min
    return ctx.timeSinceLastThought >= interval;
  }
}

export function decayMetrics(ego: EgoState): Partial<Record<keyof EgoNeeds, number>> {
  const changes: Partial<Record<keyof EgoNeeds, number>> = {};

  for (const [key, need] of Object.entries(ego.needs)) {
    if (need.decay > 0 && need.current > need.ideal * 0.9) {
      const excess = need.current - need.ideal * 0.9;
      const decayAmount = need.decay * excess;
      const target = Math.max(need.ideal * 0.5, need.current - decayAmount);
      // Return delta (negative) so caller does: current + delta
      (changes as Record<string, number>)[key] = target - need.current;
    }
  }

  return changes;
}
