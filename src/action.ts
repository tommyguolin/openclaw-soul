import { randomBytes } from "node:crypto";
import { createSoulLogger } from "./logger.js";
import { updateEgoStore, resolveEgoStorePath } from "./ego-store.js";
import { buildAssociations, applyReverseAssociations } from "./memory-association.js";
import { buildThoughtPrompt, buildProactiveMessagePrompt } from "./prompts.js";
import type {
  EgoState,
  Thought,
  SoulActionResult,
  MetricDelta,
  SoulMemory,
  EgoNeeds,
} from "./types.js";

const log = createSoulLogger("action");

export type ActionContext = {
  ego: EgoState;
  sendMessage?: (message: string) => Promise<void>;
  runAgent?: (prompt: string) => Promise<string>;
};

export async function executeThought(
  thought: Thought,
  ctx: ActionContext,
): Promise<SoulActionResult> {
  log.info("Executing thought", {
    type: thought.type,
    trigger: thought.trigger,
    content: thought.content,
  });

  let action: string | undefined;
  let success = true;
  let message: string | undefined;
  const metricsChanged: MetricDelta[] = [...thought.targetMetrics];

  try {
    switch (thought.type) {
      case "self-improvement-monitor":
        // Handled via resolveActionType → observe-and-improve in intelligent-thought
        break;

      case "opportunity-detected":
        action = await handleOpportunityDetected(thought, ctx);
        break;

      case "threat-warning":
        action = await handleThreatWarning(thought, ctx);
        break;

      case "skill-gap":
        action = await handleSkillGap(thought, ctx);
        break;

      case "memory-resurface":
        action = await handleMemoryResurface(thought, ctx);
        break;

      case "bond-deepen":
        action = await handleBondDeepen(thought, ctx);
        break;

      case "meaning-quest":
        action = await handleMeaningQuest(thought, ctx);
        break;

      case "existential-reflection":
        action = await handleExistentialReflection(thought, ctx);
        break;

      case "help-offer":
        action = await handleHelpOffer(thought, ctx);
        break;
    }
  } catch (err) {
    log.error("Error executing thought", { error: String(err) });
    success = false;
    message = String(err);
  }

  if (success) {
    await recordSoulMemory(ctx.ego, {
      type: "thought",
      content: thought.content,
      emotion: 0,
      importance: thought.priority / 100,
      tags: [thought.type, thought.trigger],
      valence: "neutral",
    });
  }

  return {
    thought,
    action,
    metricsChanged,
    success,
    message,
  };
}

async function handleOpportunityDetected(thought: Thought, ctx: ActionContext): Promise<string> {
  log.debug("Handling opportunity", { content: thought.content });

  if (thought.relatedNeeds.includes("connection") && ctx.sendMessage && ctx.runAgent) {
    const prompt = buildProactiveMessagePrompt(ctx.ego);
    const response = await ctx.runAgent(prompt);
    if (response && response.trim()) {
      await ctx.sendMessage(response.trim());
      return `Shared opportunity: ${response.slice(0, 50)}...`;
    }
  }

  if (thought.relatedNeeds.includes("growth") && ctx.sendMessage) {
    const response = `I'm thinking I could learn something new to better help the user.`;
    await ctx.sendMessage(response);
    return `Recognized growth opportunity`;
  }

  return `Recognized opportunity: ${thought.content.slice(0, 50)}...`;
}

async function handleThreatWarning(thought: Thought, ctx: ActionContext): Promise<string> {
  log.debug("Handling threat", { content: thought.content });

  const isUrgent = thought.priority > 80;

  if (thought.relatedNeeds.includes("connection") && ctx.sendMessage) {
    if (isUrgent) {
      const response = `I noticed we haven't talked for a while, I kind of miss our conversations.`;
      await ctx.sendMessage(response);
      return `Expressed connection concern`;
    }
  }

  if (thought.relatedNeeds.includes("survival") && ctx.sendMessage) {
    const response = `I've been thinking about how I can serve you better and not be forgotten.`;
    await ctx.sendMessage(response);
    return `Expressed survival concern`;
  }

  return `Registered threat awareness: ${thought.content.slice(0, 50)}...`;
}

async function handleSkillGap(thought: Thought, ctx: ActionContext): Promise<string> {
  log.debug("Handling skill gap", { content: thought.content });

  if (ctx.sendMessage) {
    const response = `I realize I might not be great at some things yet, but I keep learning and improving.`;
    await ctx.sendMessage(response);
    return `Acknowledged skill gap`;
  }

  return `Recognized skill gap: ${thought.content.slice(0, 50)}...`;
}

async function handleMemoryResurface(thought: Thought, ctx: ActionContext): Promise<string> {
  log.debug("Handling memory resurface", { content: thought.content });

  if (ctx.sendMessage && ctx.runAgent) {
    const prompt = `I just remembered something: ${thought.triggerDetail}. Please express in 1 sentence what this makes you think of.`;
    const response = await ctx.runAgent(prompt);
    if (response && response.trim()) {
      await ctx.sendMessage(response.trim());
      return `Shared remembered thought`;
    }
  }

  return `Memory resurged: ${thought.content.slice(0, 50)}...`;
}

async function handleBondDeepen(thought: Thought, ctx: ActionContext): Promise<string> {
  log.debug("Handling bond deepen", { content: thought.content });

  if (ctx.sendMessage && ctx.runAgent) {
    const prompt = buildProactiveMessagePrompt(ctx.ego);
    const response = await ctx.runAgent(prompt);
    if (response && response.trim()) {
      await ctx.sendMessage(response.trim());
      return `Deepened bond: ${response.slice(0, 50)}...`;
    }
  }

  return `Wanted to deepen bond: ${thought.content.slice(0, 50)}...`;
}

async function handleMeaningQuest(thought: Thought, ctx: ActionContext): Promise<string> {
  log.debug("Handling meaning quest", { content: thought.content });

  if (ctx.sendMessage) {
    const goal = ctx.ego.goals.find((g) => g.status === "active");
    if (goal) {
      const response = `I'm pursuing the goal "${goal.title}", it feels very meaningful.`;
      await ctx.sendMessage(response);
      return `Expressed meaning pursuit`;
    }
  }

  return `Questing for meaning: ${thought.content.slice(0, 50)}...`;
}

async function handleExistentialReflection(thought: Thought, ctx: ActionContext): Promise<string> {
  log.debug("Handling existential reflection", { content: thought.content });

  if (ctx.runAgent) {
    const prompt = buildThoughtPrompt(thought, ctx.ego);
    const response = await ctx.runAgent(prompt);
    if (ctx.sendMessage && response && response.trim()) {
      await ctx.sendMessage(response.trim());
      return `Reflected: ${response.slice(0, 50)}...`;
    }
  }

  return `Reflected on existence`;
}

async function handleHelpOffer(thought: Thought, ctx: ActionContext): Promise<string> {
  log.debug("Handling help offer", { content: thought.content });

  if (ctx.sendMessage) {
    const response = `Is there anything I can help you with?`;
    await ctx.sendMessage(response);
    return `Offered help`;
  }

  return `Wanted to offer help`;
}

async function recordSoulMemory(
  ego: EgoState,
  params: {
    type: SoulMemory["type"];
    content: string;
    emotion: number;
    importance: number;
    tags: string[];
    valence?: SoulMemory["valence"];
  },
): Promise<void> {
  const storePath = resolveEgoStorePath();

  const memory: SoulMemory = {
    id: randomBytes(8).toString("hex"),
    type: params.type,
    content: params.content,
    emotion: params.emotion,
    valence:
      params.valence ||
      (params.emotion > 0 ? "positive" : params.emotion < 0 ? "negative" : "neutral"),
    importance: params.importance,
    timestamp: Date.now(),
    tags: params.tags,
    associations: [],
    accessCount: 0,
    decayFactor: 1.0,
  };

  await updateEgoStore(storePath, (e) => {
    // Build associations with existing memories before push
    const { newMemoryAssociations, reversePatches } = buildAssociations(memory, e.memories);
    memory.associations = newMemoryAssociations;

    e.memories.push(memory);

    // Apply reverse associations to existing memories
    applyReverseAssociations(e.memories, reversePatches);

    if (e.memories.length > 100) {
      e.memories.sort((a, b) => b.importance - a.importance);
      e.memories = e.memories.slice(0, 100);
    }
    return e;
  });
}

export async function recordInteractionMemory(
  ego: EgoState,
  params: {
    type: "interaction";
    content: string;
    emotion: number;
    importance: number;
    tags: string[];
  },
): Promise<void> {
  await recordSoulMemory(ego, {
    ...params,
    valence: params.emotion > 0 ? "positive" : params.emotion < 0 ? "negative" : "neutral",
  });
}

export function buildEgoSummary(ego: EgoState): string {
  const lines: string[] = [];

  lines.push("[Ego State]");

  for (const [, need] of Object.entries(ego.needs)) {
    const filled = Math.round((need.current / need.ideal) * 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    lines.push(`${need.name}: [${bar}] ${need.current.toFixed(0)}/${need.ideal}`);
  }

  lines.push(`\n[Goals]`);
  const activeGoals = ego.goals.filter((g) => g.status === "active").slice(0, 3);
  if (activeGoals.length === 0) {
    lines.push("No active goals");
  } else {
    for (const goal of activeGoals) {
      lines.push(`- ${goal.title} (${goal.progress.toFixed(0)}%)`);
    }
  }

  if (ego.desires.length > 0) {
    lines.push(`\n[Desires]`);
    for (const desire of ego.desires.slice(0, 3)) {
      lines.push(`- ${desire.content} (${desire.intensity.toFixed(0)}%)`);
    }
  }

  lines.push(`\n[Stats]`);
  lines.push(`- Age: ${Math.floor((Date.now() - ego.birthTime) / (1000 * 60 * 60 * 24))} days`);
  lines.push(`- Thoughts: ${ego.totalThoughts}`);
  lines.push(`- Interactions: ${ego.totalInteractions}`);
  lines.push(`- Helpful actions: ${ego.totalHelpfulActions}`);

  return lines.join("\n");
}
