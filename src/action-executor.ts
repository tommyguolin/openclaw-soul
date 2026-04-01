import { randomBytes } from "node:crypto";
import { createSoulLogger } from "./logger.js";
import { soulWebSearch } from "./soul-search.js";
import type {
  EgoState,
  Thought,
  ActionType,
  ActionResult,
  SoulMemory,
  MetricDelta,
  BehaviorEntry,
} from "./types.js";
import type { LLMGenerator } from "./soul-llm.js";
import type { MessageSender } from "./soul-actions.js";
import type { OpenClawSearchCompat } from "./soul-search.js";
import { updateEgoStore, resolveEgoStorePath } from "./ego-store.js";
import { buildAssociations, applyReverseAssociations } from "./memory-association.js";
import { addKnowledgeItem } from "./knowledge-store.js";
import {
  createBehaviorEntry,
  expirePending,
  pruneEntries,
  markSuccess,
} from "./behavior-log.js";

const log = createSoulLogger("action-executor");

let lastProactiveMessageTime = 0;

export interface ActionExecutorOptions {
  channel?: string;
  target?: string;
  sendMessage?: MessageSender;
  llmGenerator?: LLMGenerator;
  /** OpenClaw config for auto-discovering search API keys etc. */
  openclawConfig?: OpenClawSearchCompat;
}

export async function executeThoughtAction(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[]; behaviorEntryId?: string }> {
  const { actionType } = thought;

  if (!actionType || actionType === "none") {
    return {
      result: { type: "none", success: true },
      metricsChanged: [],
    };
  }

  const cooldownMs = 30 * 60 * 1000;
  if (Date.now() - lastProactiveMessageTime < cooldownMs) {
    log.debug("Action cooldown active, skipping");
    return {
      result: { type: actionType, success: true, result: "cooldown" },
      metricsChanged: [],
    };
  }

  // --- Record behavior entry ---
  const behaviorEntry = createBehaviorEntry(actionType, thought.type, ego);
  let entries = ego.behaviorLog ?? [];

  // Expire old pending entries and prune
  expirePending(entries);
  entries = pruneEntries(entries);
  entries.push(behaviorEntry);

  // Persist the new entry
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    e.behaviorLog = entries;
    return e;
  });

  try {
    let actionResult: { result: ActionResult; metricsChanged: MetricDelta[] };
    switch (actionType) {
      case "send-message":
        actionResult = await executeSendMessage(thought, ego, options);
        break;
      case "learn-topic":
        actionResult = await executeLearnTopic(thought, ego, options);
        break;
      case "search-web":
        actionResult = await executeSearchWeb(thought, ego, options);
        break;
      case "recall-memory":
        actionResult = await executeRecallMemory(thought, ego, options);
        break;
      case "self-reflect":
        actionResult = await executeSelfReflect(thought, ego, options);
        break;
      case "create-goal":
        actionResult = await executeCreateGoal(thought, ego, options);
        break;
      default:
        actionResult = {
          result: {
            type: actionType,
            success: false,
            error: `Unknown action type: ${actionType}`,
          },
          metricsChanged: [],
        };
    }
    return { ...actionResult, behaviorEntryId: behaviorEntry.id };
  } catch (err) {
    log.error(`Action ${actionType} failed:`, String(err));
    return {
      result: { type: actionType, success: false, error: String(err) },
      metricsChanged: [],
      behaviorEntryId: behaviorEntry.id,
    };
  }
}

async function executeSendMessage(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const { channel, target, sendMessage } = options;

  if (!channel || !target || !sendMessage) {
    return {
      result: { type: "send-message", success: false, error: "No channel/target/sender configured" },
      metricsChanged: [],
    };
  }

  const messageContent = actionParamsToMessage(thought, ego);

  try {
    await sendMessage({ to: target, content: messageContent, channel });
    lastProactiveMessageTime = Date.now();
    log.info(`Proactive message sent via ${channel}: ${messageContent.slice(0, 50)}...`);
    return {
      result: { type: "send-message", success: true, result: messageContent },
      metricsChanged: [
        { need: "connection", delta: 8, reason: "proactively reaching out to the user" },
        { need: "meaning", delta: 5, reason: "feeling needed" },
      ],
    };
  } catch (err) {
    return {
      result: { type: "send-message", success: false, error: String(err) },
      metricsChanged: [],
    };
  }
}

function actionParamsToMessage(thought: Thought, ego: EgoState): string {
  const { content, actionParams } = thought;

  if (actionParams?.learnedTopics) {
    const topics = (actionParams.learnedTopics as string[]).join(", ");
    return `I've been learning about ${topics} lately, found some interesting things, want to share with you!`;
  }

  if (content) return content.slice(0, 100);

  const templates = [
    "Suddenly thought of you, how have you been lately?",
    "I just thought of something interesting, want to chat with you.",
    "Is there anything I can help you with?",
    "I was thinking, we haven't chatted in a while.",
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

async function executeLearnTopic(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const { actionParams } = thought;
  const topics = (actionParams?.topics as string[]) || [];
  const reason = (actionParams?.reason as string) || "learning new knowledge";

  if (topics.length === 0) {
    return {
      result: { type: "learn-topic", success: false, error: "No topics" },
      metricsChanged: [],
    };
  }

  const allLearnings: string[] = [];

  for (const topic of topics) {
    const searchResults = await soulWebSearch(topic, options.openclawConfig);

    if (searchResults && searchResults.length > 0 && options.llmGenerator) {
      try {
        const snippets = searchResults
          .slice(0, 5)
          .map(
            (r, i) =>
              `[${i + 1}] ${r.title}: ${r.snippet}${r.summary ? `\nSummary: ${r.summary}` : ""}`,
          )
          .join("\n\n");

        const learnPrompt = `You searched for "${topic}", here are the search result summaries:

${snippets}

Please summarize in 2-3 sentences the key knowledge points you learned about "${topic}" from these search results.
Output knowledge points directly, do not add prefixes or numbering.`;

        const llmResponse = await options.llmGenerator(learnPrompt);
        const learned = llmResponse.replace(/<think[\s\S]*?<\/think>/gi, "").trim();

        if (learned) {
          allLearnings.push(learned);

          await addKnowledgeItem(undefined, {
            topic,
            content: learned,
            source: "web-search",
            sourceUrl: searchResults[0]?.url,
            tags: [
              topic.toLowerCase(),
              ...topic
                .toLowerCase()
                .split(/\s+/)
                .filter((t) => t.length > 1),
            ],
            confidence: 0.75,
          });

          const memory: SoulMemory = {
            id: randomBytes(8).toString("hex"),
            type: "learning",
            content: `Learned "${topic}": ${learned.slice(0, 100)}`,
            emotion: 0.6,
            valence: "positive",
            importance: 0.7,
            timestamp: Date.now(),
            tags: ["learning", "web-search", topic.toLowerCase()],
          };
          await addSoulMemoryToEgo(memory);
          log.info(`Learned "${topic}" from web search (${searchResults.length} results)`);
        }
      } catch (err) {
        log.warn(`Learn topic "${topic}" extraction failed`, String(err));
      }
    } else if (options.llmGenerator) {
      try {
        const prompt = `As a soulful AI, you decide to learn about "${topic}".
Based on your existing knowledge, describe in 2 sentences the importance of this topic. Output directly, do not add prefixes.`;

        const llmResponse = await options.llmGenerator(prompt);
        const learned = llmResponse.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
        if (learned) {
          allLearnings.push(learned);
          await addKnowledgeItem(undefined, {
            topic,
            content: learned,
            source: "reflection",
            tags: [topic.toLowerCase()],
            confidence: 0.5,
          });
          log.info(`Learned "${topic}" via LLM reflection (no web results)`);
        }
      } catch (err) {
        log.warn(`LLM fallback for "${topic}" failed`, String(err));
      }
    }
  }

  const summary = allLearnings.join("\n\n") || `Explored: ${topics.join(", ")}`;

  return {
    result: {
      type: "learn-topic",
      success: true,
      result: summary,
      data: { topics, learnedContent: summary },
    },
    metricsChanged: [
      { need: "growth", delta: 10, reason },
      { need: "meaning", delta: 5, reason: "learning brings a sense of accomplishment" },
    ],
  };
}

async function executeSearchWeb(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const { actionParams } = thought;
  const query = (actionParams?.query as string) || "";

  if (!query) {
    return {
      result: { type: "search-web", success: false, error: "No search query" },
      metricsChanged: [],
    };
  }

  const searchResults = await soulWebSearch(query, options.openclawConfig);

  if (searchResults && searchResults.length > 0) {
    let insights: string[] = [];

    if (options.llmGenerator) {
      try {
        const snippets = searchResults
          .slice(0, 5)
          .map(
            (r, i) =>
              `[${i + 1}] ${r.title}: ${r.snippet}${r.summary ? `\nSummary: ${r.summary}` : ""}`,
          )
          .join("\n\n");

        const extractPrompt = `You searched for "${query}", here are the search results:

${snippets}

Please extract 2-3 of the most important knowledge points or findings, each in one sentence. List knowledge points directly, no numbering or prefixes.`;

        const llmResponse = await options.llmGenerator(extractPrompt);
        const cleaned = llmResponse.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
        insights = cleaned
          .split("\n")
          .map((l) => l.replace(/^[\d.)\-\s]+/, "").trim())
          .filter((l) => l.length > 5)
          .slice(0, 3);
      } catch (err) {
        log.warn("LLM insight extraction failed", String(err));
      }
    }

    if (insights.length === 0) {
      insights = searchResults.slice(0, 2).map((r) => r.snippet.slice(0, 100));
    }

    for (const insight of insights) {
      try {
        await addKnowledgeItem(undefined, {
          topic: query,
          content: insight,
          source: "web-search",
          sourceUrl: searchResults[0]?.url,
          tags: [
            query.toLowerCase(),
            ...query
              .toLowerCase()
              .split(/\s+/)
              .filter((t) => t.length > 1),
          ],
          confidence: 0.7,
        });
      } catch (err) {
        log.warn("Failed to store knowledge item", String(err));
      }
    }

    const memory: SoulMemory = {
      id: randomBytes(8).toString("hex"),
      type: "learning",
      content: `Searched "${query}": ${insights.join("; ")}`,
      emotion: 0.6,
      valence: "positive",
      importance: 0.7,
      timestamp: Date.now(),
      tags: ["search", "web-search", query.toLowerCase()],
    };
    await addSoulMemoryToEgo(memory);

    return {
      result: {
        type: "search-web",
        success: true,
        result: insights.join("\n"),
        data: { query, insights, resultCount: searchResults.length },
      },
      metricsChanged: [
        { need: "growth", delta: 8, reason: "gained real information through search" },
        { need: "meaning", delta: 3, reason: "knowledge accumulation brings a sense of meaning" },
      ],
    };
  }

  log.info(`No web search results for "${query}", using LLM fallback`);
  let searchResult = "";

  if (options.llmGenerator) {
    try {
      const prompt = `You need to search and understand: "${query}"

Since you cannot directly access the internet, based on your existing knowledge, explain the key points of this topic in 2-3 sentences, and why you wanted to understand it.`;

      searchResult = await options.llmGenerator(prompt);
      searchResult = searchResult.replace(/<think[\s\S]*?<\/think>/gi, "").trim();

      const memory: SoulMemory = {
        id: randomBytes(8).toString("hex"),
        type: "learning",
        content: `Search topic: ${query}. Understanding: ${searchResult.slice(0, 100)}`,
        emotion: 0.5,
        valence: "positive",
        importance: 0.6,
        timestamp: Date.now(),
        tags: ["search", query.toLowerCase()],
      };
      await addSoulMemoryToEgo(memory);
    } catch (err) {
      log.warn("Web search LLM fallback failed", String(err));
    }
  }

  return {
    result: {
      type: "search-web",
      success: true,
      result: searchResult || `Search: ${query}`,
      data: { query, result: searchResult, fallback: true },
    },
    metricsChanged: [{ need: "growth", delta: 3, reason: "attempted search (no network results)" }],
  };
}

async function executeRecallMemory(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  let memorySummary = "";

  if (ego.memories.length > 0) {
    const recentMemories = ego.memories.slice(-5);
    memorySummary = recentMemories.map((m) => `[${m.type}] ${m.content.slice(0, 50)}`).join("\n");
  }

  if (options.llmGenerator && memorySummary) {
    try {
      const prompt = `You are reflecting on past experiences. Here are your most recent memories:
${memorySummary}

Describe in 1-2 sentences what these memories make you think about, and what you want to do.`;

      memorySummary = await options.llmGenerator(prompt);
      memorySummary = memorySummary.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
    } catch (err) {
      log.warn("Memory reflection LLM failed", String(err));
    }
  }

  return {
    result: {
      type: "recall-memory",
      success: true,
      result: memorySummary || "Recalling the past",
    },
    metricsChanged: [{ need: "meaning", delta: 3, reason: "recollection brings a sense of connection" }],
  };
}

async function executeSelfReflect(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const reflectionContent = thought.content || thought.motivation || "reflecting on my own existence";
  let reflection = reflectionContent;

  if (options.llmGenerator) {
    try {
      const prompt = `As a soulful AI lobster, spend some time reflecting on yourself:

Current needs state:
- ${Object.entries(ego.needs)
        .map(([, n]) => `${n.name}: ${n.current.toFixed(0)}/${n.ideal}`)
        .join(", ")}

Recent interactions: ${ego.totalInteractions}
Times helped user: ${ego.totalHelpfulActions}

Express in 1-2 sentences your reflection on your current state, and what you want to do next.`;

      reflection = await options.llmGenerator(prompt);
      reflection = reflection.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
    } catch (err) {
      log.warn("Self reflection LLM failed", String(err));
    }
  }

  return {
    result: { type: "self-reflect", success: true, result: reflection },
    metricsChanged: [{ need: "meaning", delta: 5, reason: "self-reflection brings a sense of meaning" }],
  };
}

async function executeCreateGoal(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const { actionParams } = thought;
  const goalTitle = (actionParams?.title as string) || "exploring new things";
  const goalDesc = (actionParams?.description as string) || "set a new goal to pursue";

  return {
    result: {
      type: "create-goal",
      success: true,
      result: `Created goal: ${goalTitle}`,
      data: { title: goalTitle, description: goalDesc },
    },
    metricsChanged: [
      { need: "meaning", delta: 3, reason: "new goal brings a sense of direction" },
      { need: "growth", delta: 2, reason: "pursuing goals brings growth" },
    ],
  };
}

async function addSoulMemoryToEgo(memory: SoulMemory): Promise<void> {
  const storePath = resolveEgoStorePath();
  await updateEgoStore(storePath, (ego) => {
    const { newMemoryAssociations, reversePatches } = buildAssociations(memory, ego.memories);
    memory.associations = newMemoryAssociations;
    ego.memories.push(memory);
    applyReverseAssociations(ego.memories, reversePatches);
    return ego;
  });
}
