import type {
  EgoState,
  ThoughtGenerationContext,
  EgoNeeds,
} from "./types.js";

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
  const freq = ctx.thoughtFrequency ?? 1.0;

  // Absolute minimum: never think more often than every 3 minutes (scaled)
  const minInterval = 3 * 60 * 1000 * freq;
  if (ctx.timeSinceLastThought < minInterval) {
    return false;
  }

  // Don't generate thoughts during active conversation (scaled)
  if (ctx.timeSinceLastInteraction < 3 * 60 * 1000 * freq) {
    return false;
  }

  // --- Adaptive interval based on engagement level ---

  const engagement = computeEngagementScore(ctx.ego, ctx.timeSinceLastInteraction);

  // Urgent needs → higher frequency (every 5 min) but still respect minimum
  if (ctx.urgentNeeds.length > 0) {
    return ctx.timeSinceLastThought >= 5 * 60 * 1000 * freq;
  }

  // User away for a long time (1+ hour) → low frequency
  if (ctx.timeSinceLastInteraction > 60 * 60 * 1000 * freq) {
    const interval = engagement > 0.5
      ? 20 * 60 * 1000
      : 45 * 60 * 1000;
    const jittered = interval * (0.8 + Math.random() * 0.4);
    return ctx.timeSinceLastThought >= jittered * freq;
  }

  // User recently active (scaled)
  if (engagement > 0.6) {
    const interval = (8 + Math.random() * 4) * 60 * 1000;
    return ctx.timeSinceLastThought >= interval * freq;
  } else if (engagement > 0.3) {
    const interval = (15 + Math.random() * 10) * 60 * 1000;
    return ctx.timeSinceLastThought >= interval * freq;
  } else {
    const interval = (25 + Math.random() * 15) * 60 * 1000;
    return ctx.timeSinceLastThought >= interval * freq;
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
