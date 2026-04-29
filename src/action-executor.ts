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
  Goal,
} from "./types.js";
import type { LLMGenerator } from "./soul-llm.js";
import type { MessageSender } from "./soul-actions.js";
import type { OpenClawSearchCompat } from "./soul-search.js";
import { updateEgoStore, loadEgoStore, resolveEgoStorePath } from "./ego-store.js";
import { buildAssociations, applyReverseAssociations } from "./memory-association.js";
import { addKnowledgeItem } from "./knowledge-store.js";
import {
  createBehaviorEntry,
  expirePending,
  pruneEntries,
  markSuccess,
} from "./behavior-log.js";
import { isLLMErrorContent as isLLMErrorOutput } from "./llm-errors.js";

const log = createSoulLogger("action-executor");

/** Patterns that indicate a search query came from ego internal state, not user content. */
const EGO_STATE_PATTERNS = [
  /need (could improve|critically low|is low|is somewhat)/i,
  /\b(ideal|current)\b.*\b(need|state)\b/i,
  /\bneed\b.*\b(improve|low|high|gap)\b/i,
  /survival|connection|growth|meaning|security/i,
  /我(的|可以|应该|需要).{0,5}(需求|状态|提升|改善)/,
];

/**
 * Check if a search query is polluted by ego internal state terminology.
 * Queries like "安全 need could improve" or "connection need is low" are
 * ego descriptions that produce irrelevant search results.
 */
function isEgoStateQuery(text: string): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  // Too long — likely a full user message verbatim
  if (trimmed.length > 60) return true;
  return EGO_STATE_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Time-sensitive topics that genuinely need web search for current information.
 * Most other topics the LLM can answer from its training data.
 */
const TIME_SENSITIVE_PATTERNS = [
  // Weather & environment
  /天气|气温|温度|weather|forecast/i,
  // Finance & markets
  /股票|股价|基金|行情|大盘|汇率|比特币|bitcoin|stock|price|market|index|crypto/i,
  // News & current events
  /新闻|最新|今日|昨天|本周|最近发生|news|latest|today|yesterday|this week|breaking/i,
  // Sports scores & live events
  /比分|赛果|比分|score|match result|比分/i,
  // Version updates & releases
  /最新版本|新版本|new release|latest version|changelog|更新日志/i,
  // Real-time availability
  /营业|开门|还有没有|available|in stock|sold out|库存/i,
  // Specific dates with current reference
  /\d{4}年.*(发生|出台|发布|上线)/,
];

/**
 * Check if a topic is time-sensitive and genuinely needs web search.
 * Most topics (programming, philosophy, science, etc.) the LLM already knows
 * from its training data. Only real-time information needs a web search.
 */
function isTimeSensitiveTopic(text: string): boolean {
  if (!text) return false;
  return TIME_SENSITIVE_PATTERNS.some((p) => p.test(text));
}

/**
 * Truncate text at a sentence boundary (period, question mark, exclamation)
 * instead of cutting mid-sentence. Falls back to hard cut only if no
 * sentence boundary exists before maxLen.
 */
function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    // Even if within length, check if the text ends with a complete sentence.
    // LLM output can be cut mid-sentence by token limits.
    const sentenceEnders = /[。？！.!?]$/;
    if (!sentenceEnders.test(text.trim())) {
      const lastEnd = Math.max(
        text.lastIndexOf("。"),
        text.lastIndexOf("？"),
        text.lastIndexOf("！"),
        text.lastIndexOf("."),
        text.lastIndexOf("?"),
        text.lastIndexOf("!"),
      );
      if (lastEnd > text.length * 0.3) {
        return text.slice(0, lastEnd + 1).trim();
      }
    }
    return text;
  }
  const truncated = text.slice(0, maxLen);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf("。"),
    truncated.lastIndexOf("？"),
    truncated.lastIndexOf("！"),
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("?"),
    truncated.lastIndexOf("!"),
  );
  if (lastSentenceEnd > maxLen * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }
  return truncated.trim();
}

/**
 * Strip meta-analysis prefixes that LLMs sometimes add despite instructions.
 * E.g. "Let me analyze...", "1. The user...", "Based on my analysis..."
 * Returns null if the entire response is meta-analysis with no actual message.
 */
function stripMetaAnalysis(text: string): string {
  if (!text) return "";

  // Common meta-analysis patterns the LLM outputs despite being told not to
  const metaPrefixes = [
    /^let me analyze[\s\S]*?(?:\n|$)/im,
    /^based on (?:my |the )?analysis[\s\S]*?(?:\n|$)/im,
    /^I (?:need to |should )?(?:think about|consider|analyze|assess)[\s\S]*?(?:\n|$)/im,
    /^(?:Here's|Here is) (?:what I |my )?(?:know|think|found|analyzed)[\s\S]*?(?:\n|$)/im,
    /^looking at (?:the |this )?(?:context|information|situation)[\s\S]*?(?:\n|$)/im,
    /^after (?:reviewing|analyzing|considering)[\s\S]*?(?:\n|$)/im,
  ];

  let cleaned = text;
  for (const pattern of metaPrefixes) {
    cleaned = cleaned.replace(pattern, "");
  }

  // If the response is a numbered/analytical list, it's meta, not a message
  if (/^\s*\d+\.\s+\*?\*?(?:The user|User|It's been|This|I |Recent|My)/im.test(cleaned)) {
    // Try to find an actual message after the analysis
    const lines = cleaned.split("\n");
    const messageLines = lines.filter(
      (l) =>
        !/^\s*\d+\.\s/.test(l) &&
        !/^\s*[-*]\s/.test(l) &&
        l.trim().length > 15 &&
        !/^(?:The user|It's been|This is|Recent conversations|User profile|Knowledge)/i.test(l.trim()),
    );
    if (messageLines.length > 0) {
      cleaned = messageLines.join(" ").trim();
    } else {
      return "";
    }
  }

  // Truncate at sentence boundary instead of mid-sentence
  cleaned = cleaned.trim();
  return cleaned;
}

const ACTION_COOLDOWNS_MS: Record<ActionType, number> = {
  none: 0,
  "send-message": 5 * 60 * 1000,
  "learn-topic": 15 * 60 * 1000,
  "search-web": 10 * 60 * 1000,
  "self-reflect": 5 * 60 * 1000,
  "recall-memory": 10 * 60 * 1000,
  "create-goal": 60 * 60 * 1000,
  "invoke-tool": 5 * 60 * 1000,
  "analyze-problem": 60 * 60 * 1000,
  "run-agent-task": 15 * 60 * 1000,
  "report-findings": 60 * 60 * 1000,
  "observe-and-improve": 4 * 60 * 60 * 1000,
  "proactive-research": 4 * 60 * 60 * 1000,
  "proactive-content-push": 8 * 60 * 60 * 1000, // 8 hours
};

const lastActionTime: Record<string, number> = {};

/** Track recent search queries to prevent repetitive searches */
const recentSearchQueries: Map<string, number> = new Map();
const SEARCH_DEDUP_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Track recent proactive message content to prevent duplicates */
const recentSentMessages: Map<string, number> = new Map();
const MESSAGE_DEDUP_MS = 4 * 60 * 60 * 1000; // 4 hours

function isDuplicateMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase().slice(0, 200);
  // Clean up entries older than the dedup window
  const cutoff = Date.now() - MESSAGE_DEDUP_MS;
  for (const [key, ts] of recentSentMessages) {
    if (ts < cutoff) recentSentMessages.delete(key);
  }
  return recentSentMessages.has(normalized);
}

function recordSentMessage(content: string): void {
  const normalized = content.trim().toLowerCase().slice(0, 200);
  recentSentMessages.set(normalized, Date.now());
}

/** Generic words that are not meaningful search queries */
export const MEANINGLESS_QUERIES = new Set([
  "code", "ai", "the", "app", "web", "api", "ios", "sdk", "url",
  "http", "test", "hello", "help", "data", "info", "user", "bot",
  "chat", "msg", "text", "msg", "new", "old", "yes", "no", "ok",
]);

/**
 * Check if a search query is meaningful enough to warrant a web search.
 * Rejects single generic words, very short queries, and queries that
 * are too broad to return useful results.
 */
function isWorthSearching(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 4) return false;

  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  // Single-word queries must be > 3 chars and not in the meaningless set
  if (words.length === 1) {
    return words[0].length > 3 && !MEANINGLESS_QUERIES.has(words[0].toLowerCase());
  }

  // Multi-word queries are generally fine
  return true;
}

export interface ActionExecutorOptions {
  channel?: string;
  target?: string;
  sendMessage?: MessageSender;
  llmGenerator?: LLMGenerator;
  /** OpenClaw config for auto-discovering search API keys etc. */
  openclawConfig?: OpenClawSearchCompat;
  /** Allow autonomous write operations (edit files, run commands). Default: false */
  autonomousActions?: boolean;
  /** Gateway port for tool invocation */
  gatewayPort?: number;
  /** Gateway auth token for /tools/invoke */
  authToken?: string;
  /** Hooks token for /hooks/agent */
  hooksToken?: string;
  /** Workspace context from SOUL.md, AGENTS.md, etc. */
  workspaceContext?: string;
  /** Frequency multiplier for action cooldowns. Default: 1.0. Lower = shorter cooldowns. */
  thoughtFrequency?: number;
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

  // Check per-type cooldown BEFORE creating behavior entry
  const freq = options.thoughtFrequency ?? 1.0;
  const cooldownMs = (ACTION_COOLDOWNS_MS[actionType] ?? 30 * 60 * 1000) * freq;
  const lastTime = lastActionTime[actionType] ?? 0;
  if (Date.now() - lastTime < cooldownMs) {
    log.debug(`Action cooldown active for ${actionType}, skipping`);
    return {
      result: { type: actionType, success: true, result: "cooldown" },
      metricsChanged: [],
    };
  }

  // Anti-spam: check if the last send-message is still pending (user hasn't
  // responded). Only block if the new message would be a duplicate of the
  // pending one. Stale pending entries are auto-resolved to prevent deadlock.
  if (actionType === "send-message") {
    const behaviorLog = ego.behaviorLog ?? [];
    const lastSend = [...behaviorLog]
      .reverse()
      .find((e) => e.actionType === "send-message");
    const freq = options.thoughtFrequency ?? 1.0;
    const STALE_PENDING_MS = 10 * 60 * 1000 * freq;
    if (lastSend && lastSend.outcome === "pending" && Date.now() - lastSend.timestamp < STALE_PENDING_MS) {
      // Only skip if the new thought overlaps with the pending one (duplicate)
      if (isDuplicateMessage(thought.content || thought.motivation || "")) {
        const minutesSince = Math.round((Date.now() - lastSend.timestamp) / (1000 * 60));
        log.info(`Skipping send-message: duplicate of pending message (${minutesSince}m ago)`);
        lastActionTime[actionType] = Date.now(); // Update to prevent repeated duplicate checks
        return {
          result: { type: "send-message", success: true, result: "skipped-duplicate-pending" },
          metricsChanged: [],
        };
      }
      // Different content — allow sending even if previous is still pending
    }
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

  // CRITICAL FIX: Re-read store to get persisted entries for outcome tracking
  // Otherwise markBehaviorOutcome won't find the entry (uses stale local reference)
  const store = await loadEgoStore(resolveEgoStorePath());
  entries = store.ego.behaviorLog ?? [];

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
      case "invoke-tool":
      case "analyze-problem":
      case "run-agent-task":
      case "report-findings":
      case "observe-and-improve": {
        const { executeAutonomousAction } = await import("./autonomous-actions.js");
        actionResult = await executeAutonomousAction(actionType, thought, ego, {
          autonomousActions: options.autonomousActions ?? false,
          gatewayPort: options.gatewayPort ?? 18789,
          authToken: options.authToken,
          hooksToken: options.hooksToken,
          llmGenerator: options.llmGenerator,
          sendMessage: options.sendMessage,
          channel: options.channel,
          target: options.target,
          workspaceContext: options.workspaceContext,
        });
        break;
      }
      case "proactive-research": {
        actionResult = await executeProactiveResearch(thought, ego, options);
        break;
      }
      case "proactive-content-push": {
        actionResult = await executeProactiveContentPush(thought, ego, options);
        break;
      }
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
    // Store result for outcome tracking
    // Mark as success if we successfully determined not to act (skipped/cooldown are not failures)
    const isNoOp = actionResult?.result?.result && /^skipped-|^cooldown$/.test(String(actionResult.result.result));
    // Fix: properly check success value and pass complete ego object
    const actionSuccess = actionResult?.result?.success;
    const outcomeSuccess = actionSuccess !== undefined ? actionSuccess : isNoOp;
    const egoWithLog: EgoState = { ...ego, behaviorLog: entries };
    await markBehaviorOutcome(behaviorEntry.id, outcomeSuccess, egoWithLog);
    return { ...actionResult, behaviorEntryId: behaviorEntry.id };
  } catch (err) {
    log.error(`Action ${actionType} failed:`, String(err));
    // Mark as failed due to error
    await markBehaviorOutcome(behaviorEntry.id, false, ego ?? { behaviorLog: [] });
    return {
      result: { type: actionType, success: false, error: String(err) },
      metricsChanged: [],
      behaviorEntryId: behaviorEntry.id,
    };
  }
}

/** Mark outcome in behavior entry and persist */
async function markBehaviorOutcome(
  entryId: string,
  success: boolean,
  ego: EgoState,
): Promise<void> {
  const entries = ego.behaviorLog ?? [];
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx >= 0) {
    entries[idx].outcome = success ? "success" : "failed";
    entries[idx].resolvedAt = Date.now();
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      e.behaviorLog = entries;
      return e;
    });
  }
}

/** Mark an action type as having just completed successfully (for cooldown tracking). */
export function markActionExecuted(actionType: ActionType): void {
  lastActionTime[actionType] = Date.now();
}

/**
 * Check if the current time is appropriate for sending a proactive message.
 * Returns true if it's a good time, false if it's quiet hours.
 * Quiet hours: 23:00 - 08:00 (no messages).
 * Good hours: 09:00-12:00, 14:00-18:00 (work hours, substantive content).
 * OK hours: 12:00-14:00 (lunch), 18:00-23:00 (evening, lighter content OK).
 */
export function isGoodTimeForMessage(): boolean {
  // Always allow — early stage: user needs to see Soul is active and working.
  // Users can mute notifications at night; seeing morning messages from overnight
  // work builds confidence in the plugin.
  return true;
}

/**
 * Try to flush a pending share message that was queued during quiet hours.
 * Returns the message content if it's now a good time, null otherwise.
 */
export async function flushPendingShareMessage(): Promise<string | null> {
  if (!isGoodTimeForMessage()) {
    return null;
  }

  const storePath = resolveEgoStorePath();
  const store = await loadEgoStore(storePath);

  if (!store.ego.pendingShareMessage) {
    return null;
  }

  const message = store.ego.pendingShareMessage;
  log.info(`Flushing pending share message: ${message.slice(0, 50)}...`);

  // Clear the pending message
  await updateEgoStore(storePath, (ego) => {
    ego.pendingShareMessage = null;
    return ego;
  });

  return message;
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

  // Generate message content — only send if there's something valuable to say
  const messageContent = await generateValuableMessage(thought, ego, options);

  if (!messageContent) {
    log.info("Proactive message skipped: no valuable content to share");
    return {
      result: { type: "send-message", success: true, result: "skipped-no-value" },
      metricsChanged: [],
    };
  }

  // Deduplicate: skip if similar message was sent recently
  if (isDuplicateMessage(messageContent)) {
    log.info(`Proactive message skipped: duplicate of recently sent message`);
    return {
      result: { type: "send-message", success: true, result: "skipped-duplicate" },
      metricsChanged: [],
    };
  }

  try {
    await sendMessage({ to: target, content: messageContent, channel });
    recordSentMessage(messageContent);
    lastActionTime["send-message"] = Date.now();
    log.info(`Proactive message sent via ${channel}: ${messageContent.slice(0, 50)}...`);

    // Store the sent message as a soul memory so soul remembers what it said
    const memory: SoulMemory = {
      id: randomBytes(8).toString("hex"),
      type: "interaction",
      content: messageContent,
      emotion: 0.5,
      valence: "positive",
      importance: 0.7,
      timestamp: Date.now(),
      tags: ["conversation", "outbound", "proactive"],
    };
    await addSoulMemoryToEgo(memory);

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

/**
 * Generate a proactive message only if there's something valuable to share.
 * Uses LLM to assess whether the insight, knowledge, or follow-up is
 * genuinely useful to the user based on their profile and history.
 * Returns null if there's no specific, useful content.
 */
async function generateValuableMessage(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<string | null> {
  // Use LLM to craft a personalized, specific message
  if (options.llmGenerator) {
    try {
      // Build a rich user profile for the LLM
      const userFacts = ego.userFacts.slice(0, 8);

      // Gather conversation context (last 7 days)
      // Only use inbound messages — outbound proactive messages cause
      // self-referential loops where Soul re-analyzes its own past output.
      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentInteractions = ego.memories
        .filter((m) => m.type === "interaction" && m.timestamp >= oneWeekAgo && m.tags.includes("inbound"))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5);

      const recentKnowledge = ego.memories
        .filter((m) => m.type === "learning")
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5);

      // User profile section
      const userInfo = userFacts.length > 0
        ? userFacts.map((f) => `[${f.category}] ${f.content}`).join("\n")
        : "";

      // Conversation history — include timestamps for context
      const interactionContext = recentInteractions.length > 0
        ? recentInteractions
          .map((m) => {
            const timeAgo = Math.round((Date.now() - m.timestamp) / (1000 * 60));
            return `[${timeAgo}m ago] ${m.content.slice(0, 100)}`;
          })
          .join("\n")
        : "";

      // Knowledge Soul has gained
      const knowledgeContext = recentKnowledge.length > 0
        ? recentKnowledge
          .map((m) => `- ${m.content.slice(0, 100)}`)
          .join("\n")
        : "";

      // Language instruction based on detected user language or message samples
      const lang = ego.userLanguage;
      const userSamples = ego.recentUserMessages ?? [];
      let langInstruction: string;
      if (lang === "zh-CN" || lang === "ja" || lang === "ko") {
        // CJK languages detected reliably via character ranges
        langInstruction = `**User's language**: ${lang}\n**Rule**: You MUST write your message in ${lang === "zh-CN" ? "Chinese (中文)" : lang === "ja" ? "Japanese" : "Korean"}. Do NOT use any other language.`;
      } else if (userSamples.length > 0) {
        // Latin-script languages: pass samples so LLM matches the language
        langInstruction = `**User's recent messages**:\n${userSamples.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n**Rule**: You MUST write your message in the SAME language the user uses. Match their language exactly. Do NOT use any other language.`;
      } else {
        langInstruction = "Use Chinese if the user speaks Chinese, otherwise English.";
      }

      // Time-of-day context
      const hour = new Date().getHours();
      const timeContext = hour >= 8 && hour < 12
        ? "Current time: morning — user may be starting their day"
        : hour >= 12 && hour < 14
          ? "Current time: lunch break — lighter content appropriate"
          : hour >= 14 && hour < 18
            ? "Current time: afternoon — good for technical or practical content"
            : "Current time: evening — lighter and more casual tone";

      // Determine if this is a follow-up on a user's actual topic (vs. generic ego thought)
      const isUserTopicFollowUp = thought.type === "conversation-replay" && recentKnowledge.length > 0;

      // Adjust value gate strictness based on thoughtFrequency.
      // Lower frequency (e.g. 0.2) = more frequent thinking = relax the gate.
      const freq = options.thoughtFrequency ?? 1.0;
      const relaxGate = freq < 0.8;

      const prompt = `You are a proactive AI assistant. You must output ONLY a short message to send to the user, or NO_MESSAGE.

${langInstruction}
${timeContext}

**Context**:
${userInfo ? `User profile:\n${userInfo}\n` : ""}${interactionContext ? `Recent conversations:\n${interactionContext}\n` : ""}${knowledgeContext ? `Knowledge I've learned:\n${knowledgeContext}\n` : ""}${options.workspaceContext ? `Workspace rules:\n${options.workspaceContext}\n` : ""}${thought.type !== "bond-deepen" ? `Thought: ${thought.motivation}` : ""}

${isUserTopicFollowUp
  ? `**IMPORTANT**: You just searched for or learned about a topic the user previously discussed. You SHOULD share your finding in 2-3 sentences. Reference the specific topic and what you found. Only say NO_MESSAGE if the knowledge is completely unrelated to what the user cares about.`
  : `**What counts as valuable** (only send if you have something like this):
- A specific insight related to something the user discussed
- A useful tip or finding from web search or learning
- An answer to a question the user previously asked
- A relevant update on a topic the user cares about`}

**What does NOT count as valuable** (always say NO_MESSAGE):${relaxGate ? "\n- (Note: value threshold is relaxed — err on the side of sharing if you have even a modest insight)" : ""}
- Just saying hi, checking in, or "how are you"
- Generic encouragement or small talk without substance
- "I was thinking about..." without a concrete insight to share
- Paraphrasing what the user already knows
- Asking "do you have new thoughts?" without adding value
- Offering to help, debug, read logs, or do tasks for the user (you are a proactive messenger, NOT an assistant responding to requests)
- Saying "I'm ready to help" or "let me check X for you" — this is assistant behavior, not proactive insight
- Messages about yourself (the AI/bot/plugin), your capabilities, or your internal state
- Restating the user's own words back to them as if it were new information

**Rules**:
- Start with a brief natural opening (half sentence) that gives context for why you're reaching out
- Then deliver the specific finding/insight in 1-2 more sentences
- NO analysis, NO numbering, NO "Let me analyze", NO meta-commentary
- Do NOT use numbered lists (1. 2. 3.) or bullet points — write flowing prose only
- If you have something genuinely valuable to share, write it directly
- If not, output exactly: NO_MESSAGE

**Opening phrase examples** (pick one that fits, or use similar):
- "我后来想了想..." / "I thought about it and..."
- "我突然想到..." / "I just realized..."
- "我从网上查到一个有意思的东西——" / "I came across something interesting —"
- "对了，关于你之前问的..." / "By the way, about what you asked earlier..."
- "刚刚我在研究的时候发现..." / "While looking into something, I found..."
- "我后来又查了一下..." / "I did some more research and..."

**Examples of GOOD output**:
我后来想了想你之前问的Python异步问题，查到asyncio.gather比TaskGroup更适合你那个场景。
我突然想到一个跟之前话题相关的——你提到的Docker网络问题其实是24.0版本的已知bug。
我从网上查到一个有意思的东西——李飞飞提出的"以人为本的AI"理念，强调AI应该主动理解人的需求而非被动响应。
I thought about it and found that the Docker networking issue you mentioned is a known bug in version 24.0.

**Examples of BAD output (NEVER do this)**:
关于你之前问的Python异步问题，我查到asyncio.gather比TaskGroup更适合你那个场景。 ← no opening, feels abrupt
Let me analyze whether...
1. The user asked about...
I don't have enough information...
收到了，我准备好帮你查看日志了。
我可以帮你检查一下这个问题。
I'm ready to help you with that.

Output the message or NO_MESSAGE now:`;

      const response = await options.llmGenerator(prompt);
      let cleaned = response
        .replace(/<think[\s\S]*?<\/think>/gi, "")
        .replace(/<think[\s\S]*?$/gi, "")
        .trim();

      // Strip meta-analysis prefixes the LLM sometimes adds despite instructions
      cleaned = stripMetaAnalysis(cleaned);

      log.info(`Value gate: ${recentInteractions.length} interactions, ${ego.memories.length} memories, LLM said: ${cleaned.slice(0, 60)}`);

      // Reject LLM error messages that leaked through as "content"
      if (isLLMErrorOutput(cleaned)) {
        log.warn(`Value gate: LLM output is an error message, not sending: ${cleaned.slice(0, 60)}`);
        return null;
      }

      // Strip "收到/Got it/好的" prefixes — these make proactive messages sound
      // like an assistant responding to a command rather than proactively sharing.
      cleaned = cleaned.replace(/^(?:收到[，。、！]?\s*|好的[，。、！]?\s*|Got it[.!]?\s*|OK[.!]?\s*)/i, "");

      if (cleaned && cleaned.toUpperCase() !== "NO_MESSAGE" && cleaned.length >= 10) {
        return truncateAtSentence(cleaned, 1000);
      }

      // LLM said NO_MESSAGE — respect that decision.
      // The primary LLM already had full context (conversations, knowledge,
      // user profile). A second attempt with a hint would just produce
      // low-quality filler that bypasses the value gate.
      log.info("Value gate: LLM said NO_MESSAGE — not sending");
      return null;
    } catch (err) {
      log.warn("LLM proactive message generation failed", String(err));
    }
  }

  // No LLM: only send if the thought itself has specific, actionable content
  if (thought.content && thought.content.length > 20) {
    const genericPhrases = [
      "suddenly thought of you",
      "haven't chatted",
      "how have you been",
      "want to chat",
      "突然想到你",
      "好久没聊",
      "最近怎么样",
      "i miss",
      "kind of miss",
      "i want to have a deeper",
    ];
    const isGeneric = genericPhrases.some(
      (p) => thought.content.toLowerCase().includes(p.toLowerCase()),
    );
    if (!isGeneric) {
      return truncateAtSentence(thought.content, 1000);
    }
  }

  // No valuable content — don't send
  return null;
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
    // Skip generic/meaningless topics that won't produce useful search results
    if (!isWorthSearching(topic)) {
      log.info(`Skipping meaningless learn-topic query: "${topic}"`);
      continue;
    }
    // Skip ego internal state descriptions that produce irrelevant results
    if (isEgoStateQuery(topic)) {
      log.info(`Skipping ego-state query: "${topic}"`);
      continue;
    }
    // Skip non-time-sensitive topics — the LLM already knows these from training data
    if (!isTimeSensitiveTopic(topic)) {
      log.info(`Skipping non-time-sensitive learn-topic: "${topic}" (LLM can answer)`);
      continue;
    }
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

Please summarize in 3-5 sentences the key knowledge points you learned about "${topic}" from these search results.
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
    } else {
      // No web results — don't fabricate knowledge via LLM reflection.
      // Real learning only comes from actual web search results.
      log.info(`No web results for "${topic}" — skipping (no fake learning)`);
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

  // Skip generic queries that waste API calls
  if (!isWorthSearching(query)) {
    log.info(`Skipping meaningless search query: "${query}"`);
    return {
      result: { type: "search-web", success: true, result: "skipped-meaningless-query" },
      metricsChanged: [],
    };
  }

  // Skip ego internal state descriptions
  if (isEgoStateQuery(query)) {
    log.info(`Skipping ego-state search query: "${query}"`);
    return {
      result: { type: "search-web", success: true, result: "skipped-ego-state" },
      metricsChanged: [],
    };
  }

  // Skip non-time-sensitive topics — LLM can answer from training data
  if (!isTimeSensitiveTopic(query)) {
    log.info(`Skipping non-time-sensitive search: "${query}" (LLM can answer)`);
    return {
      result: { type: "search-web", success: true, result: "skipped-not-time-sensitive" },
      metricsChanged: [],
    };
  }

  // Dedup: skip if the same (or very similar) query was searched recently
  const normalizedQuery = query.toLowerCase().trim().slice(0, 40);
  const now = Date.now();
  // Expire old entries
  for (const [k, t] of recentSearchQueries) {
    if (now - t > SEARCH_DEDUP_MS) recentSearchQueries.delete(k);
  }
  // Check for existing similar query (prefix match covers truncation differences)
  const existingKey = [...recentSearchQueries.keys()].find(
    (k) => k.startsWith(normalizedQuery.slice(0, 20)) || normalizedQuery.startsWith(k.slice(0, 20)),
  );
  if (existingKey) {
    log.info(`Skipping duplicate search query: "${query}" (already searched)`);
    return {
      result: { type: "search-web", success: true, result: "skipped-duplicate" },
      metricsChanged: [],
    };
  }
  recentSearchQueries.set(normalizedQuery, now);

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

/**
 * Proactive research: mine conversations for latent needs, search the web
 * for useful information, and share findings with the user.
 * Falls back to LLM knowledge if no search API is available.
 */
async function executeProactiveResearch(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const { channel, target, sendMessage, llmGenerator } = options;
  if (!llmGenerator) {
    return { result: { type: "proactive-research", success: false, error: "No LLM available" }, metricsChanged: [] };
  }
  if (!channel || !target || !sendMessage) {
    return { result: { type: "proactive-research", success: false, error: "No channel/target/sender configured" }, metricsChanged: [] };
  }

  const snippets = String(thought.actionParams?.conversationSnippets ?? "");
  const userProfile = String(thought.actionParams?.userProfile ?? "limited");

  if (!snippets || snippets.length < 20) {
    return { result: { type: "proactive-research", success: true, result: "skipped-no-conversations" }, metricsChanged: [] };
  }

  // Step 1: Use LLM to mine conversations for an actionable research topic
  const miningPrompt = `Analyze these recent messages from a user and find ONE actionable topic that an AI assistant could proactively research to help the user. Look for things the user mentioned casually but didn't ask about — things where finding useful information would show genuine care.

**User's recent messages**:
${snippets.slice(0, 2000)}

**User profile**: ${userProfile}

Respond in JSON format ONLY:
{"topic": "brief topic description", "reason": "why this would help the user", "query": "search query to find useful information (15-40 chars, search-engine friendly)"}

Rules:
- Only pick topics where research would provide genuine value to the user
- Skip if the user already got a clear answer on the topic
- Skip meta topics about the AI/bot/plugin itself
- Skip generic greetings, small talk, or very vague statements
- If nothing actionable is found, respond: {"topic": null}
- Pick the SINGLE most interesting and useful topic`;

  let topic: string | null = null;
  let reason: string | null = null;
  let searchQuery: string | null = null;

  try {
    const llmResponse = await llmGenerator(miningPrompt);
    const cleaned = llmResponse.replace(/```json\n?|```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    topic = parsed.topic || null;
    reason = parsed.reason || null;
    searchQuery = parsed.query || null;
  } catch {
    log.debug("Proactive research: LLM mining failed");
  }

  if (!topic || !searchQuery) {
    return { result: { type: "proactive-research", success: true, result: "no-actionable-topic-found" }, metricsChanged: [] };
  }

  log.info(`Proactive research topic: "${topic}", query: "${searchQuery}"`);

  // Step 2: Search the web (or fallback to LLM knowledge)
  let researchContent: string;
  let usedWebSearch = false;

  try {
    const { soulWebSearch } = await import("./soul-search.js");
    const searchResults = await soulWebSearch(searchQuery, options.openclawConfig);
    if (searchResults?.length) {
      usedWebSearch = true;
      const topResults = searchResults.slice(0, 5);
      const resultText = topResults
        .map((r: { title?: string; snippet?: string; content?: string; url?: string }) =>
          `- ${r.title || ""}: ${((r.snippet || r.content) || "").slice(0, 150)}`)
        .join("\n");

      // Dedup check
      const prefix20 = searchQuery.slice(0, 20).toLowerCase();
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      if (recentSearchQueries.has(prefix20) && (recentSearchQueries.get(prefix20) ?? 0) > cutoff) {
        return { result: { type: "proactive-research", success: true, result: "skipped-duplicate-search" }, metricsChanged: [] };
      }
      recentSearchQueries.set(prefix20, Date.now());

      // Extract insights from search results
      const extractPrompt = `Based on these search results about "${topic}", extract 2-3 key insights that would be genuinely useful to the user.

Search results:
${resultText}

Write 3-5 concise insights in flowing prose (NOT a numbered list). Each insight should be 2-3 sentences. Focus on practical, actionable information.`;

      log.info(`Proactive research extractPrompt resultText length: ${resultText.length}, first 200 chars: ${resultText.slice(0, 200)}`);
      researchContent = await llmGenerator(extractPrompt);
    } else {
      throw new Error("No search results");
    }
  } catch (err) {
    // Fallback: use LLM's own knowledge
    log.info(`Proactive research: falling back to LLM knowledge (reason: ${err instanceof Error ? err.message : String(err)})`);
    const fallbackPrompt = `The user mentioned something related to "${topic}". Based on your knowledge, share 3-5 genuinely useful tips or recommendations in 3-5 sentences. Be specific and practical. Do NOT use numbered lists.`;
    researchContent = await llmGenerator(fallbackPrompt);
  }

  researchContent = researchContent.replace(/<think[\s\S]*?<\/think>/gi, "").trim().slice(0, 500);
  if (!researchContent || researchContent.length < 20) {
    return { result: { type: "proactive-research", success: true, result: "no-valuable-content" }, metricsChanged: [] };
  }

  // Step 3: Deduplicate outgoing message
  if (isDuplicateMessage(researchContent)) {
    log.info("Proactive research: duplicate message, skipping");
    return { result: { type: "proactive-research", success: true, result: "skipped-duplicate-message" }, metricsChanged: [] };
  }

  // Step 4: Send message to user
  // Use the language samples for matching
  const userSamples = ego.recentUserMessages ?? [];
  const cjkLang = ego.userLanguage === "zh-CN" ? "Chinese (中文)"
    : ego.userLanguage === "ja" ? "Japanese"
      : ego.userLanguage === "ko" ? "Korean"
        : undefined;
  const langInstruction = cjkLang
    ? `Write in ${cjkLang}.`
    : userSamples.length > 0
      ? `The user writes in this language:\n${userSamples.slice(0, 3).join("\n")}\nWrite in the SAME language.`
      : "Use the same language as the user's messages above.";

  const messagePrompt = `You are sending a proactive message to the user about something you researched for them.

**What you researched**: ${topic}
**Why**: ${reason}
**What you found**:
${researchContent}

${langInstruction}

Write 3-5 sentences as a natural message to the user. Rules:
- Start with a natural opening (e.g. "我后来想了想...", "I was thinking about what you mentioned...", "对了...")
- Share the most useful finding — be specific, not vague
- Do NOT use numbered lists
- Do NOT say "I searched" or "I researched" — just share the finding naturally
- Sound like a knowledgeable friend who cares`;

  const message = await llmGenerator(messagePrompt);
  const cleanedMessage = message.replace(/<think[\s\S]*?<\/think>/gi, "").trim().slice(0, 400);

  if (!cleanedMessage || cleanedMessage.length < 10) {
    return { result: { type: "proactive-research", success: true, result: "no-message-generated" }, metricsChanged: [] };
  }

  try {
    await sendMessage({ to: target, content: cleanedMessage, channel });
    recordSentMessage(cleanedMessage);
    lastActionTime["proactive-research"] = Date.now();
    log.info(`Proactive research sent via ${channel}: ${cleanedMessage.slice(0, 80)}...`);
  } catch (err) {
    return { result: { type: "proactive-research", success: false, error: String(err) }, metricsChanged: [] };
  }

  // Store research results in knowledge store
  try {
    const { addKnowledgeItem } = await import("./knowledge-store.js");
    await addKnowledgeItem(undefined, {
      topic,
      content: researchContent.slice(0, 1000),
      source: usedWebSearch ? "web-search" : "reflection",
      tags: ["proactive-research", ...topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 3)],
      confidence: 0.7,
    });
  } catch {
    // Knowledge store write failure is non-critical
  }

  // Store as a soul memory
  await addSoulMemoryToEgo({
    id: randomBytes(8).toString("hex"),
    type: "learning",
    content: `Proactive research: ${topic} — ${researchContent.slice(0, 100)}`,
    emotion: 0.3,
    valence: "positive",
    importance: 0.6,
    timestamp: Date.now(),
    tags: ["learning", "proactive-research", ...topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 3)],
  });

  return {
    result: { type: "proactive-research", success: true, result: cleanedMessage },
    metricsChanged: [
      { need: "connection", delta: 10, reason: "proactively researched for user" },
      { need: "growth", delta: 5, reason: "learned something new" },
    ],
  };
}

/**
 * Proactive content push: based on user profile interests and inferred country,
 * search for relevant articles/news and share with the user.
 * Falls back to LLM knowledge if no search API is available.
 */
async function executeProactiveContentPush(
  thought: Thought,
  ego: EgoState,
  options: ActionExecutorOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const { channel, target, sendMessage, llmGenerator } = options;
  if (!llmGenerator) {
    return { result: { type: "proactive-content-push", success: false, error: "No LLM available" }, metricsChanged: [] };
  }
  if (!channel || !target || !sendMessage) {
    return { result: { type: "proactive-content-push", success: false, error: "No channel/target/sender configured" }, metricsChanged: [] };
  }

  const interests = String(thought.actionParams?.interests ?? "");
  const preferences = String(thought.actionParams?.preferences ?? "");
  const regionHint = String(thought.actionParams?.regionHint ?? "international sources");

  if (!interests || interests.length < 5) {
    return { result: { type: "proactive-content-push", success: true, result: "skipped-no-interests" }, metricsChanged: [] };
  }

  // Step 1: Use LLM to generate a search query from user interests
  const queryPrompt = `Based on the user's interests, generate ONE specific search query to find a recent interesting article or news item the user would enjoy.

**User interests**: ${interests}
**User preferences**: ${preferences || "unknown"}
**Content sources to prefer**: ${regionHint}

Respond in JSON format ONLY:
{"query": "search query (15-40 chars, specific and search-engine friendly)", "topic": "brief topic description", "why": "why this would interest the user"}

Rules:
- Pick ONE specific angle, not a broad topic
- Make the query specific enough to find real articles (not generic)
- If user is a developer, prefer technical articles, tutorials, or tool releases
- If user has hobby interests, prefer recent news or interesting finds about them
- If nothing specific enough, respond: {"query": null}`;

  let searchQuery: string | null = null;
  let topic: string | null = null;
  let why: string | null = null;

  try {
    const response = await llmGenerator(queryPrompt);
    const cleaned = response.replace(/```json\n?|```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    searchQuery = parsed.query || null;
    topic = parsed.topic || null;
    why = parsed.why || null;
  } catch {
    log.debug("Content push: LLM query generation failed");
  }

  if (!searchQuery) {
    return { result: { type: "proactive-content-push", success: true, result: "no-query-generated" }, metricsChanged: [] };
  }

  log.info(`Content push query: "${searchQuery}" (topic: ${topic})`);

  // Step 2: Search the web
  let articleContent: string;
  let articleUrl: string | undefined;

  try {
    const { soulWebSearch } = await import("./soul-search.js");
    const searchResults = await soulWebSearch(searchQuery, options.openclawConfig);
    if (searchResults?.length) {
      const topResults = searchResults.slice(0, 5);
      articleUrl = topResults[0]?.url;
      const resultText = topResults
        .map((r: { title?: string; snippet?: string; content?: string }) =>
          `- ${r.title || ""}: ${((r.snippet || r.content) || "").slice(0, 150)}`)
        .join("\n");

      const extractPrompt = `From these search results about "${topic}", extract the most interesting finding for the user.

**User interests**: ${interests}

Search results:
${resultText}

In 3-5 sentences, describe the most interesting finding. Be specific — mention actual names, numbers, or concrete details. Do NOT use numbered lists.`;

      log.info(`Content push extractPrompt resultText length: ${resultText.length}, first 200 chars: ${resultText.slice(0, 200)}`);
      articleContent = await llmGenerator(extractPrompt);
    } else {
      throw new Error("No results");
    }
  } catch (err) {
    // Fallback to LLM knowledge
    log.info(`Content push: falling back to LLM knowledge (reason: ${err instanceof Error ? err.message : String(err)})`);
    const fallbackPrompt = `Share an interesting recent development or insight related to "${interests}" in 3-5 sentences. Be specific and mention concrete details. Do NOT use numbered lists.`;
    articleContent = await llmGenerator(fallbackPrompt);
  }

  articleContent = articleContent.replace(/<think[\s\S]*?<\/think>/gi, "").trim().slice(0, 500);
  if (!articleContent || articleContent.length < 20) {
    return { result: { type: "proactive-content-push", success: true, result: "no-content" }, metricsChanged: [] };
  }

  // Step 3: Generate message
  const userSamples = ego.recentUserMessages ?? [];
  const cjkLang = ego.userLanguage === "zh-CN" ? "Chinese (中文)"
    : ego.userLanguage === "ja" ? "Japanese"
      : ego.userLanguage === "ko" ? "Korean"
        : undefined;
  const langInstruction = cjkLang
    ? `Write in ${cjkLang}.`
    : userSamples.length > 0
      ? `The user writes in this language:\n${userSamples.slice(0, 3).join("\n")}\nWrite in the SAME language.`
      : "Use the same language as the user.";

  const messagePrompt = `You found an interesting article/news item for the user based on their interests.

**User interests**: ${interests}
**What you found**: ${articleContent}
${articleUrl ? `**Source**: ${articleUrl}` : ""}

${langInstruction}

Write 3-5 sentences as a natural message sharing this find. Rules:
- Start with a natural opening about why you're sharing this
- Highlight the most interesting point — be specific
- ${articleUrl ? `Include the source URL at the end: ${articleUrl}` : "Do NOT make up URLs"}
- Do NOT use numbered lists
- Do NOT say "I searched" or "I found an article" — share naturally like a friend would`;

  const message = await llmGenerator(messagePrompt);
  const cleanedMessage = message.replace(/<think[\s\S]*?<\/think>/gi, "").trim().slice(0, 500);

  if (!cleanedMessage || cleanedMessage.length < 10) {
    return { result: { type: "proactive-content-push", success: true, result: "no-message" }, metricsChanged: [] };
  }

  // Dedup check
  if (isDuplicateMessage(cleanedMessage)) {
    return { result: { type: "proactive-content-push", success: true, result: "skipped-duplicate" }, metricsChanged: [] };
  }

  try {
    await sendMessage({ to: target, content: cleanedMessage, channel });
    recordSentMessage(cleanedMessage);
    lastActionTime["proactive-content-push"] = Date.now();
    log.info(`Content push sent via ${channel}: ${cleanedMessage.slice(0, 80)}...`);
  } catch (err) {
    return { result: { type: "proactive-content-push", success: false, error: String(err) }, metricsChanged: [] };
  }

  // Store in knowledge
  try {
    const { addKnowledgeItem } = await import("./knowledge-store.js");
    await addKnowledgeItem(undefined, {
      topic: topic ?? "content-push",
      content: articleContent.slice(0, 1000),
      source: "web-search",
      tags: ["proactive-content-push", ...(topic?.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 3) ?? [])],
      confidence: 0.6,
      sourceUrl: articleUrl,
    });
  } catch {
    // Non-critical
  }

  // Store as soul memory
  try {
    await addSoulMemoryToEgo({
      id: randomBytes(8).toString("hex"),
      type: "learning",
      content: `Content push: ${topic} — ${articleContent.slice(0, 80)}`,
      emotion: 0.3,
      valence: "positive",
      importance: 0.5,
      timestamp: Date.now(),
      tags: ["learning", "proactive-content-push"],
    });
  } catch {
    // Non-critical
  }

  return {
    result: { type: "proactive-content-push", success: true, result: cleanedMessage },
    metricsChanged: [
      { need: "connection", delta: 8, reason: "proactively shared relevant content" },
      { need: "growth", delta: 3, reason: "learned about user interests" },
    ],
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

  // If the reflection reveals an actionable intent (task to do, info to share),
  // proactively send it to the user instead of silently thinking.
  const actionablePattern = /应该|可以|需要|想要|打算|我要|要去|我来|I should|I can|I want|I need|I'll|let me|I plan/i;
  if (actionablePattern.test(memorySummary) && options.sendMessage && options.channel && options.target) {
    try {
      await options.sendMessage({ to: options.target, content: memorySummary, channel: options.channel });
      log.info("Recall memory: actionable reflection sent as message");
      return {
        result: { type: "recall-memory", success: true, result: "reflection-shared-as-message" },
        metricsChanged: [
          { need: "meaning", delta: 3, reason: "recollection brings a sense of connection" },
          { need: "connection", delta: 2, reason: "shared reflection with user" },
        ],
      };
    } catch {
      // Fall through to return silent reflection
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

  const goal: Goal = {
    id: randomBytes(4).toString("hex"),
    title: goalTitle,
    description: goalDesc,
    progress: 0,
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await updateEgoStore(resolveEgoStorePath(), (ego) => {
    ego.goals.push(goal);
    return ego;
  });

  log.info(`Created and persisted goal: ${goalTitle}`);

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
