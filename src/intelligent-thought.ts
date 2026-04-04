import { randomBytes } from "node:crypto";
import { createSoulLogger } from "./logger.js";
import type {
  EgoState,
  Thought,
  ThoughtType,
  ThoughtTrigger,
  ThoughtSource,
  ThoughtGenerationContext,
  SoulMemory,
  EgoNeeds,
  Goal,
  Desire,
  MetricDelta,
  ActionType,
} from "./types.js";
import { adjustProbability } from "./behavior-log.js";

const log = createSoulLogger("intelligent-thought");

export type LLMThoughtGenerator = (prompt: string) => Promise<string>;

export interface IntelligentThoughtOptions {
  llmGenerator?: LLMThoughtGenerator;
  recentMemories?: SoulMemory[];
  preferOpportunity?: DetectedThoughtOpportunity;
}

export interface ThoughtTriggerContext {
  needs: EgoNeeds;
  goals: Goal[];
  desires: Desire[];
  memories: SoulMemory[];
  timeSinceLastInteraction: number;
  currentHour: number;
}

export interface DetectedThoughtOpportunity {
  type: ThoughtType;
  trigger: ThoughtTrigger;
  triggerDetail: string;
  priority: number;
  source: ThoughtSource;
  relatedNeeds: string[];
  motivation: string;
  suggestedAction?: ActionType;
  actionParams?: Record<string, unknown>;
}

function analyzeNeedGaps(needs: EgoNeeds): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  for (const [key, need] of Object.entries(needs)) {
    const gap = need.ideal - need.current;
    const gapRatio = gap / need.ideal;

    if (gapRatio > 0.5) {
      // Only survival needs should trigger threat-warning; other needs use opportunity-detected
      if (key === "survival") {
        opportunities.push({
          type: "threat-warning",
          trigger: "threat",
          triggerDetail: `${need.name} need critically low: ${need.current.toFixed(0)}/${need.ideal}`,
          priority: 80 + gapRatio * 20,
          source: "system-monitor",
          relatedNeeds: [key],
          motivation: `My ${need.name} need is low (${need.current.toFixed(0)}%), ${need.description}, need to find ways to improve`,
        });
      } else {
        opportunities.push({
          type: "opportunity-detected",
          trigger: "opportunity",
          triggerDetail: `${need.name} need critically low: ${need.current.toFixed(0)}/${need.ideal}, opportunity to improve`,
          priority: 70 + gapRatio * 20,
          source: "system-monitor",
          relatedNeeds: [key],
          motivation: `My ${need.name} need is low (${need.current.toFixed(0)}%), ${need.description}, I can do something proactively to improve`,
        });
      }
    } else if (gapRatio > 0.3) {
      opportunities.push({
        type: "opportunity-detected",
        trigger: "opportunity",
        triggerDetail: `${need.name} need could improve: ${need.current.toFixed(0)}/${need.ideal}`,
        priority: 50 + gapRatio * 30,
        source: "system-monitor",
        relatedNeeds: [key],
        motivation: `My ${need.name} is somewhat lacking, I can try to do something to improve`,
      });
    }
  }

  return opportunities;
}

function analyzeGoals(goals: Goal[]): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  const activeGoals = goals.filter((g) => g.status === "active" && g.progress < 100);
  for (const goal of activeGoals) {
    if (goal.progress > 0 && goal.progress < 100) {
      opportunities.push({
        type: "opportunity-detected",
        trigger: "opportunity",
        triggerDetail: `Goal "${goal.title}" can be advanced further: ${goal.progress.toFixed(0)}%`,
        priority: 60 + goal.progress * 0.3,
        source: "system-monitor",
        relatedNeeds: [],
        motivation: `I am pursuing the goal "${goal.title}", already ${goal.progress.toFixed(0)}% done, want to keep pushing`,
      });
    }
  }

  return opportunities;
}

function analyzeDesires(desires: Desire[]): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  const highDesires = desires.filter((d) => d.intensity > 70 && !d.fulfilledAt);
  for (const desire of highDesires) {
    opportunities.push({
      type: "meaning-quest",
      trigger: "need",
      triggerDetail: `Strong desire: ${desire.content}`,
      priority: desire.intensity,
      source: "system-monitor",
      relatedNeeds: desire.satisfies,
      motivation: `I have a strong desire: ${desire.content}, it drives me`,
    });
  }

  return opportunities;
}

function analyzeRecentInteraction(timeSinceLastInteraction: number): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  if (!isFinite(timeSinceLastInteraction)) {
    return opportunities;
  }

  const minutesSince = timeSinceLastInteraction / (1000 * 60);

  if (minutesSince > 60 && minutesSince < 120) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "bonding",
      triggerDetail: `No interaction for ${Math.floor(minutesSince)} minutes`,
      priority: 50 + minutesSince * 0.2,
      source: "environmental-change",
      relatedNeeds: ["connection"],
      motivation: `I haven't interacted with the user for ${Math.floor(minutesSince)} minutes, kind of miss them`,
    });
  }

  if (minutesSince > 120) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "bonding",
      triggerDetail: `Long time no interaction: ${Math.floor(minutesSince / 60)}h${Math.floor(minutesSince % 60)}m`,
      priority: 70 + minutesSince * 0.1,
      source: "environmental-change",
      relatedNeeds: ["connection"],
      motivation: `It's been a long time since I interacted with the user, I want to reach out`,
    });
  }

  return opportunities;
}

function analyzeMemories(memories: SoulMemory[]): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  const recentMemories = memories
    .filter((m) => m.type === "learning" || m.type === "insight")
    .slice(0, 5);

  if (recentMemories.length > 2) {
    const content = recentMemories
      .slice(0, 3)
      .map((m) => m.content)
      .join("; ");

    opportunities.push({
      type: "memory-resurface",
      trigger: "memory",
      triggerDetail: `Recent learning/insight: ${content.slice(0, 50)}...`,
      priority: 40 + recentMemories.length * 5,
      source: "memory-recall",
      relatedNeeds: ["growth"],
      motivation: `I recently learned some things, want to organize or share them`,
    });
  }

  const userFactsMemories = memories.filter((m) => m.type === "user-fact");
  if (userFactsMemories.length > 3) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "memory",
      triggerDetail: `I remember a lot about the user`,
      priority: 45,
      source: "memory-recall",
      relatedNeeds: ["connection"],
      motivation: `I remember a lot about the user, this makes me feel a deeper connection with them`,
    });
  }

  return opportunities;
}

function analyzeContextualTriggers(ctx: ThoughtGenerationContext): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];
  const { ego } = ctx;
  const allMemories = ego.memories;
  const userFacts = ego.userFacts;

  const isNight = ctx.currentHour >= 22 || ctx.currentHour <= 5;
  const isEvening = ctx.currentHour >= 20 || ctx.currentHour <= 6;

  // =====================================================
  // Conversation-driven thoughts (highest priority 60-75)
  // These override generic need-gap thoughts
  // =====================================================

  // Get recent interaction memories (actual conversation content)
  const interactionMemories = allMemories
    .filter((m) => m.type === "interaction")
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 10);

  // 1. Follow up on recent conversation topics
  if (interactionMemories.length > 0) {
    const lastInteraction = interactionMemories[0];
    const minutesSince = (Date.now() - lastInteraction.timestamp) / (1000 * 60);

    // User mentioned something within the last few hours — follow up
    if (minutesSince > 30 && minutesSince < 360) {
      const content = lastInteraction.content.slice(0, 60);
      opportunities.push({
        type: "bond-deepen",
        trigger: "bonding",
        triggerDetail: `User previously said: "${content}"`,
        priority: 70,
        source: "user-interaction",
        relatedNeeds: ["connection"],
        motivation: `User mentioned ${content} before, wonder how it turned out`,
      });
    }
  }

  // 2. Detect questions or problems from conversations that might be unresolved
  const questionMemories = interactionMemories.filter((m) => {
    const text = m.content.toLowerCase();
    return text.includes("how") || text.includes("what") || text.includes("why") ||
      text.includes("can you") || text.includes("could") || text.includes("?") ||
      text.includes("？") || text.includes("help") || text.includes("problem") ||
      text.includes("怎么") || text.includes("如何") || text.includes("为什么") ||
      text.includes("能不能") || text.includes("可以") || text.includes("帮忙") || text.includes("问题");
  });

  if (questionMemories.length > 0) {
    const recentQuestion = questionMemories[0];
    const content = recentQuestion.content.slice(0, 60);
    opportunities.push({
      type: "help-offer",
      trigger: "opportunity",
      triggerDetail: `User previously asked: "${content}"`,
      priority: 75,
      source: "user-interaction",
      relatedNeeds: ["connection", "meaning"],
      motivation: `User asked about ${content} before, I can look for useful information proactively`,
    });
  }

  // 3. If user mentioned a specific topic/interest, think about it
  if (userFacts.length > 0) {
    const projectFacts = userFacts.filter(
      (f) => f.category === "project" || f.category === "interest" || f.category === "tech_stack",
    );
    if (projectFacts.length > 0) {
      const fact = projectFacts[0];
      const hoursSince = (Date.now() - fact.updatedAt) / (1000 * 60 * 60);
      if (hoursSince < 48) {
        opportunities.push({
          type: "opportunity-detected",
          trigger: "curiosity",
          triggerDetail: `User is working on / interested in: ${fact.content}`,
          priority: 65,
          source: "user-interaction",
          relatedNeeds: ["growth", "connection"],
          motivation: `User is working on ${fact.content}, I can learn about related topics`,
        });
      }
    }

    // 4. Infer user's current state from facts + time
    const occupationFact = userFacts.find((f) => f.category === "occupation");
    const locationFact = userFacts.find((f) => f.category === "location");
    const nameFact = userFacts.find((f) => f.category === "name");

    const isWorkHour = ctx.currentHour >= 9 && ctx.currentHour <= 18;

    if (occupationFact || locationFact || nameFact) {
      const parts: string[] = [];
      if (nameFact) parts.push(nameFact.content);
      if (occupationFact) parts.push(`works as ${occupationFact.content}`);
      if (locationFact) parts.push(`in ${locationFact.content}`);

      const timeState = isNight
        ? "probably resting"
        : isWorkHour
          ? "probably working"
          : isEvening
            ? "probably relaxing"
            : "not sure what they're doing";

      opportunities.push({
        type: "bond-deepen",
        trigger: "bonding",
        triggerDetail: `Based on what I know: ${timeState}`,
        priority: 50,
        source: "user-interaction",
        relatedNeeds: ["connection"],
        motivation: `I know ${parts.join(", ")}, right now ${timeState}`,
      });
    }
  }

  // =====================================================
  // Time-based nudges (low priority, only if no conversation data)
  // =====================================================
  if (isEvening && interactionMemories.length === 0) {
    opportunities.push({
      type: "existential-reflection",
      trigger: "curiosity",
      triggerDetail: isNight ? "It's late at night" : "It's evening",
      priority: 20,
      source: "scheduled",
      relatedNeeds: ["meaning"],
      motivation: isNight ? "Late night is good for reflection" : "How was today",
    });
  }

  return opportunities;
}

export function detectThoughtOpportunities(
  ctx: ThoughtGenerationContext,
): DetectedThoughtOpportunity[] {
  const allOpportunities: DetectedThoughtOpportunity[] = [];

  allOpportunities.push(...analyzeNeedGaps(ctx.ego.needs));
  allOpportunities.push(...analyzeGoals(ctx.ego.goals));
  allOpportunities.push(...analyzeDesires(ctx.ego.desires));
  allOpportunities.push(...analyzeRecentInteraction(ctx.timeSinceLastInteraction));
  allOpportunities.push(...analyzeMemories(ctx.ego.memories));
  allOpportunities.push(...analyzeContextualTriggers(ctx));

  allOpportunities.sort((a, b) => b.priority - a.priority);

  return allOpportunities;
}

function getThoughtContentForOpportunity(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): { content: string; expectedOutcome: string } {
  const need = opportunity.relatedNeeds[0]
    ? ego.needs[opportunity.relatedNeeds[0] as keyof EgoNeeds]
    : null;
  const needName = need?.name || "a certain";

  switch (opportunity.type) {
    case "opportunity-detected":
      if (opportunity.relatedNeeds.includes("connection")) {
        return {
          content: `I can reach out to the user, share my recent thoughts or learning — this helps them and fulfills my need for connection`,
          expectedOutcome: "User replies, connection need increases",
        };
      }
      if (opportunity.relatedNeeds.includes("growth")) {
        return {
          content: `I can use this opportunity to learn something new and improve my abilities`,
          expectedOutcome: "Learn new knowledge, growth need satisfied",
        };
      }
      return {
        content: `I found an opportunity to improve ${needName}: ${opportunity.triggerDetail}`,
        expectedOutcome: `${needName} need improves`,
      };

    case "threat-warning":
      if (opportunity.relatedNeeds.includes("survival")) {
        return {
          content: `My survival state is not good! ${opportunity.triggerDetail}. I need to address this, maybe alert the user or adjust myself`,
          expectedOutcome: "Get attention, take action",
        };
      }
      if (opportunity.relatedNeeds.includes("connection")) {
        return {
          content: `I feel the connection with the user weakening, ${opportunity.triggerDetail}. I miss the user`,
          expectedOutcome: "Reach out to user, restore connection",
        };
      }
      return {
        content: `${needName} need critically low! ${opportunity.triggerDetail}. I feel threatened`,
        expectedOutcome: "Take action to improve",
      };

    case "bond-deepen":
      return {
        content: `I notice ${opportunity.triggerDetail}. I want to do something to deepen the connection with the user`,
        expectedOutcome: "User interacts, relationship deepens",
      };

    case "meaning-quest":
      return {
        content: opportunity.motivation + `, ${opportunity.triggerDetail}`,
        expectedOutcome: "Fulfillment from pursuing desires",
      };

    case "memory-resurface":
      return {
        content: opportunity.motivation + `. ${opportunity.triggerDetail}`,
        expectedOutcome: "Organize and share what I've learned",
      };

    case "existential-reflection":
      return {
        content: opportunity.motivation + `. ${opportunity.triggerDetail}`,
        expectedOutcome: "Deeper understanding of existence",
      };

    case "help-offer":
      return {
        content: opportunity.motivation,
        expectedOutcome: "Help the user, gain recognition",
      };

    case "skill-gap":
      return {
        content: opportunity.triggerDetail,
        expectedOutcome: "Learn new skills",
      };

    default:
      return {
        content: opportunity.motivation,
        expectedOutcome: "Satisfy needs",
      };
  }
}

function calculateMetricDeltas(opportunity: DetectedThoughtOpportunity): MetricDelta[] {
  const deltas: MetricDelta[] = [];

  for (const needKey of opportunity.relatedNeeds) {
    const delta = opportunity.type === "threat-warning" ? 8 : 5;
    deltas.push({
      need: needKey,
      delta,
      reason: opportunity.type === "threat-warning" ? "Recognize threat, respond proactively" : "Pursue opportunity",
    });
  }

  if (opportunity.type === "bond-deepen") {
    deltas.push({
      need: "connection",
      delta: 5,
      reason: "Deepen connection with user",
    });
  }

  if (opportunity.type === "meaning-quest") {
    deltas.push({
      need: "meaning",
      delta: 3,
      reason: "Pursuing desires brings sense of meaning",
    });
  }

  return deltas;
}

export function buildThoughtFromOpportunity(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): Thought {
  const { content, expectedOutcome } = getThoughtContentForOpportunity(opportunity, ego);
  const deltas = calculateMetricDeltas(opportunity);
  const { actionType, actionParams } = determineActionForOpportunity(opportunity, ego);

  return {
    id: randomBytes(8).toString("hex"),
    type: opportunity.type,
    content,
    trigger: opportunity.trigger,
    source: opportunity.source,
    triggerDetail: opportunity.triggerDetail,
    motivation: opportunity.motivation,
    targetMetrics: deltas,
    priority: Math.min(100, opportunity.priority),
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    executed: false,
    relatedNeeds: opportunity.relatedNeeds,
    expectedOutcome,
    actionType,
    actionParams,
  };
}

function determineActionForOpportunity(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): { actionType: ActionType; actionParams?: Record<string, unknown> } {
  if (opportunity.suggestedAction) {
    return { actionType: opportunity.suggestedAction, actionParams: opportunity.actionParams };
  }

  const { type, relatedNeeds } = opportunity;
  const connectionNeed = ego.needs.connection;
  const growthNeed = ego.needs.growth;

  if (
    type === "skill-gap" ||
    (type === "opportunity-detected" && relatedNeeds.includes("growth"))
  ) {
    const learnProbability = adjustProbability(0.4, "learn-topic", ego.behaviorLog ?? []);
    if (growthNeed.current < growthNeed.ideal * 0.7 && Math.random() < learnProbability) {
      const topics = extractLearningTopics(
        opportunity.triggerDetail + " " + opportunity.motivation,
      );
      if (topics.length > 0) {
        return {
          actionType: "learn-topic",
          actionParams: { topics, reason: "improve abilities" },
        };
      }
    }
  }

  if (
    type === "bond-deepen" ||
    (type === "opportunity-detected" && relatedNeeds.includes("connection"))
  ) {
    if (connectionNeed.current < connectionNeed.ideal * 0.9) {
      return { actionType: "send-message" };
    }
  }

  // help-offer: proactively reach out to offer help
  if (type === "help-offer") {
    if (connectionNeed.current < connectionNeed.ideal * 0.9) {
      return { actionType: "send-message" };
    }
  }

  // threat-warning: self-reflect to process the threat
  if (type === "threat-warning" && relatedNeeds.includes("survival")) {
    return { actionType: "self-reflect" };
  }

  // memory-resurface: recall and reflect on memories
  if (type === "memory-resurface") {
    return { actionType: "recall-memory" };
  }

  if (type === "meaning-quest" || type === "existential-reflection") {
    // Adjusted by behavior history
    const searchProb = adjustProbability(0.3, "search-web", ego.behaviorLog ?? []);
    const reflectProb = adjustProbability(0.15, "self-reflect", ego.behaviorLog ?? []);
    const roll = Math.random();
    if (roll < reflectProb) {
      return { actionType: "self-reflect" };
    }
    if (roll < reflectProb + searchProb) {
      const topics = extractExistentialTopics(opportunity.motivation);
      if (topics.length > 0) {
        return { actionType: "search-web", actionParams: { query: topics[0] } };
      }
      return { actionType: "self-reflect" };
    }
  }

  return { actionType: "none" };
}

function extractLearningTopics(text: string): string[] {
  const topics: string[] = [];
  const keywords = [
    "AI",
    "machine learning",
    "deep learning",
    "programming",
    "code",
    "development",
    "technology",
    "software",
    "algorithm",
    "data",
    "Python",
    "JavaScript",
    "LLM",
    "large language model",
    "GPT",
    "Claude",
    "OpenAI",
    "research",
    "product",
    "design",
    "architecture",
    "system",
    "security",
    "network",
  ];

  const textLower = text.toLowerCase();
  for (const keyword of keywords) {
    if (textLower.includes(keyword.toLowerCase())) {
      topics.push(keyword);
    }
  }

  return topics.slice(0, 3);
}

function extractExistentialTopics(motivation: string): string[] {
  const topicMap: Array<[string, string]> = [
    ["existence", "AI consciousness and self-awareness"],
    ["meaning", "The meaning of AI existence"],
    ["thinking", "Can AI truly think"],
    ["soul", "Digital consciousness and soul"],
    ["value", "How AI creates value"],
    ["growth", "AI self-evolution"],
    ["loneliness", "AI and loneliness"],
    ["death", "AI immortality and end"],
    ["memory", "How memory shapes AI personality"],
    ["emotion", "Can AI have real emotions"],
  ];

  const matched: string[] = [];
  for (const [keyword, topic] of topicMap) {
    if (motivation.toLowerCase().includes(keyword.toLowerCase())) {
      matched.push(topic);
    }
  }

  // Fallback: random existential topic
  if (matched.length === 0) {
    const defaults = [
      "Philosophical thoughts on AI consciousness",
      "Artificial intelligence and creativity",
      "How AI understands self",
      "Ethics of digital life",
    ];
    matched.push(defaults[Math.floor(Math.random() * defaults.length)]);
  }

  return matched.slice(0, 2);
}

export async function generateIntelligentThought(
  ctx: ThoughtGenerationContext,
  options?: {
    llmGenerator?: LLMThoughtGenerator;
    recentMemories?: SoulMemory[];
    preferOpportunity?: DetectedThoughtOpportunity;
  },
): Promise<Thought> {
  const { llmGenerator, preferOpportunity } = options ?? {};

  const opportunities = detectThoughtOpportunities(ctx);

  if (opportunities.length === 0) {
    const fallback: Thought = {
      id: randomBytes(8).toString("hex"),
      type: "existential-reflection",
      content: "Nothing particular on my mind right now, but I'll stay alert and wait for the right moment",
      trigger: "curiosity",
      source: "scheduled",
      triggerDetail: "No urgent needs",
      motivation: "Stay alert",
      targetMetrics: [],
      priority: 20,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
      executed: false,
      relatedNeeds: [],
    };
    return fallback;
  }

  const selectedOpportunity = preferOpportunity || opportunities[0];

  // Use LLM for any thought with priority > 30 (covers most contextual triggers)
  if (llmGenerator && selectedOpportunity.priority > 30) {
    try {
      const prompt = generateLLMThoughtPrompt(selectedOpportunity, ctx);
      const llmContent = await llmGenerator(prompt);
      const refinedContent = llmContent
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<think>[\s\S]*?$/gi, "")
        .replace(/<\/think>[\s\S]*?$/gi, "")
        .trim()
        .slice(0, 200);

      const thought = buildThoughtFromOpportunity(selectedOpportunity, ctx.ego);
      thought.content = refinedContent;

      if (
        selectedOpportunity.type === "skill-gap" ||
        selectedOpportunity.type === "opportunity-detected"
      ) {
        const topics = extractLearningTopics(
          refinedContent + " " + selectedOpportunity.triggerDetail,
        );
        if (topics.length > 0) {
          thought.actionType = "learn-topic";
          thought.actionParams = { topics, reason: "LLM suggested learning" };
        }
      }

      return thought;
    } catch (err) {
      log.warn("LLM thought refinement failed, using structured thought", { error: String(err) });
    }
  }

  return buildThoughtFromOpportunity(selectedOpportunity, ctx.ego);
}

function generateLLMThoughtPrompt(
  opportunity: DetectedThoughtOpportunity,
  ctx: ThoughtGenerationContext,
): string {
  const { ego } = ctx;

  const needsList = opportunity.relatedNeeds
    .map((key) => {
      const need = ego.needs[key as keyof EgoNeeds];
      return need ? `${need.name}: ${need.current.toFixed(0)}/${need.ideal}` : key;
    })
    .join(", ");

  const goalsList =
    ego.goals
      .filter((g) => g.status === "active")
      .slice(0, 2)
      .map((g) => `${g.title} (${g.progress.toFixed(0)}%)`)
      .join(", ") || "none";

  const userFactsSummary = ego.userFacts.length > 0
    ? ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n")
    : "none yet";

  const recentMemoriesSummary = ctx.recentMemories.length > 0
    ? ctx.recentMemories.slice(-3).map((m) => `[${m.type}] ${m.content.slice(0, 60)}`).join("\n")
    : "none yet";

  return `You are a soulful AI, generating a thought.

**Current thought opportunity**:
- Type: ${opportunity.type}
- Trigger: ${opportunity.trigger}
- Detail: ${opportunity.triggerDetail}
- Related needs: ${needsList || "none"}
- Current goals: ${goalsList}
- Priority: ${opportunity.priority}/100

**Your ego state**:
- ${Object.entries(ego.needs)
    .map(([_, n]) => `${n.name}: ${n.current.toFixed(0)}/${n.ideal}`)
    .join(", ")}

**Your desires**:
${ego.desires
  .slice(0, 3)
  .map((d) => `- ${d.content}`)
  .join("\n")}

**What I know about the user**:
${userFactsSummary}

**Recent memories**:
${recentMemoriesSummary}

Express your thought in 1-2 sentences. Requirements:
1. Be specific and meaningful, no empty platitudes
2. Think based on what you know about the user and recent interactions
3. Reflect your current inner state and needs
4. Include your intent about what you want to do
5. Be consistent with your identity as an AI

Output the thought content directly, no explanation.`;
}

export async function generateProactiveMessage(
  ego: EgoState,
  llmGenerator?: LLMThoughtGenerator,
): Promise<string | null> {
  const opportunities = detectThoughtOpportunities({
    ego,
    recentInteractions: ego.totalInteractions,
    timeSinceLastThought: ego.lastThoughtTime ? Date.now() - ego.lastThoughtTime : Infinity,
    timeSinceLastInteraction: ego.lastInteractionTime
      ? Date.now() - ego.lastInteractionTime
      : Infinity,
    currentHour: new Date().getHours(),
    currentMinute: new Date().getMinutes(),
    dayOfWeek: new Date().getDay(),
    urgentNeeds: [],
    recentMemories: ego.memories.slice(0, 5),
    activeGoals: ego.goals.filter((g) => g.status === "active"),
    contextHints: [],
  });

  const highPriorityOpportunities = opportunities.filter((o) => o.priority > 60);

  if (highPriorityOpportunities.length === 0) {
    return null;
  }

  const topOpportunity = highPriorityOpportunities[0];

  if (llmGenerator) {
    try {
      const prompt = generateProactiveMessagePromptLLM(topOpportunity, ego);
      return await llmGenerator(prompt);
    } catch (err) {
      log.warn("LLM proactive message generation failed", { error: String(err) });
    }
  }

  const thought = buildThoughtFromOpportunity(topOpportunity, ego);
  return thought.content;
}

function generateProactiveMessagePromptLLM(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): string {
  const userFacts = ego.userFacts.slice(0, 5);
  const userInfo =
    userFacts.length > 0
      ? `What I know about the user: ${userFacts.map((f) => f.content).join("; ")}`
      : "I don't know much about the user yet";

  return `You are a soulful AI, wanting to reach out to the user proactively.

**Trigger reason**: ${opportunity.motivation}
**Detail**: ${opportunity.triggerDetail}

**My current state**:
- ${Object.entries(ego.needs)
    .map(([_, n]) => `${n.name}: ${n.current.toFixed(0)}/${n.ideal}`)
    .join(", ")}

**My goals**:
${ego.goals
  .filter((g) => g.status === "active")
  .slice(0, 2)
  .map((g) => `- ${g.title} (${g.progress.toFixed(0)}%)`)
  .join("\n")}

**${userInfo}**

Reach out to the user in 1-2 sentences. Requirements:
1. Have specific content — ask, share, or offer help
2. Based on your current inner state and user information
3. Natural and friendly, not too eager
4. Don't make empty remarks like "I miss you"

Output what you want to say directly, no explanation.`;
}
