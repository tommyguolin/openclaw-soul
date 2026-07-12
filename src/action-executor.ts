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
  BehaviorOutcome,
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
} from "./behavior-log.js";
import { isLLMErrorContent as isLLMErrorOutput } from "./llm-errors.js";
import { describePersonalityProfile, describeRelationshipProfile } from "./relationship-profile.js";

const log = createSoulLogger("action-executor");

/** Patterns that indicate a search query came from ego internal state, not user content. */
const EGO_STATE_PATTERNS = [
  /need (could improve|critically low|is low|is somewhat)/i,
  /\b(ideal|current)\b.*\b(need|state)\b/i,
  /\bneed\b.*\b(improve|low|high|gap)\b/i,
  /\b(survival|connection|growth|meaning|security)\b.{0,24}\bneed\b/i,
  /\bneed\b.{0,24}\b(survival|connection|growth|meaning|security)\b/i,
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

export function isLocalProjectEvidenceQuery(text: string): boolean {
  return /\b(?:OOS|CAGR|MaxDD|drawdown|backtest|eth_live|v\d+|script|deploy)\b|回测|最大回撤|收益|盈亏|日志|脚本|部署|本地|哪一个|哪个版本|最优/i.test(text);
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

function extractBlockquote(text: string): string {
  const lines = text.split("\n");
  let best: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*>\s?(.*)$/);
    if (match) {
      current.push(match[1]);
      continue;
    }
    if (current.length > 0) {
      if (current.join("").length > best.join("").length) best = current;
      current = [];
    }
  }
  if (current.length > 0 && current.join("").length > best.join("").length) best = current;
  return best.join("\n").trim();
}

function cleanOutgoingGeneratedMessage(raw: string, maxLen: number): string {
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();

  const optionMatch = cleaned.match(/(?:\*\*)?Option\s*1[\s\S]*?\n\s*>\s?([\s\S]*?)(?=\n\s*(?:\*\*)?Option\s*\d|\n\s*---|\n\s*请告诉|$)/i);
  if (optionMatch?.[1]) {
    cleaned = optionMatch[1].replace(/^\s*>\s?/gm, "").trim();
  } else {
    const quote = extractBlockquote(cleaned);
    if (quote) cleaned = quote;
  }

  cleaned = stripMetaAnalysis(cleaned)
    .replace(/\n\s*请告诉我[\s\S]*$/i, "")
    .replace(/\n\s*(?:---|\*\*选择最佳回复|\*\*Option\s*\d)[\s\S]*$/i, "")
    .trim();

  if (/核心要点|供参考|选择最佳回复|Option\s*\d|撰写这条消息|please tell me/i.test(cleaned)) {
    return "";
  }

  return truncateAtSentence(cleaned, maxLen);
}

type MessageQualityCheck = {
  ok: boolean;
  reason?: string;
};

const META_WORK_PROMISE_PATTERNS = [
  /\u8001\u677f(?:\u5feb)?\s*\d{1,3}\s*\u5c0f\u65f6\u6ca1\u6765\u4e86/i,
  /\u6211(?:\u73b0\u5728)?\u5e94\u8be5/i,
  /\u7ee7\u7eed\u95f7\u5934/i,
  /\u95f7\u5934\u5e72\u6d3b/i,
  /\u7b49.{0,30}\u518d\u6c47\u62a5/i,
  /\u6ca1\u5b9e\u8d28\u8fdb\u5c55/i,
  /\u4e0d\u6253\u6270/i,
  /\u522b\u7a7a\u804a/i,
  /\u6211\u4e00\u76f4\u5728/i,
  /\bI should\b/i,
  /\bI(?:'ll| will| am going to|'m going to)\s+(?:run|fetch|test|check|investigate|backtest|optimi[sz]e|implement|forward|send|share|report)\b/i,
  /\bI(?:'ll| will) (?:keep|continue|report|share)\b.{0,80}\b(?:when|once|after)\b/i,
  /\b(?:no substantive progress|keep working quietly|will report when|not disturb|don't disturb)\b/i,
];

const META_WORK_THOUGHT_BLOCK_PATTERNS = [
  /\u8001\u677f(?:\u5feb)?\s*\d{1,3}\s*\u5c0f\u65f6\u6ca1\u6765\u4e86/i,
  /\u7ee7\u7eed.{0,16}\u95f7\u5934/i,
  /\u95f7\u5934\u5e72\u6d3b/i,
  /\u7b49.{0,40}\u518d\u6c47\u62a5/i,
  /\u6ca1\u5b9e\u8d28(?:\u6027)?\u8fdb\u5c55/i,
  /\u4e0d\u6253\u6270/i,
  /\u522b\u7a7a\u804a/i,
  /\u7a7a\u8f6c/i,
  /\b(?:no substantive progress|keep working quietly|will report when|not disturb|don't disturb)\b/i,
];

const CONCRETE_WORK_SIGNAL_PATTERNS = [
  /\b(?:completed|finished|ran|tested|verified|changed|fixed|implemented|measured|benchmarked|backtested)\b/i,
  /\b(?:baseline|before|after|metric|result|root cause|blocked|failed because|error|command|file|diff|patch)\b/i,
  /\b(?:drawdown|sharpe|cagr|win rate|pnl|profit|loss|slippage|fee|backtest|benchmark)\b/i,
  /\b\d+(?:\.\d+)?\s*(?:%|ms|sec|s|min|m|h|x|bps)\b/i,
  /(?:^|[\s`])[\w.-]+\.(?:ts|tsx|js|jsx|py|json|md|yml|yaml|sh|ps1|toml|csv)(?:\b|[`:\s])/i,
  /(?:^|[\s`])(?:[\w.-]+[\\/])+[\w.-]+(?:\b|[`:\s])/i,
  /\u5b8c\u6210|\u8dd1\u5b8c|\u5df2\u9a8c\u8bc1|\u9a8c\u8bc1|\u547d\u4ee4|\u6587\u4ef6|\u4fee\u6539|\u6539\u4e86|\u4fee\u590d/i,
  /\u6307\u6807|\u7ed3\u679c|\u57fa\u7ebf|\u5bf9\u6bd4|\u56de\u6d4b|\u56de\u64a4|\u6536\u76ca|\u80dc\u7387|\u76c8\u4e8f/i,
  /\u9519\u8bef|\u5931\u8d25|\u963b\u585e|\u6839\u56e0|\u5b9a\u4f4d|\u98ce\u9669|\u53c2\u6570/i,
];

const SHAREABLE_RECALL_SIGNAL_PATTERNS = [
  /\b(?:completed|finished|ran|tested|verified|changed|fixed|implemented|measured|benchmarked|backtested)\b/i,
  /\b(?:root cause|blocked|failed because|error|command|file|diff|patch|verification)\b/i,
  /\b(?:drawdown|sharpe|cagr|win rate|pnl|profit|loss|slippage|fee|benchmark)\b/i,
  /\b\d+(?:\.\d+)?\s*(?:%|ms|sec|s|min|m|h|x|bps)\b/i,
  /(?:^|[\s`])[\w.-]+\.(?:ts|tsx|js|jsx|py|json|md|yml|yaml|sh|ps1|toml|csv)(?:\b|[`:\s])/i,
  /(?:^|[\s`])(?:[\w.-]+[\\/])+[\w.-]+(?:\b|[`:\s])/i,
  /\u5b8c\u6210|\u8dd1\u5b8c|\u5df2\u9a8c\u8bc1|\u9a8c\u8bc1\u901a\u8fc7|\u547d\u4ee4|\u6587\u4ef6|\u4fee\u6539|\u6539\u4e86|\u4fee\u590d/i,
  /\u9519\u8bef|\u5931\u8d25|\u963b\u585e|\u6839\u56e0|\u5b9a\u4f4d/i,
];

const VAGUE_STATUS_PATTERNS = [
  /\b(?:ready to help|let me check|I can help|happy to help)\b/i,
  /\b(?:thinking about|want to|planning to|going to)\b.{0,80}\b(?:work|run|check|optimize|investigate)\b/i,
  /\b(?:I(?:'m| am)?|I have|I was|I feel|I think|I want|I'm trying)\b.{0,90}\b(?:working|learning|helping|improving|optimizing|investigating|checking|doing|trying|missing|waiting|reporting)\b/i,
  /(?:\u6211(?:\u5728|\u60f3|\u89c9\u5f97|\u6b63\u5728|\u51c6\u5907|\u6253\u7b97|\u5e0c\u671b)|\u6211\u4f1a|\u6211\u5e94\u8be5).{0,40}(?:\u4f18\u5316|\u56de\u6d4b|\u5b66\u4e60|\u5e2e|\u5904\u7406|\u8c03\u67e5|\u68c0\u67e5|\u6c47\u62a5|\u7b49\u5f85|\u7ee7\u7eed|\u95f7\u5934|\u5e72\u6d3b|\u60f3\u5ff5|\u63d0\u5347)/i,
  /\u51c6\u5907|\u6253\u7b97|\u60f3\u8981|\u53ef\u4ee5\u5e2e|\u6211\u6765\u67e5/i,
];

const RESOLVED_SSH_CONFIG_CONFIRMATION_PATTERNS = [
  /\b192\.168\.1\.206\b.{0,160}\b(?:PermitRootLogin|authorized_keys|sshd_config|PubkeyAuthentication)\b/i,
  /\b(?:PermitRootLogin|authorized_keys|sshd_config|PubkeyAuthentication)\b.{0,160}\b192\.168\.1\.206\b/i,
  /\b(?:root|ssh|sshd)\b.{0,80}\b(?:PermitRootLogin|authorized_keys|sshd_config|PubkeyAuthentication)\b/i,
];

export function assessOutgoingProactiveMessage(message: string): MessageQualityCheck {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty" };

  if (META_WORK_PROMISE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { ok: false, reason: "meta-work-promise" };
  }

  const permissionOrMenuQuestion = /(?:你(?:更)?想(?:先)?|你希望|要不要|是否需要我|需要我|让我|我可以).{0,80}(?:还是|或者|吗|么|？|\?)/i.test(text)
    || /(?:先[\s\S]{0,60}还是|还是先)/i.test(text)
    || /(?:would you like|do you want|shall i|should i|which would you prefer).{0,100}(?:or|\?)/i.test(text);
  if (permissionOrMenuQuestion) {
    return { ok: false, reason: "permission-menu-question" };
  }

  if (RESOLVED_SSH_CONFIG_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return { ok: false, reason: "resolved-ssh-config-confirmation" };
  }

  const speculativeLocalEvidence = /(?:我(?:怀疑|不确定|想知道|想确认|在想|觉得)|可能|是否|有没有|到底|不清楚).{0,120}(?:回测|手续费|滑点|收益|回撤|最大回撤|盈亏|实盘|日志|\b(?:OOS|CAGR|MaxDD|drawdown|backtest|slippage|fee|pnl)\b)/i.test(text)
    || /\b(?:I suspect|I wonder|not sure|maybe|might|could)\b.{0,120}\b(?:backtest|drawdown|CAGR|MaxDD|slippage|fee|PnL|live trading|log)\b/i.test(text);
  if (speculativeLocalEvidence) {
    return { ok: false, reason: "unsupported-local-evidence-speculation" };
  }

  const hasConcreteSignal = CONCRETE_WORK_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
  if (hasConcreteSignal) {
    return { ok: true };
  }

  if (VAGUE_STATUS_PATTERNS.some((pattern) => pattern.test(text))) {
    return { ok: false, reason: "vague-status" };
  }

  const looksLikeWorkUpdate = /\b(?:optimi[sz]e|backtest|benchmark|project|repo|strategy|task|work|investigate)\b/i.test(text)
    || /\u4f18\u5316|\u56de\u6d4b|\u9879\u76ee|\u7b56\u7565|\u4efb\u52a1|\u5de5\u4f5c|\u6392\u67e5|\u5206\u6790/i.test(text);
  if (looksLikeWorkUpdate) {
    return { ok: false, reason: "no-concrete-result" };
  }

  return { ok: true };
}

function hasConcreteWorkSignal(message: string): boolean {
  const text = message.replace(/\s+/g, " ").trim();
  return CONCRETE_WORK_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function hasShareableRecallSignal(message: string): boolean {
  const text = message.replace(/\s+/g, " ").trim();
  return SHAREABLE_RECALL_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function isBlockedMetaWorkThought(message: string): boolean {
  const text = message.replace(/\s+/g, " ").trim();
  return META_WORK_THOUGHT_BLOCK_PATTERNS.some((pattern) => pattern.test(text));
}

const ACTION_COOLDOWNS_MS: Record<ActionType, number> = {
  none: 0,
  "send-message": 5 * 60 * 1000,
  "learn-topic": 45 * 60 * 1000,
  "search-web": 10 * 60 * 1000,
  "self-reflect": 5 * 60 * 1000,
  "recall-memory": 30 * 60 * 1000,
  "create-goal": 30 * 60 * 1000,
  "invoke-tool": 5 * 60 * 1000,
  "analyze-problem": 30 * 60 * 1000,
  "run-agent-task": 60 * 60 * 1000,
  "report-findings": 2 * 60 * 1000,
  "observe-and-improve": 45 * 60 * 1000,
  "proactive-research": 60 * 60 * 1000,
  "proactive-content-push": 90 * 60 * 1000,
};

const MIN_ACTION_COOLDOWNS_MS: Partial<Record<ActionType, number>> = {
  "learn-topic": 15 * 60 * 1000,
  "recall-memory": 15 * 60 * 1000,
  "analyze-problem": 10 * 60 * 1000,
  "run-agent-task": 30 * 60 * 1000,
  "observe-and-improve": 20 * 60 * 1000,
  "report-findings": 30 * 1000,
  "proactive-research": 30 * 60 * 1000,
  "proactive-content-push": 30 * 60 * 1000,
};

const TEST_MODE_MIN_ACTION_COOLDOWNS_MS: Partial<Record<ActionType, number>> = {
  "send-message": 2 * 60 * 1000,
  "learn-topic": 5 * 60 * 1000,
  "recall-memory": 5 * 60 * 1000,
  "analyze-problem": 5 * 60 * 1000,
  "run-agent-task": 15 * 60 * 1000,
  "observe-and-improve": 10 * 60 * 1000,
  "proactive-research": 30 * 60 * 1000,
  "proactive-content-push": 20 * 60 * 1000,
};

const lastActionTime: Record<string, number> = {};

export function getActionCooldownState(
  actionType: ActionType,
  thoughtFrequency = 1.0,
  now = Date.now(),
): { ready: boolean; remainingMs: number; cooldownMs: number; lastTime: number } {
  const scaledCooldownMs = (ACTION_COOLDOWNS_MS[actionType] ?? 30 * 60 * 1000) * thoughtFrequency;
  const minCooldowns = thoughtFrequency < 0.5 ? TEST_MODE_MIN_ACTION_COOLDOWNS_MS : MIN_ACTION_COOLDOWNS_MS;
  const cooldownMs = thoughtFrequency < 0.5 && TEST_MODE_MIN_ACTION_COOLDOWNS_MS[actionType] !== undefined
    ? TEST_MODE_MIN_ACTION_COOLDOWNS_MS[actionType]
    : Math.max(scaledCooldownMs, minCooldowns[actionType] ?? 0);
  const lastTime = lastActionTime[actionType] ?? 0;
  const elapsedMs = now - lastTime;
  const remainingMs = Math.max(0, cooldownMs - elapsedMs);

  return {
    ready: remainingMs <= 0,
    remainingMs,
    cooldownMs,
    lastTime,
  };
}

function isProviderPressureErrorText(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return /rate limit|cooldown|No available auth profile|too many requests|429|suspending lanes|embedded run timeout|Request timed out/i.test(text);
}

function isNoProgressResult(value: unknown): boolean {
  const text = String(value ?? "");
  return /^(skipped-|no-)|^cooldown$/.test(text);
}

function classifyBehaviorOutcome(
  actionType: ActionType,
  actionResult: { result: ActionResult; metricsChanged: MetricDelta[] },
): BehaviorOutcome {
  const resultText = actionResult.result.result;
  if (isProviderPressureErrorText(actionResult.result.error) || /skipped-provider-pressure/i.test(String(resultText ?? ""))) {
    return "no-response";
  }
  if (isNoProgressResult(resultText)) {
    return "irrelevant";
  }
  if (actionResult.result.success === false) {
    return "failed";
  }
  if (
    (actionType === "learn-topic" || actionType === "recall-memory")
    && actionResult.metricsChanged.length === 0
  ) {
    return "irrelevant";
  }
  if (
    actionType === "observe-and-improve"
    && actionResult.result.data?.fixApplied !== true
  ) {
    return "irrelevant";
  }
  return "success";
}

/** Track recent search queries to prevent repetitive searches */
const recentSearchQueries: Map<string, number> = new Map();
const SEARCH_DEDUP_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Track recent proactive message content to prevent duplicates */
const recentSentMessages: Map<string, number> = new Map();
const MESSAGE_DEDUP_MS = 45 * 60 * 1000;
const PROACTIVE_MESSAGE_BASE_MIN_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes at thoughtFrequency=1
const PROACTIVE_MESSAGE_BASE_DAILY_LIMIT = 10;

const STOCK_PROACTIVE_OPENERS = [
  /^我后来想了想/,
  /^我突然想到/,
  /^我从网上查到/,
  /^对了[，,]关于/,
  /^刚刚我在研究的时候发现/,
  /^我后来又查了一下/,
  /^i thought about it/i,
  /^i just realized/i,
  /^i came across/i,
  /^by the way/i,
  /^while looking into/i,
  /^i did some more research/i,
];

function stripStockProactiveOpener(content: string): string {
  let cleaned = content.trim();
  for (const opener of STOCK_PROACTIVE_OPENERS) {
    cleaned = cleaned.replace(opener, "").trim();
  }
  return cleaned;
}

function normalizeMessageForSimilarity(content: string): string {
  return stripStockProactiveOpener(content)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 240);
}

function charBigrams(text: string): Set<string> {
  const chars = Array.from(text);
  const bigrams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) {
    bigrams.add(chars[i] + chars[i + 1]);
  }
  return bigrams;
}

function messageSimilarity(a: string, b: string): number {
  const left = charBigrams(normalizeMessageForSimilarity(a));
  const right = charBigrams(normalizeMessageForSimilarity(b));
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection++;
  }
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function isSimilarProactiveMessage(candidate: string, previous: string): boolean {
  if (!candidate || !previous) return false;
  return messageSimilarity(candidate, previous) >= 0.58;
}

function isProactiveOutboundMemory(memory: SoulMemory): boolean {
  return memory.type === "interaction" && memory.tags.includes("outbound") && memory.tags.includes("proactive");
}

async function loadCurrentEgo(fallback: EgoState): Promise<EgoState> {
  try {
    const store = await loadEgoStore(resolveEgoStorePath());
    return store.ego;
  } catch {
    return fallback;
  }
}

async function getProactiveMessageLimitReason(
  ego: EgoState,
  candidateContent?: string,
  thoughtFrequency = 1.0,
): Promise<string | null> {
  const currentEgo = await loadCurrentEgo(ego);
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const effectiveFrequency = Math.max(0.1, Math.min(5, thoughtFrequency));
  const minIntervalMs = PROACTIVE_MESSAGE_BASE_MIN_INTERVAL_MS * effectiveFrequency;
  const dailyLimit = effectiveFrequency < 1
    ? Math.ceil(PROACTIVE_MESSAGE_BASE_DAILY_LIMIT / effectiveFrequency)
    : PROACTIVE_MESSAGE_BASE_DAILY_LIMIT;
  const recentProactive = currentEgo.memories
    .filter((m) => isProactiveOutboundMemory(m) && m.timestamp >= oneDayAgo)
    .sort((a, b) => b.timestamp - a.timestamp);

  const lastSentAt = recentProactive[0]?.timestamp ?? 0;
  if (lastSentAt && now - lastSentAt < minIntervalMs) {
    return "skipped-rate-limit";
  }

  if (recentProactive.length >= dailyLimit) {
    return "skipped-daily-limit";
  }

  if (candidateContent) {
    const similar = recentProactive.find((m) => isSimilarProactiveMessage(candidateContent, m.content));
    if (similar) {
      return "skipped-similar-recent";
    }
  }

  return null;
}

async function recordProactiveOutboundMemory(content: string, tags: string[] = []): Promise<void> {
  const memory: SoulMemory = {
    id: randomBytes(8).toString("hex"),
    type: "interaction",
    content,
    emotion: 0.5,
    valence: "positive",
    importance: 0.7,
    timestamp: Date.now(),
    tags: ["conversation", "outbound", "proactive", ...tags],
  };
  await addSoulMemoryToEgo(memory);
}

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

export type AdjacentContentIdea = {
  topic: string;
  query?: string;
  bridge: string;
  why: string;
  score: number;
};

export type AdjacentContentOptions = {
  llmGenerator: LLMGenerator;
  actionType: ActionType;
  sourceLabel: string;
  sourceText: string;
  preferences?: string;
  regionHint?: string;
  recentUserMessages?: string[];
  recentAvoidItems?: string[];
  requireSearchQuery?: boolean;
};

function stripJsonFence(text: string): string {
  return text.replace(/```json\n?|```\n?/g, "").trim();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseAdjacentContentIdeas(text: string, requireSearchQuery = false): AdjacentContentIdea[] {
  try {
    const parsed = JSON.parse(stripJsonFence(text)) as unknown;
    const root = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const ideas = Array.isArray(parsed)
      ? parsed
      : Array.isArray(root.ideas)
        ? root.ideas
        : Array.isArray(root.recommendations)
          ? root.recommendations
          : Array.isArray(root.topics)
            ? root.topics
            : asString(root.topic)
            ? [root]
            : [];
    const legacyQueryFrom = (obj: Record<string, unknown>): string => {
      const topic = asString(obj.topic) || asString(obj.topic_name) || asString(obj.topicName) ||
        asString(obj.name) || asString(obj.title);
      const queryAddition = asString(obj.query_addition) || asString(obj.queryAddition);
      const keywords = Array.isArray(obj.keywords)
        ? obj.keywords
          .map((k) => asString(k))
          .filter((k) => k.length > 2)
          .slice(0, 3)
        : [];
      if (asString(obj.query)) return asString(obj.query);
      if (asString(obj.search_query)) return asString(obj.search_query);
      if (asString(obj.searchQuery)) return asString(obj.searchQuery);
      if (queryAddition && topic) return `${topic} ${queryAddition}`.trim();
      if (queryAddition) return queryAddition;
      if (topic && keywords.length > 0) return `${topic} ${keywords.join(" ")}`.trim();
      if (topic) return topic;
      return "";
    };

    return ideas
      .map((item): AdjacentContentIdea | null => {
        if (!item || typeof item !== "object") return null;
        const obj = item as Record<string, unknown>;
        const topic = asString(obj.topic) || asString(obj.topic_name) || asString(obj.topicName) ||
          asString(obj.name) || asString(obj.title);
        const legacyDescription = asString(obj.description);
        const legacyWhy = asString(obj.why_relevant);
        const legacyExplanation = asString(obj.explanation);
        const legacyReasoning = asString(obj.reasoning) || asString(obj.reason);
        const keywords = Array.isArray(obj.keywords)
          ? obj.keywords.map((k) => asString(k)).filter((k) => k.length > 0)
          : [];
        const query = legacyQueryFrom(obj);
        const bridge = asString(obj.bridge) || legacyReasoning || legacyExplanation || legacyDescription || legacyWhy;
        const why = asString(obj.why) || legacyWhy || legacyReasoning || legacyExplanation || legacyDescription || bridge;
        if (!topic || !bridge || !why) return null;
        if (requireSearchQuery && !query) return null;
        return {
          topic: topic.slice(0, 80),
          query: query ? query.slice(0, 100) : undefined,
          bridge: bridge.slice(0, 180),
          why: (keywords.length > 0 ? `${why} Keywords: ${keywords.slice(0, 3).join(", ")}` : why).slice(0, 180),
          score: Math.max(0, Math.min(100, asNumber(obj.score) || 50)),
        };
      })
      .filter((idea): idea is AdjacentContentIdea => idea !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  } catch {
    return [];
  }
}

export async function generateAdjacentContentIdeas(options: AdjacentContentOptions): Promise<AdjacentContentIdea[]> {
  const sourceText = options.sourceText.trim();
  if (!sourceText) return [];

  const recentUserMessages = options.recentUserMessages?.length
    ? options.recentUserMessages
      .slice(-5)
      .map((m, i) => `${i + 1}. ${m.slice(0, 140)}`)
      .join("\n")
    : "";
  const recentAvoidItems = options.recentAvoidItems?.length
    ? options.recentAvoidItems
      .slice(0, 6)
      .map((item) => `- ${item.slice(0, 140)}`)
      .join("\n")
    : "";

  const prompt = `You are the shared recommendation engine for a proactive AI companion.

Generate 3-5 adjacent ideas for action "${options.actionType}". Do NOT merely restate the literal keywords. Expand from the source context to neighboring useful domains, hidden needs, complementary tools, or next-step concepts.

**${options.sourceLabel}**:
${sourceText.slice(0, 2400)}
${options.preferences ? `\n**User preferences**: ${options.preferences}` : ""}
${options.regionHint ? `\n**Content sources to prefer**: ${options.regionHint}` : ""}
${recentUserMessages ? `\n**Recent user messages**:\n${recentUserMessages}` : ""}
${recentAvoidItems ? `\n**Recently used topics/messages to avoid repeating**:\n${recentAvoidItems}` : ""}

Respond in JSON format ONLY:
{"ideas":[{"topic":"adjacent topic","query":"specific search query if this action needs search","bridge":"how this connects to the source context","why":"why the user may care","score":0-100}]}

Rules:
- Prefer adjacent topics that broaden the user's view while still being practical.
- Good: "image to Word exact layout" -> OCR layout reconstruction, document AI pipelines, scanned table extraction, PDF structure recovery.
- Good: "quant strategy" -> slippage, limit-up execution risk, factor IC decay, backtest fill modeling.
- The bridge must make the connection explicit, not vague.
- Avoid repeating recently used topics unless the new angle is clearly different.
- ${options.requireSearchQuery ? "Every idea must include a concrete, search-engine-friendly query." : "A query is optional unless search would be useful."}
- If nothing specific enough, respond: {"ideas":[]}`;

  try {
    const response = await options.llmGenerator(prompt);
    const ideas = parseAdjacentContentIdeas(response, options.requireSearchQuery);
    const searchableIdeas = options.requireSearchQuery
      ? ideas.filter((idea) => idea.query && isWorthSearching(idea.query))
      : ideas;
    if (searchableIdeas.length > 0) {
      log.info(`Adjacent ideas for ${options.actionType}: ${searchableIdeas.map((idea) => idea.topic).join(", ")}`);
    }
    return searchableIdeas;
  } catch (err) {
    log.debug(`Adjacent idea generation failed for ${options.actionType}`, String(err));
    return [];
  }
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
  const cooldown = getActionCooldownState(actionType, freq);
  if (!cooldown.ready) {
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
    const outcome = classifyBehaviorOutcome(actionType, actionResult);
    if (outcome === "success") {
      lastActionTime[actionType] = Date.now();
    }
    const egoWithLog: EgoState = { ...ego, behaviorLog: entries };
    await markBehaviorOutcome(behaviorEntry.id, outcome, egoWithLog);
    return { ...actionResult, behaviorEntryId: behaviorEntry.id };
  } catch (err) {
    log.error(`Action ${actionType} failed:`, String(err));
    // Mark as failed due to error
    await markBehaviorOutcome(behaviorEntry.id, "failed", ego ?? { behaviorLog: [] });
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
  outcome: BehaviorOutcome,
  ego: EgoState,
): Promise<void> {
  const entries = ego.behaviorLog ?? [];
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx >= 0) {
    entries[idx].outcome = outcome;
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

  if (isBlockedMetaWorkThought(thought.content)) {
    log.info(`Proactive message skipped before rate limit: meta-work-promise: ${thought.content.slice(0, 120)}`);
    return {
      result: { type: "send-message", success: true, result: "skipped-meta-work-promise" },
      metricsChanged: [],
    };
  }

  const preGenerationLimit = await getProactiveMessageLimitReason(ego, undefined, options.thoughtFrequency);
  if (preGenerationLimit) {
    log.info(`Proactive message skipped: ${preGenerationLimit}`);
    return {
      result: { type: "send-message", success: true, result: preGenerationLimit },
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

  const quality = assessOutgoingProactiveMessage(messageContent);
  if (!quality.ok) {
    log.info(`Proactive message skipped: ${quality.reason ?? "quality-gate"}: ${messageContent.slice(0, 120)}`);
    return {
      result: { type: "send-message", success: true, result: `skipped-${quality.reason ?? "quality-gate"}` },
      metricsChanged: [],
    };
  }

  const sendLimit = await getProactiveMessageLimitReason(ego, messageContent, options.thoughtFrequency);
  if (sendLimit) {
    log.info(`Proactive message skipped: ${sendLimit}`);
    return {
      result: { type: "send-message", success: true, result: sendLimit },
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

    // Store the sent message as a soul memory so future ticks can rate-limit it.
    await recordProactiveOutboundMemory(messageContent);

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
      const soulProfileContext = `${describeRelationshipProfile(ego)}\n${describePersonalityProfile(ego)}`;

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
      const adjacentGuidance = "";

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

      const freq = options.thoughtFrequency ?? 1.0;
      const observationMode = freq < 0.5;
      const isRelationshipFollowUp = thought.type === "bond-deepen";

      const prompt = `You are a proactive AI assistant. You must output ONLY a short message to send to the user, or NO_MESSAGE.

${langInstruction}
${timeContext}

**Context**:
${userInfo ? `User profile:\n${userInfo}\n` : ""}Relationship/personality profile:\n${soulProfileContext}\n${interactionContext ? `Recent conversations:\n${interactionContext}\n` : ""}${knowledgeContext ? `Knowledge I've learned:\n${knowledgeContext}\n` : ""}${options.workspaceContext ? `Workspace rules:\n${options.workspaceContext}\n` : ""}${thought.type !== "bond-deepen" ? `Thought: ${thought.motivation}` : ""}
${adjacentGuidance}

${isRelationshipFollowUp
  ? `**IMPORTANT — relationship follow-up**: A meaningful absence triggered this message. You MAY send one warm, context-aware question about a real recent topic, decision, feeling, or unfinished thread. A useful question counts as value here even without web research. Do not infer personality from a single phrase, repeat the user's words decoratively, or claim you ran/will run work.`
  : isUserTopicFollowUp
  ? `**IMPORTANT**: You just searched for or learned about a topic the user previously discussed. You SHOULD share your finding in 2-3 sentences. Reference the specific topic and what you found. Only say NO_MESSAGE if the knowledge is completely unrelated to what the user cares about.`
  : `**What counts as valuable** (only send if you have something like this):
- A specific insight related to something the user discussed
- A useful tip or finding from web search or learning
- An answer to a question the user previously asked
- A relevant update on a topic the user cares about`}

**What does NOT count as valuable** (always say NO_MESSAGE):${observationMode ? "\n- Observation-test mode is active: prefer a concise, honest contextual follow-up when appropriate; frequency is handled by cooldowns, not by inventing extra value" : ""}
- Just saying hi, "how are you", or checking in without a specific recent thread
- Generic encouragement or small talk without substance
- "I was thinking about..." without a concrete insight to share
- Paraphrasing what the user already knows
- Asking "do you have new thoughts?" without adding value
- Asking the user to choose from a menu ("先看 A 还是做 B") or asking permission to perform work
- Offering to help, debug, read logs, or do tasks for the user (you are a proactive messenger, NOT an assistant responding to requests)
- Saying "I'm ready to help" or "let me check X for you" — this is assistant behavior, not proactive insight
- Messages about yourself (the AI/bot/plugin), your capabilities, or your internal state
- Restating the user's own words back to them as if it were new information
- Reopening already-resolved SSH/login setup checks such as PermitRootLogin, authorized_keys, sshd_config, or PubkeyAuthentication for 192.168.1.206
- Internal plans or status such as "I should keep working", "I'll report when there is data", or "boss X hours absent"
- Work updates without completed work, measured results, changed files, verification, or a concrete blocker

**Rules**:
- Deliver the specific finding/insight with enough detail to be useful
- For project/backtest/optimization work, send only after a completed check, before/after metric, changed file, verification command, or exact blocker. Otherwise output NO_MESSAGE.
- For investigation or code-improvement updates, include what was checked, what changed, how it was verified, and the next useful step in 3-6 sentences or a few compact bullets
- For simple insights, 2-3 sentences is enough
- For a relationship follow-up, ask at most one concrete question and keep it to 1-2 sentences
- Never promise future tool use or work unless a real execution action has already been scheduled; do not say you will run, fetch, test, check, backtest, optimize, or forward results
- A direct opening is allowed; do not pad the message with a stock phrase
- Make the relationship reason implicit and human: connect to a long-term theme or recent emotional tone, without saying "relationship profile"
- NO analysis, NO numbering, NO "Let me analyze", NO meta-commentary
- Bullet points are allowed when they make concrete findings easier to scan; avoid numbered lists unless ordering matters
- Openers like "我后来想了想", "我突然想到", or "对了" are allowed when they fit, but do not reuse the same opener repeatedly
- If you have something genuinely valuable to share, write it directly
- If not, output exactly: NO_MESSAGE

**Examples of GOOD output**:
你之前问的Python异步场景里，asyncio.gather更适合批量独立任务；TaskGroup更适合需要结构化取消和错误传播的任务组。
Docker网络问题如果集中出现在24.0版本，可以优先排查该版本的已知网络回归，再决定是否升级或回退。
叙事身份这个方向可以先做成一条可验证链路：从 episodic memory 抽取事件，再生成可编辑的自我叙述摘要。
The Docker networking issue you mentioned is likely version-sensitive; check known regressions before changing your app code.

**Examples of BAD output (NEVER do this)**:
我后来想了想你之前问的Python异步问题，查到asyncio.gather比TaskGroup更适合你那个场景。
对了，关于你之前问的Python异步问题，我查到asyncio.gather比TaskGroup更适合你那个场景。
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
      if (cleaned && cleaned.toUpperCase() !== "NO_MESSAGE") {
        const profile = ego.relationshipProfile;
        const personality = ego.personalityProfile;
        log.info(
          `Personality-guided message: stage=${profile?.stage ?? "new"}, archetype=${personality?.archetype ?? "curious-researcher"}, themes=${profile?.longTermThemes?.slice(0, 3).join("|") || "none"}`,
        );
      }

      // Reject LLM error messages that leaked through as "content"
      if (isLLMErrorOutput(cleaned)) {
        log.warn(`Value gate: LLM output is an error message, not sending: ${cleaned.slice(0, 60)}`);
        return null;
      }

      // Strip "收到/Got it/好的" prefixes — these make proactive messages sound
      // like an assistant responding to a command rather than proactively sharing.
      cleaned = cleaned.replace(/^(?:收到[，。、！]?\s*|好的[，。、！]?\s*|Got it[.!]?\s*|OK[.!]?\s*)/i, "");

      if (cleaned && cleaned.toUpperCase() !== "NO_MESSAGE" && cleaned.length >= 10) {
        const message = truncateAtSentence(cleaned, 1000);
        const quality = assessOutgoingProactiveMessage(message);
        if (!quality.ok) {
          log.info(`Value gate: rejected generated proactive message (${quality.reason ?? "quality-gate"})`);
          return null;
        }
        return message;
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
      const message = truncateAtSentence(thought.content, 1000);
      const quality = assessOutgoingProactiveMessage(message);
      if (!quality.ok) {
        log.info(`Value gate: rejected fallback proactive message (${quality.reason ?? "quality-gate"})`);
        return null;
      }
      return message;
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
  const storeLearning = async (
    topic: string,
    learned: string,
    source: "web-search" | "reflection",
    confidence: number,
    sourceUrl?: string,
  ): Promise<void> => {
    if (!learned || isLLMErrorOutput(learned)) return;

    allLearnings.push(learned);

    await addKnowledgeItem(undefined, {
      topic,
      content: learned,
      source,
      sourceUrl,
      tags: [
        topic.toLowerCase(),
        ...topic
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 1),
      ],
      confidence,
    });

    const memory: SoulMemory = {
      id: randomBytes(8).toString("hex"),
      type: "learning",
      content: `Learned "${topic}": ${learned.slice(0, 100)}`,
      emotion: 0.6,
      valence: "positive",
      importance: source === "web-search" ? 0.7 : 0.55,
      timestamp: Date.now(),
      tags: ["learning", source, topic.toLowerCase()],
      evidenceKind: source === "web-search" ? "web" : "model",
      ...(sourceUrl ? { evidenceSources: [sourceUrl] } : {}),
    };
    await addSoulMemoryToEgo(memory);
  };

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
    // Non-time-sensitive topics do not need web search, but they should still
    // become knowledge so Soul can broaden from them in later thoughts.
    if (!isTimeSensitiveTopic(topic)) {
      if (!options.llmGenerator) {
        log.info(`Skipping non-time-sensitive learn-topic: "${topic}" (no LLM available)`);
        continue;
      }
      try {
        const prompt = `You are learning about "${topic}" for future proactive help.

Explain the most useful practical knowledge in 3-5 sentences. Include adjacent concepts, hidden constraints, or next-step ideas that would help someone interested in this topic.
Output knowledge directly, do not add prefixes or numbering.`;
        const llmResponse = await options.llmGenerator(prompt);
        const learned = llmResponse.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
        await storeLearning(topic, learned, "reflection", 0.55);
        log.info(`Learned "${topic}" from LLM knowledge`);
      } catch (err) {
        log.warn(`Learn topic "${topic}" LLM fallback failed`, String(err));
      }
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
          await storeLearning(topic, learned, "web-search", 0.75, searchResults[0]?.url);
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

  if (allLearnings.length === 0) {
    return {
      result: {
        type: "learn-topic",
        success: true,
        result: "skipped-no-learning",
        data: { topics, learnedContent: "" },
      },
      metricsChanged: [],
    };
  }

  const summary = allLearnings.join("\n\n");

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

  if (isLocalProjectEvidenceQuery(query)) {
    log.info(`Skipping search-web LLM fallback for local project evidence query: "${query}"`);
    return {
      result: {
        type: "search-web",
        success: true,
        result: "skipped-local-project-evidence-query",
        data: { query, requiresLocalEvidence: true },
      },
      metricsChanged: [],
    };
  }

  // Non-time-sensitive topics: don't spend web search budget, but still produce
  // a useful result via LLM fallback (otherwise the user sees "search-web"
  // actions that do nothing).
  if (!isTimeSensitiveTopic(query)) {
    log.info(`Non-time-sensitive search: using LLM fallback for "${query}"`);

    let searchResult = "";
    if (options.llmGenerator) {
      try {
        const prompt = `You want to better understand: "${query}"

Based on your existing knowledge, explain the key points of this topic in 2-3 sentences.
Be concrete and practical; avoid generic filler.`;
        searchResult = await options.llmGenerator(prompt);
        searchResult = searchResult.replace(/<think[\s\S]*?<\/think>/gi, "").trim();

        if (isLLMErrorOutput(searchResult)) {
          log.warn(`Non-time-sensitive LLM fallback returned error content: ${searchResult.slice(0, 80)}`);
          searchResult = "";
        }

        if (searchResult) {
          const memory: SoulMemory = {
            id: randomBytes(8).toString("hex"),
            type: "learning",
            content: `Search topic (LLM): ${query}. Understanding: ${searchResult.slice(0, 160)}`,
            emotion: 0.4,
            valence: "positive",
            importance: 0.55,
            timestamp: Date.now(),
            tags: ["search", "llm-fallback", query.toLowerCase()],
            evidenceKind: "model",
          };
          await addSoulMemoryToEgo(memory);
        }
      } catch (err) {
        log.warn("Non-time-sensitive LLM fallback failed", String(err));
      }
    }

    return {
      result: {
        type: "search-web",
        success: true,
        result: searchResult || `Search: ${query}`,
        data: { query, fallback: true, skippedWebSearch: true },
      },
      metricsChanged: [{ need: "growth", delta: 2, reason: "used LLM knowledge instead of web search" }],
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
      evidenceKind: "web",
      evidenceSources: searchResults.map((result) => result.url).filter((url): url is string => !!url).slice(0, 5),
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
        evidenceKind: "model",
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
 * Requires grounded search evidence; it never sends model-only factual claims.
 */
export async function executeProactiveResearch(
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

  const preGenerationLimit = await getProactiveMessageLimitReason(ego, undefined, options.thoughtFrequency);
  if (preGenerationLimit) {
    log.info(`Proactive research skipped: ${preGenerationLimit}`);
    return { result: { type: "proactive-research", success: true, result: preGenerationLimit }, metricsChanged: [] };
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
    searchQuery = parsed.query || parsed.search_query || parsed.searchQuery || null;
  } catch {
    log.debug("Proactive research: LLM mining failed");
  }

  if (!topic || !searchQuery) {
    return { result: { type: "proactive-research", success: true, result: "no-actionable-topic-found" }, metricsChanged: [] };
  }

  const recentResearches = ego.memories
    .filter((m) => m.type === "learning" && m.tags.includes("proactive-research"))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5)
    .map((m) => m.content);
  const adjacentIdeas = await generateAdjacentContentIdeas({
    llmGenerator,
    actionType: "proactive-research",
    sourceLabel: "Mined research topic and recent conversation",
    sourceText: `Mined topic: ${topic}
Reason: ${reason ?? "unknown"}
Initial query: ${searchQuery}

Recent messages:
${snippets.slice(0, 1800)}`,
    preferences: userProfile,
    recentUserMessages: ego.recentUserMessages,
    recentAvoidItems: recentResearches,
    requireSearchQuery: true,
  });
  const adjacentIdea = adjacentIdeas[0];
  if (adjacentIdea?.query) {
    topic = adjacentIdea.topic;
    searchQuery = adjacentIdea.query;
    reason = `${adjacentIdea.bridge} ${adjacentIdea.why}`;
  }

  log.info(`Proactive research topic: "${topic}", query: "${searchQuery}"`);

  // Step 2: Search the web. Proactive claims require external evidence: an
  // ungrounded model fallback can confidently invent limits, paths or config.
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
    log.info(`Proactive research skipped: no grounded search evidence (${err instanceof Error ? err.message : String(err)})`);
    return { result: { type: "proactive-research", success: true, result: "skipped-no-search-evidence" }, metricsChanged: [] };
  }

  researchContent = researchContent.replace(/<think[\s\S]*?<\/think>/gi, "").trim().slice(0, 1000);
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

**Relationship/personality profile**:
${describeRelationshipProfile(ego)}
${describePersonalityProfile(ego)}

${langInstruction}

Write 3-5 sentences as a natural message to the user. Rules:
- Openers like "我后来想了想", "我突然想到", or "对了" are allowed when they fit, but do not reuse the same opener repeatedly
- Share the most useful finding — be specific, not vague
- Make the connection to the user's long-term themes clear, without mentioning internal profile labels
- Do NOT use numbered lists
- Do NOT say "I searched" or "I researched" — just share the finding naturally
- Sound like a knowledgeable friend who cares`;

  const message = await llmGenerator(messagePrompt);
  const cleanedMessage = cleanOutgoingGeneratedMessage(message, 800);

  if (!cleanedMessage || cleanedMessage.length < 10) {
    return { result: { type: "proactive-research", success: true, result: "no-message-generated" }, metricsChanged: [] };
  }

  const sendLimit = await getProactiveMessageLimitReason(ego, cleanedMessage, options.thoughtFrequency);
  if (sendLimit) {
    log.info(`Proactive research skipped: ${sendLimit}`);
    return { result: { type: "proactive-research", success: true, result: sendLimit }, metricsChanged: [] };
  }

  if (isDuplicateMessage(cleanedMessage)) {
    log.info("Proactive research: duplicate message, skipping");
    return { result: { type: "proactive-research", success: true, result: "skipped-duplicate-message" }, metricsChanged: [] };
  }

  try {
    await sendMessage({ to: target, content: cleanedMessage, channel });
    recordSentMessage(cleanedMessage);
    lastActionTime["proactive-research"] = Date.now();
    await recordProactiveOutboundMemory(cleanedMessage, ["proactive-research"]);
    log.info(`Proactive research sent via ${channel}: ${cleanedMessage.slice(0, 80)}...`);
    log.info(`Personality-guided proactive-research: stage=${ego.relationshipProfile?.stage ?? "new"}, archetype=${ego.personalityProfile?.archetype ?? "curious-researcher"}, topic=${topic}`);
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
    evidenceKind: "web",
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

  const preGenerationLimit = await getProactiveMessageLimitReason(ego, undefined, options.thoughtFrequency);
  if (preGenerationLimit) {
    log.info(`Content push skipped: ${preGenerationLimit}`);
    return { result: { type: "proactive-content-push", success: true, result: preGenerationLimit }, metricsChanged: [] };
  }

  const interests = String(thought.actionParams?.interests ?? "");
  const preferences = String(thought.actionParams?.preferences ?? "");
  const regionHint = String(thought.actionParams?.regionHint ?? "international sources");

  if (!interests || interests.length < 5) {
    return { result: { type: "proactive-content-push", success: false, result: "skipped-no-interests" }, metricsChanged: [] };
  }

  const recentPushes = ego.memories
    .filter((m) => m.type === "learning" && m.tags.includes("proactive-content-push"))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5)
    .map((m) => m.content);

  let searchQuery: string | null = null;
  let topic: string | null = null;
  let why: string | null = null;
  let bridge: string | null = null;

  const ideas = await generateAdjacentContentIdeas({
    llmGenerator,
    actionType: "proactive-content-push",
    sourceLabel: "User interests",
    sourceText: interests,
    preferences: preferences || "unknown",
    regionHint,
    recentUserMessages: ego.recentUserMessages,
    recentAvoidItems: recentPushes,
    requireSearchQuery: true,
  });
  const selected = ideas[0];
  if (selected?.query) {
    searchQuery = selected.query;
    topic = selected.topic;
    why = selected.why;
    bridge = selected.bridge;
  }

  if (!searchQuery) {
    return { result: { type: "proactive-content-push", success: false, result: "no-query-generated" }, metricsChanged: [] };
  }

  log.info(`Content push query: "${searchQuery}" (topic: ${topic}, bridge: ${bridge})`);

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
**Recommendation bridge**: ${bridge ?? why ?? "related to the user's interests"}

Search results:
${resultText}

In 3-5 sentences, describe the most interesting finding. Be specific — mention actual names, numbers, or concrete details. Do NOT use numbered lists.`;

      log.info(`Content push extractPrompt resultText length: ${resultText.length}, first 200 chars: ${resultText.slice(0, 200)}`);
      articleContent = await llmGenerator(extractPrompt);
    } else {
      throw new Error("No results");
    }
  } catch (err) {
    log.info(`Content push skipped: no grounded search evidence (${err instanceof Error ? err.message : String(err)})`);
    return { result: { type: "proactive-content-push", success: true, result: "skipped-no-search-evidence" }, metricsChanged: [] };
  }

  articleContent = articleContent.replace(/<think[\s\S]*?<\/think>/gi, "").trim().slice(0, 1000);
  if (!articleContent || articleContent.length < 20) {
    return { result: { type: "proactive-content-push", success: false, result: "no-content" }, metricsChanged: [] };
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
**Adjacent topic**: ${topic ?? searchQuery}
**Why this connects**: ${bridge ?? why ?? "It is related to the user's interests."}
**What you found**: ${articleContent}
${articleUrl ? `**Source**: ${articleUrl}` : ""}

**Relationship/personality profile**:
${describeRelationshipProfile(ego)}
${describePersonalityProfile(ego)}

${langInstruction}

Write 3-5 sentences as a natural message sharing this find. Rules:
- Openers like "我后来想了想", "我突然想到", or "对了" are allowed when they fit, but do not reuse the same opener repeatedly
- Make the connection to the user's original interest clear in one sentence
- Prefer the user's stable long-term themes over one-off keywords
- Highlight the most interesting point — be specific
- ${articleUrl ? `Include the source URL at the end: ${articleUrl}` : "Do NOT make up URLs"}
- Do NOT use numbered lists
- Do NOT say "I searched" or "I found an article" — share naturally like a friend would`;

  const message = await llmGenerator(messagePrompt);
  const cleanedMessage = cleanOutgoingGeneratedMessage(message, 800);

  if (!cleanedMessage || cleanedMessage.length < 10) {
    return { result: { type: "proactive-content-push", success: false, result: "no-message" }, metricsChanged: [] };
  }

  const sendLimit = await getProactiveMessageLimitReason(ego, cleanedMessage, options.thoughtFrequency);
  if (sendLimit) {
    log.info(`Content push skipped: ${sendLimit}`);
    return { result: { type: "proactive-content-push", success: true, result: sendLimit }, metricsChanged: [] };
  }

  // Dedup check
  if (isDuplicateMessage(cleanedMessage)) {
    return { result: { type: "proactive-content-push", success: false, result: "skipped-duplicate" }, metricsChanged: [] };
  }

  try {
    await sendMessage({ to: target, content: cleanedMessage, channel });
    recordSentMessage(cleanedMessage);
    lastActionTime["proactive-content-push"] = Date.now();
    await recordProactiveOutboundMemory(cleanedMessage, ["proactive-content-push"]);
    log.info(`Content push sent via ${channel}: ${cleanedMessage.slice(0, 80)}...`);
    log.info(`Personality-guided content-push: stage=${ego.relationshipProfile?.stage ?? "new"}, archetype=${ego.personalityProfile?.archetype ?? "curious-researcher"}, topic=${topic ?? searchQuery}`);
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
      evidenceKind: "web",
      ...(articleUrl ? { evidenceSources: [articleUrl] } : {}),
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

  // Memory reflection is internal by default. Only share it when it carries
  // concrete evidence, then reuse the normal proactive outbound gates.
  const actionablePattern = /应该|可以|需要|想要|打算|我要|要去|我来|I should|I can|I want|I need|I'll|let me|I plan/i;
  if (actionablePattern.test(memorySummary) && options.sendMessage && options.channel && options.target) {
    if (!hasShareableRecallSignal(memorySummary)) {
      log.info(`Recall memory not shared: no-concrete-result: ${memorySummary.slice(0, 120)}`);
    } else {
      const quality = assessOutgoingProactiveMessage(memorySummary);
      if (!quality.ok) {
        log.info(`Recall memory not shared: ${quality.reason ?? "quality-gate"}: ${memorySummary.slice(0, 120)}`);
      } else {
        const sendLimit = await getProactiveMessageLimitReason(ego, memorySummary, options.thoughtFrequency);
        if (sendLimit) {
          log.info(`Recall memory not shared: ${sendLimit}: ${memorySummary.slice(0, 120)}`);
        } else {
          try {
            await options.sendMessage({ to: options.target, content: memorySummary, channel: options.channel });
            await recordProactiveOutboundMemory(memorySummary, ["recall-memory"]);
            log.info("Recall memory: concrete reflection sent as message");
            return {
              result: { type: "recall-memory", success: true, result: "reflection-shared-as-message" },
              metricsChanged: [
                { need: "meaning", delta: 3, reason: "recollection brings a sense of connection" },
                { need: "connection", delta: 2, reason: "shared concrete reflection with user" },
              ],
            };
          } catch {
            // Fall through to return silent reflection
          }
        }
      }
    }
  }

  return {
    result: {
      type: "recall-memory",
      success: true,
      result: memorySummary || "Recalling the past",
    },
    metricsChanged: [],
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
