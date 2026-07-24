import type { EgoState, SoulMemory } from "./types.js";

export type RandomSource = () => number;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "about", "user", "want",
  "need", "should", "could", "would", "have", "been", "what", "when", "where", "which",
  "一个", "这个", "那个", "用户", "我们", "需要", "可以", "应该", "什么", "怎么", "如何", "关于",
]);

export function contentTokens(text: string): string[] {
  // Unicode property escapes cover Latin accents, Cyrillic, Greek, Arabic,
  // Devanagari and other scripts without maintaining per-language tables.
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? [];
  const cjkRuns = text.match(/[\u3400-\u9fff]+/g) ?? [];
  const cjk = cjkRuns.flatMap((run) => {
    const chars = Array.from(run);
    if (chars.length <= 2) return [run];
    return chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
  });
  const nonCjkWords = words.filter((token) => !/[\u3400-\u9fff]/.test(token));
  return [...new Set([...nonCjkWords, ...cjk].filter((token) => !STOP_WORDS.has(token)))];
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection || 1);
}

const TOPIC_CLUSTERS: Record<string, RegExp> = {
  trading: /\b(?:btc|eth|bitcoin|crypto|trading|trade|backtest|futures|binance|order|position|slippage)\b|交易|回测|策略|订单|合约|强平|持仓|止损/i,
  software: /\b(?:code|coding|script|api|bug|error|python|typescript|javascript|database|algorithm)\b|代码|脚本|接口|错误|编程|数据库|算法/i,
  ai: /\b(?:ai|llm|model|agent|prompt|machine learning|neural)\b|人工智能|大模型|模型|智能体|提示词|机器学习/i,
  operations: /\b(?:deploy|server|ssh|log|monitor|restart|latency|timeout|recovery)\b|部署|服务器|日志|监控|重启|延迟|超时|恢复/i,
  security: /\b(?:security|risk|auth|permission|vulnerability|attack)\b|安全|风险|认证|权限|漏洞|攻击/i,
  interface: /\b(?:gui|ui|dialog|frontend|browser|window)\b|界面|对话框|前端|浏览器|窗口/i,
  relationship: /\b(?:user|boss|relationship|conversation|communication|trust)\b|用户|老板|关系|交流|沟通|信任/i,
};

export function memoryTopicClusters(memory: Pick<SoulMemory, "content" | "tags">): string[] {
  const text = `${memory.content} ${memory.tags.join(" ")}`;
  const lexical = Object.entries(TOPIC_CLUSTERS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([cluster]) => cluster);
  const semantic = memory.tags
    .filter((tag) => tag.startsWith("topic:"))
    .map((tag) => tag.toLocaleLowerCase());
  return [...new Set([...semantic, ...lexical])];
}

export function classifyCognitiveMove(content: string): string {
  if (!content.trim()) return "none";
  if (/[?？]\s*$|^\s*(?:是否|会不会|为什么|怎么|如何)\b|(?:更像|(?<!不)是).{0,30}还是|what if|wonder|why\b/i.test(content)) return "question";
  if (/与其.*不如|并不是.*而是|不只是.*而是|换个角度|重新理解|rather than|not merely.*but|reframe/i.test(content)) return "reframing";
  if (/根因|导致|源于|因果|because|caused? by|root cause|therefore|therefore/i.test(content)) return "causal-analysis";
  if (/反例|反证|并非总是|不一定|证伪|counterexample|falsif|not necessarily/i.test(content)) return "counterexample";
  if (/实验|对照组|回测|验证方案|试验|A\/B|experiment|test design|controlled test/i.test(content)) return "experiment-design";
  if (/对照|相比|区别|权衡|取舍|versus|compared|comparison|trade-?off/i.test(content)) return "comparison";
  if (/综合(?:来看|这些|现有|以上)|合并.*(?:证据|线索|结论)|归纳|synthesi|taken together|combine.*(?:evidence|signal)/i.test(content)) return "synthesis";
  if (/优先级|优先处理|先做|最值得|prioriti[sz]|highest.value/i.test(content)) return "prioritization";
  if (/没有新(?:证据|信息)|暂时搁置|先不继续|等待新|no new (?:evidence|information)|park this|wait for new/i.test(content)) return "release";
  if (/像是|类似|共同|结构|映射|analog|parallel|pattern|remind/i.test(content)) return "analogy";
  if (/也许|可能|猜|假设|perhaps|maybe|hypothesi|speculat/i.test(content)) return "speculation";
  if (/确认|弄清|搞清|查明|拿到|缺少|缺乏|才能给出|verify|confirm|missing|need (?:the )?(?:data|number|result)/i.test(content)) return "research";
  if (/建议|推荐|不妨|可以试|recommend|suggest|should try/i.test(content)) return "recommendation";
  if (/查找|搜索|研究|调研|learn|research|search|look up/i.test(content)) return "research";
  if (/解决|修复|排查|优化|fix|solve|debug|improve/i.test(content)) return "problem-solving";
  if (/告诉|分享|联系|提醒|tell|share|message|remind/i.test(content)) return "outreach";
  if (/继续|跟进|回到|follow.?up|revisit|continue/i.test(content)) return "follow-up";
  if (/困惑|矛盾|不确定|confus|uncertain|tension/i.test(content)) return "confusion";
  return "reflection";
}

export function classifyThoughtQualityFlags(content: string): string[] {
  const flags: string[] = [];
  if (/\bfragment(?:s)?\b|\binput\s+[ab]\b|two (?:memory|inputs)|unrelated contents|simultaneous presence|these inputs|no single clear thought|片段|输入片段|不相关的信息/i.test(content)) {
    flags.push("meta-framing");
  }
  if (/\b(?:both|the two|these)\s+(?:signal|emphasize|suggest|share|point to|map onto|mirror|connect)\b|\bcomes up alongside\b|\breminds me of\b.{0,120}\b(?:separate|another|also|both)\b|\bquestion flips between\b|共同.*(?:说明|指向|暗示)|两个.*(?:都|共同|同时|映射)/i.test(content)) {
    flags.push("forced-association");
  }
  if (/\b(?:should|need to|recommend|search for|look up|prioriti[sz]e|prepare a response|next steps?|task requirements?|acting on (?:one'?s )?(?:goals|objectives)|I(?:'ll| will| am going to|'m going to)\s+(?:run|fetch|test|check|optimi[sz]e|implement|report|send|share))\b|应该|需要|建议|搜索|优先|回复|下一步|任务要求/i.test(content)) {
    flags.push("task-pressure");
  }
  if (
    /I recently learned some things,? (?:and )?want to organize or share|I can reach out to the user,? share my recent (?:thoughts|learning)|fulfills? my need for connection|我(?:只是)?想(?:联系|帮助)用户|我可以联系用户.*分享/i.test(content)
  ) {
    flags.push("empty-intention");
  }
  return flags;
}

const COGNITIVE_MOVES = new Set([
  "question", "analogy", "speculation", "recommendation", "research",
  "problem-solving", "outreach", "follow-up", "confusion", "reflection",
  "causal-analysis", "counterexample", "comparison", "synthesis",
  "experiment-design", "prioritization", "reframing", "release", "none",
]);
const QUALITY_FLAGS = new Set([
  "meta-framing", "forced-association", "task-pressure", "empty-intention", "truncated",
]);

/** Parse the model's language-independent structured assessment, with the
 * legacy keyword classifiers retained only as an offline/no-structure fallback. */
export function parseSpontaneousResponse(raw: string): {
  content: string;
  cognitiveMove: string;
  qualityFlags: string[];
} {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "").trim();
  try {
    const block = cleaned.replace(/```(?:json)?/gi, "").replace(/```/g, "");
    const match = block.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const content = typeof parsed.thought === "string" ? parsed.thought.trim() : "";
      const cognitiveMove = typeof parsed.cognitiveMove === "string" && COGNITIVE_MOVES.has(parsed.cognitiveMove)
        ? parsed.cognitiveMove
        : classifyCognitiveMove(content);
      const qualityFlags = Array.isArray(parsed.qualityFlags)
        ? [...new Set(parsed.qualityFlags.filter((flag): flag is string =>
          typeof flag === "string" && QUALITY_FLAGS.has(flag),
        ))]
        : classifyThoughtQualityFlags(content);
      if (content) return { content, cognitiveMove, qualityFlags };
    }
  } catch {
    // Fall through to a deterministic classifier for old/small models.
  }
  const content = cleaned;
  return {
    content,
    cognitiveMove: classifyCognitiveMove(content),
    qualityFlags: classifyThoughtQualityFlags(content),
  };
}

export interface ThoughtAdvanceAssessment {
  accepted: boolean;
  reason?: "empty" | "model-no-thought" | "quality-flag" | "semantic-repeat" | "repeated-cognitive-move";
  cognitiveMove: string;
  noveltyScore: number;
  maxSimilarity: number;
  qualityFlags: string[];
  /** A repeated topic/move is legitimate when trusted external state advanced. */
  verifiedProgress: boolean;
}

export interface ThoughtProgressContext {
  /** Stable IDs of user/tool/web evidence supporting the current pass. */
  evidenceIds?: string[];
  /** Evidence IDs recorded for the previous pass over this opportunity family. */
  previousEvidenceIds?: string[];
  /** Stable summary of the problem state seen by the current pass. */
  stateFingerprint?: string;
  /** State summary recorded for the previous pass. */
  previousStateFingerprint?: string;
}

export interface ThoughtProgressSnapshot {
  evidenceIds: string[];
  stateFingerprint: string;
}

/**
 * Build a stable, grounded progress marker for one opportunity. Memory IDs are
 * counted only when they come from the user, a tool, or the web and overlap the
 * opportunity. The state fingerprint intentionally ignores bare numbers so an
 * elapsed-time counter cannot masquerade as progress.
 */
export function buildThoughtProgressSnapshot(
  opportunity: {
    triggerDetail: string;
    motivation: string;
    actionParams?: Record<string, unknown>;
  },
  memories: SoulMemory[],
): ThoughtProgressSnapshot {
  const opportunityText = `${opportunity.triggerDetail} ${opportunity.motivation}`;
  const opportunityTokens = contentTokens(opportunityText);
  const evidenceIds = memories
    .filter((memory) => {
      const grounded = memory.evidenceKind === "user"
        || memory.evidenceKind === "tool"
        || memory.evidenceKind === "web"
        || memory.tags.some((tag) => /^(?:inbound|tool|web-search|conversation)$/i.test(tag));
      if (!grounded) return false;
      return jaccard(opportunityTokens, contentTokens(`${memory.content} ${memory.tags.join(" ")}`)) > 0;
    })
    .map((memory) => memory.id)
    .filter(Boolean)
    .sort();
  const params = opportunity.actionParams
    ? JSON.stringify(opportunity.actionParams, Object.keys(opportunity.actionParams).sort())
    : "";
  const stateFingerprint = contentTokens(`${opportunityText} ${params}`)
    // Counters such as 27h0m and retry-3 are passage-of-time/attempt noise,
    // not evidence that the underlying problem state changed.
    .filter((token) => !/\d/.test(token))
    .sort()
    .slice(0, 80)
    .join("|");
  return { evidenceIds: [...new Set(evidenceIds)], stateFingerprint };
}

export function hasVerifiedThoughtProgress(progress?: ThoughtProgressContext): boolean {
  if (!progress) return false;
  const previousEvidence = new Set(progress.previousEvidenceIds ?? []);
  const hasNewEvidence = progress.previousEvidenceIds !== undefined
    && (progress.evidenceIds ?? []).some((id) => id && !previousEvidence.has(id));
  const hasStateChange = Boolean(
    progress.stateFingerprint
    && progress.previousStateFingerprint
    && progress.stateFingerprint !== progress.previousStateFingerprint,
  );
  return hasNewEvidence || hasStateChange;
}

/**
 * Model-independent quality gate for optional/private cognition. Critical
 * operational work deliberately bypasses this at the caller.
 */
export function assessThoughtAdvance(
  content: string,
  recentContents: string[],
  recentMoves: string[] = [],
  progress?: ThoughtProgressContext,
): ThoughtAdvanceAssessment {
  const trimmed = content.trim();
  const cognitiveMove = classifyCognitiveMove(trimmed);
  const qualityFlags = classifyThoughtQualityFlags(trimmed);
  const verifiedProgress = hasVerifiedThoughtProgress(progress);
  if (!trimmed) {
    return { accepted: false, reason: "empty", cognitiveMove, noveltyScore: 0, maxSimilarity: 1, qualityFlags, verifiedProgress };
  }
  if (/^NO_THOUGHT[.!]?$/i.test(trimmed)) {
    return { accepted: false, reason: "model-no-thought", cognitiveMove, noveltyScore: 0, maxSimilarity: 1, qualityFlags, verifiedProgress };
  }

  const maxSimilarity = recentContents.reduce((highest, recent) => Math.max(
    highest,
    jaccard(contentTokens(recent), contentTokens(trimmed)),
  ), 0);
  const noveltyScore = Number((1 - maxSimilarity).toFixed(4));
  if (
    qualityFlags.includes("meta-framing")
    || qualityFlags.includes("forced-association")
    || qualityFlags.includes("empty-intention")
  ) {
    return { accepted: false, reason: "quality-flag", cognitiveMove, noveltyScore, maxSimilarity, qualityFlags, verifiedProgress };
  }
  if (maxSimilarity >= 0.55 && !verifiedProgress) {
    return { accepted: false, reason: "semantic-repeat", cognitiveMove, noveltyScore, maxSimilarity, qualityFlags, verifiedProgress };
  }

  const lastTwoMoves = recentMoves.filter((move) => move !== "silence").slice(-2);
  if (!verifiedProgress && lastTwoMoves.length === 2 && lastTwoMoves.every((move) => move === cognitiveMove)) {
    return {
      accepted: false,
      reason: "repeated-cognitive-move",
      cognitiveMove,
      noveltyScore,
      maxSimilarity,
      qualityFlags,
      verifiedProgress,
    };
  }
  return { accepted: true, cognitiveMove, noveltyScore, maxSimilarity, qualityFlags, verifiedProgress };
}

function choose<T>(items: T[], random: RandomSource): T | undefined {
  return items[Math.floor(random() * items.length)];
}

export function selectRemoteMemoryPair(
  memories: SoulMemory[],
  random: RandomSource,
  now = Date.now(),
  usageCounts?: ReadonlyMap<string, number>,
): SoulMemory[] {
  const usable = memories.filter((memory) => memory.content.trim().length >= 8);
  if (usable.length === 0) return [];
  const chronological = [...usable].sort((a, b) => a.timestamp - b.timestamp);
  const oldCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const oldPool = chronological.filter((memory, index) =>
    memory.timestamp <= oldCutoff || index < Math.floor(chronological.length * 0.6));
  const seedPool = oldPool.length > 0 ? oldPool : chronological;
  const leastSeedUse = Math.min(...seedPool.map((memory) => usageCounts?.get(memory.id) ?? 0));
  const seed = choose(seedPool.filter((memory) =>
    (usageCounts?.get(memory.id) ?? 0) === leastSeedUse), random);
  if (!seed || usable.length === 1) return seed ? [seed] : [];

  const seedTokens = contentTokens(`${seed.content} ${seed.tags.join(" ")}`);
  const seedClusters = memoryTopicClusters(seed);
  const candidates = usable
    .filter((memory) => memory.id !== seed.id)
    .map((memory) => ({
      memory,
      similarity: jaccard(seedTokens, contentTokens(`${memory.content} ${memory.tags.join(" ")}`)),
      clusterSimilarity: jaccard(seedClusters, memoryTopicClusters(memory)),
      timeDistance: Math.abs(memory.timestamp - seed.timestamp),
    }))
    .sort((a, b) => a.clusterSimilarity - b.clusterSimilarity
      || (usageCounts?.get(a.memory.id) ?? 0) - (usageCounts?.get(b.memory.id) ?? 0)
      || a.similarity - b.similarity
      || b.timeDistance - a.timeDistance);
  const remoteBand = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * 0.2)));
  const remote = choose(remoteBand, random)?.memory;
  return remote ? [seed, remote] : [seed];
}

/** Most spontaneous thoughts continue recent context; remote association is exceptional. */
export function selectContextualMemoryPair(
  memories: SoulMemory[],
  random: RandomSource,
): SoulMemory[] {
  const recent = memories
    .filter((memory) => memory.content.trim().length >= 8)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 12);
  if (recent.length < 2) return recent;
  const seed = choose(recent.slice(0, Math.min(4, recent.length)), random)!;
  const seedTokens = contentTokens(`${seed.content} ${seed.tags.join(" ")}`);
  const related = recent
    .filter((memory) => memory.id !== seed.id)
    .map((memory) => ({ memory, similarity: jaccard(seedTokens, contentTokens(`${memory.content} ${memory.tags.join(" ")}`)) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 4);
  const companion = choose(related, random)?.memory;
  return companion ? [seed, companion] : [seed];
}

export function buildSpontaneousPrompt(
  memories: SoulMemory[],
  ego: EgoState,
  random: RandomSource,
  preferredMove?: string,
): string {
  const contents = memories.map((memory) => `---\n${memory.content.slice(0, 400)}`).join("\n");
  const activeGoal = ego.goals.find((goal) => goal.status === "active")?.title;
  const stateOptions = [
    `Current state: ${Object.entries(ego.needs).map(([key, need]) => `${key}=${need.current.toFixed(0)}`).join(", ")}`,
    activeGoal ? `A currently active goal exists: ${activeGoal}` : "No active goal is present.",
    "No current stimulus is present.",
  ];
  return `Some recent contents are available in awareness:

${contents}
${choose(stateOptions, random)}
${preferredMove ? `A recently underused cognitive motion is ${preferredMove}; use it only if it genuinely fits.` : ""}

Let a natural thought develop from these contents with the same depth and
completeness as a response in the main conversation. It can analyze, question,
explain, advise, connect ideas, or propose next steps. Do not force a bridge
between unrelated items. There is no sentence, word, or character limit.

Return only compact JSON in this exact shape:
{"thought":"the complete thought in the natural language of the contents","cognitiveMove":"question|analogy|speculation|recommendation|research|problem-solving|causal-analysis|counterexample|comparison|synthesis|experiment-design|prioritization|reframing|release|outreach|follow-up|confusion|reflection","qualityFlags":[]}

Classify cognitiveMove by meaning, not keywords or language. qualityFlags may contain "meta-framing" if the thought talks about supplied inputs, "forced-association" if it mainly glues unrelated items together, "task-pressure" if it turns itself into work/help/advice, or "empty-intention" if it only says it wants to help/share without any substantive content. Do not add markdown.`;
}
