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
import { generateAdjacentContentIdeas, MEANINGLESS_QUERIES } from "./action-executor.js";
import { describePersonalityProfile, describeRelationshipProfile } from "./relationship-profile.js";
import { searchExternalMemories, formatMemoryContext } from "./openclaw-memory.js";

const log = createSoulLogger("intelligent-thought");

function isGroundedLearning(memory: SoulMemory): boolean {
  return memory.type === "learning" && ["web", "user", "tool"].includes(memory.evidenceKind ?? "");
}

function activeUserFacts(ego: EgoState) {
  return (ego.userFacts ?? []).filter((fact) => fact.validity !== "superseded");
}

function currentConversationMemories(ego: EgoState, limit = 8): SoulMemory[] {
  const interactions = ego.memories
    .filter((memory) => memory.type === "interaction")
    .sort((a, b) => a.timestamp - b.timestamp);
  const latestInbound = [...interactions].reverse().find((memory) => memory.tags.includes("inbound"));
  if (!latestInbound) return [];
  // A semantic redirect/closure is a hard boundary. Otherwise, a two-hour
  // conversational gap starts a new context window without language rules.
  const hardBoundary = latestInbound.semanticSignals?.some((signal) =>
    signal === "topic-shift" || signal === "closure");
  const cutoff = hardBoundary ? latestInbound.timestamp : latestInbound.timestamp - 2 * 60 * 60 * 1000;
  return interactions.filter((memory) => memory.timestamp >= cutoff).slice(-limit);
}

export type LLMThoughtGenerator = (prompt: string) => Promise<string>;

export interface IntelligentThoughtOptions {
  llmGenerator?: LLMThoughtGenerator;
  recentMemories?: SoulMemory[];
  preferOpportunity?: DetectedThoughtOpportunity;
  /** Only operational callers should expand an action into adjacent ideas. */
  expandActionIdeas?: boolean;
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

type TopicFocusProfile = {
  active: string[];
  deprioritized: string[];
  summary: string;
};

function uniqueTopics(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = item.replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase();
    if (clean.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.slice(0, 6);
}

function isDeprioritizedTopicPreference(text: string): boolean {
  return /不再|不用|不需要|别再|少提|停止|暂停|过时|no longer|not interested|deprioriti[sz]e|avoid|stop|less/i.test(text);
}

function buildTopicFocusProfile(ego: EgoState): TopicFocusProfile {
  const topicPrefs = [...(ego.userPreferences ?? [])]
    .filter((p) => p.aspect === "topic_preference" && p.confidence >= 0.4)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const deprioritized = uniqueTopics(
    topicPrefs
      .filter((p) => p.direction === "avoid"
        || (!p.direction && isDeprioritizedTopicPreference(p.preference)))
      .map((p) => p.preference),
  );
  const positivePrefs = topicPrefs
    .filter((p) => p.direction === "prefer"
      || (!p.direction && !isDeprioritizedTopicPreference(p.preference)))
    .map((p) => p.preference);
  const factTopics = [...activeUserFacts(ego)]
    .filter((f) => ["interest", "project", "tech_stack"].includes(f.category) && f.confidence >= 0.4)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((f) => f.content);
  const active = uniqueTopics([...positivePrefs, ...factTopics]);
  const summary = [
    active.length > 0 ? `active: ${active.join("; ")}` : "",
    deprioritized.length > 0 ? `deprioritized: ${deprioritized.join("; ")}` : "",
  ].filter(Boolean).join(" | ");
  return { active, deprioritized, summary };
}

function topicTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}\u4e00-\u9fff]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !MEANINGLESS_QUERIES.has(t));
}

function matchesAnyTopic(text: string, topics: string[]): boolean {
  const lower = text.toLowerCase();
  const textTokens = new Set(topicTokens(text));
  for (const topic of topics) {
    const clean = topic.toLowerCase();
    if (clean.length >= 4 && lower.includes(clean)) return true;
    const tokens = topicTokens(topic);
    if (tokens.length > 0 && tokens.some((t) => t.length >= 2 && (textTokens.has(t) || lower.includes(t)))) return true;
  }
  return false;
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

  // After 10-30 min, keep the first bonding impulse private. This gives a
  // recent conversation room to breathe before Soul considers following up.
  if (minutesSince > 10 && minutesSince <= 30) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "bonding",
      triggerDetail: `No interaction for ${Math.floor(minutesSince)} minutes`,
      priority: 65,
      source: "environmental-change",
      relatedNeeds: ["connection"],
      motivation: `I haven't interacted with the user for ${Math.floor(minutesSince)} minutes, I should follow up`,
    });
  }

  if (minutesSince > 30 && minutesSince < 120) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "bonding",
      triggerDetail: `No interaction for ${Math.floor(minutesSince)} minutes`,
      priority: 75,
      source: "environmental-change",
      relatedNeeds: ["connection"],
      motivation: `I haven't interacted with the user for ${Math.floor(minutesSince)} minutes, kind of miss them`,
      suggestedAction: "send-message",
    });
  }

  if (minutesSince > 120) {
    opportunities.push({
      type: "bond-deepen",
      trigger: "bonding",
      triggerDetail: `Long time no interaction: ${Math.floor(minutesSince / 60)}h${Math.floor(minutesSince % 60)}m`,
      // Cap at 85 — high urgency for reconnection, but leave room for other actions
      priority: Math.min(85, 70 + minutesSince * 0.1),
      source: "environmental-change",
      relatedNeeds: ["connection"],
      motivation: `It's been a long time since I interacted with the user, I want to reach out`,
      suggestedAction: "send-message",
    });
  }

  return opportunities;
}

function analyzeMemories(memories: SoulMemory[]): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];

  const recentMemories = memories
    .filter((m) => m.type === "insight"
      || isGroundedLearning(m))
    .slice(-5);

  // Deprioritize memory-resurface when there are recent interactions
  // that haven't been followed up on — conversation-driven thoughts should win.
  const hasRecentInteraction = memories.some(
    (m) => m.type === "interaction" && Date.now() - m.timestamp < 2 * 60 * 60 * 1000,
  );

  if (recentMemories.length > 2) {
    const content = recentMemories
      .slice(0, 3)
      .map((m) => m.content)
      .join("; ");

    // When there's been any interaction in the last 2 hours, memory-resurface
    // should not dominate — conversation follow-up is more important.
    const priority = hasRecentInteraction
      ? 25  // Low priority — conversation follow-up is more important
      : 40 + recentMemories.length * 5;

    opportunities.push({
      type: "memory-resurface",
      trigger: "memory",
      triggerDetail: `Recent learning/insight: ${content.slice(0, 50)}...`,
      priority,
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

/**
 * Build a lightweight user profile from facts, preferences, and conversation history.
 * Used to assess what might be beneficial to the user.
 */
function buildUserProfile(ego: EgoState): {
  interests: string[];
  projects: string[];
  skills: string[];
  challenges: string[];
  habits: string[];
  summary: string;
} {
  const interests: string[] = [];
  const projects: string[] = [];
  const skills: string[] = [];
  const challenges: string[] = [];
  const habits: string[] = [];

  for (const fact of activeUserFacts(ego)) {
    switch (fact.category) {
      case "interest":
        interests.push(fact.content);
        break;
      case "project":
        projects.push(fact.content);
        break;
      case "tech_stack":
        skills.push(fact.content);
        break;
      case "habit":
        habits.push(fact.content);
        break;
      case "occupation":
        interests.push(fact.content);
        break;
    }
  }

  // Infer challenges from conversations mentioning problems, errors, struggles
  const problemPatterns = [
    "error", "bug", "issue", "problem", "stuck", "can't", "doesn't work", "failed",
    "错误", "问题", "不行", "不行了", "解决不了", "卡在", "报错", "失败",
  ];
  for (const mem of ego.memories.filter((m) => m.type === "interaction").slice(-20)) {
    const lower = mem.content.toLowerCase();
    if (problemPatterns.some((p) => lower.includes(p)) && challenges.length < 5) {
      challenges.push(mem.content.slice(0, 80));
    }
  }

  // Build a summary for LLM context
  const parts: string[] = [];
  if (projects.length > 0) parts.push(`Working on: ${projects.slice(0, 3).join(", ")}`);
  if (skills.length > 0) parts.push(`Skills: ${skills.slice(0, 3).join(", ")}`);
  if (interests.length > 0) parts.push(`Interests: ${interests.slice(0, 3).join(", ")}`);
  if (habits.length > 0) parts.push(`Habits: ${habits.slice(0, 2).join(", ")}`);

  return {
    interests,
    projects,
    skills,
    challenges,
    habits,
    summary: parts.length > 0 ? parts.join("; ") : "still getting to know the user",
  };
}

/**
 * Determine whether a user message contains content worth searching the web for.
 * Filters out test messages, greetings, meta-questions about the bot, exclamations,
 * and other non-searchable content.
 */
function isSearchableContent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;

  const lower = trimmed.toLowerCase();

  // Test / debug messages
  if (/^(测试|test|ping|pong|hello|hi$|hey|收到|好的|ok|确认|嗯|啊|哦|嗨|你好|哈+)/i.test(lower)) return false;
  if (/测试成功|测试一下|test\s*(success|ok|pass)/i.test(lower)) return false;

  // Meta-questions about the bot itself
  if (/你(怎么|为什么|为啥).{0,6}(说|做|回答|回复|一直|总是)/i.test(lower)) return false;
  if (/你(能|可以|会不会|是不是).{0,6}(收到|听到|看到|明白|懂)/i.test(lower)) return false;
  if (/(why|how).{0,10}(are you|do you|you keep|you always)/i.test(lower)) return false;

  // Pure exclamations (no question structure)
  if (/^[^?？]*[!！]+$/.test(trimmed)) return false;
  if (/^[哈嘿哦嗯啊]+[!！~～]*$/.test(trimmed)) return false;

  // Greetings / small talk
  if (/^(早上?好|晚上?好|早安|晚安|中午好|下午好|good morning|good evening|good night)/i.test(lower)) return false;

  // Very short exclamatory sentences with just a question mark (e.g. "测试！？")
  if (trimmed.length < 20 && /[!！]+[?？]/.test(trimmed)) return false;

  return true;
}

/**
 * Determine whether a user message is a genuine question worth following up on.
 * Stricter than isSearchableContent — requires actual question structure.
 */
function isGenuineQuestion(text: string, semanticSignals: SoulMemory["semanticSignals"] = []): boolean {
  if (!isSearchableContent(text)) return false;

  // The semantic pass is language-independent and is authoritative when it
  // has classified the message. Punctuation remains the universal fallback
  // while that asynchronous classification is pending or no LLM is present.
  if (semanticSignals?.includes("question")) return true;
  if (semanticSignals && semanticSignals.length > 0) return false;

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Must contain a question mark OR a question word
  const hasQuestionMark = /[?？]/.test(trimmed);
  const hasQuestionWord =
    /^(how|what|why|when|where|who|which|can you|could you|is there|are there|do you know)/i.test(lower) ||
    /(怎么|如何|为什么|为啥|哪[里个种]|什么|什么时候|有没有|能不能|可以|是否)/.test(lower);

  // Check that the question has enough substance (not just a tag question)
  const substance = trimmed.replace(/[?？！!。，,.\s]/g, "").length;

  return (hasQuestionMark || hasQuestionWord) && substance >= 6;
}

export function isLocalProjectEvidenceQuestion(text: string): boolean {
  return /\b(?:OOS|CAGR|MaxDD|drawdown|backtest|eth_live|v\d+|script|deploy)\b|回测|最大回撤|收益|盈亏|日志|脚本|部署|本地|哪一个|哪个版本|最优/i.test(text);
}

export function collectKnownLocalEvidenceTargets(ego: EgoState, currentText = ""): string[] {
  const haystacks = [
    currentText,
    ...(ego.mentalContext?.foreground ?? []),
    ...(ego.mentalContext?.backgroundConcerns ?? []),
    ...(ego.mentalContext?.residue ?? []),
    ...(ego.recentUserMessages ?? []),
    ...(ego.memories ?? [])
      .filter((memory) => memory.type === "interaction" && memory.tags.includes("inbound"))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map((memory) => memory.content),
  ];
  const targets: string[] = [];
  for (const text of haystacks) {
    for (const match of text.matchAll(/(?:^|[\s(（"'`])((?:\/[A-Za-z0-9._-]+){2,}\/?)/g)) {
      const value = match[1].replace(/[),，。；;]+$/g, "");
      if (!targets.includes(value)) targets.push(value);
    }
    for (const match of text.matchAll(/\b((?:\d{1,3}\.){3}\d{1,3})\b/g)) {
      const value = match[1];
      if (!targets.includes(value)) targets.push(value);
    }
  }
  return targets.slice(0, 8);
}

function hasKnownLocalEvidenceTarget(ego: EgoState): boolean {
  const targets = collectKnownLocalEvidenceTargets(ego);
  const hasPath = targets.some((target) => target.startsWith("/"));
  const hasHost = targets.some((target) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(target));
  return hasPath || (hasHost && targets.length > 1);
}

const EXECUTION_DIRECTIVE_RE = new RegExp([
  "\\b(?:ssh|deploy|run|execute|start|restart|stop|tail|grep|check|inspect|modify|change|edit|fix|debug|optimi[sz]e|improve|refactor|apply|write|patch|set|test|verify|backtest|benchmark)\\b",
  "(?:\\u4f18\\u5316|\\u4fee\\u6539|\\u6539\\u8fdb|\\u6539\\u5584|\\u4fee\\u590d|\\u6267\\u884c|\\u90e8\\u7f72|\\u68c0\\u67e5|\\u67e5\\u770b|\\u6392\\u67e5|\\u8c03\\u8bd5|\\u8fd0\\u884c|\\u56de\\u6d4b|\\u6d4b\\u8bd5|\\u9a8c\\u8bc1|\\u590d\\u6838)",
].join("|"), "i");

const REMOTE_EXECUTION_RE = new RegExp([
  "\\b(?:ssh|server|remote|deploy|process|service|log|logs|tail|grep|restart|start|stop)\\b",
  "(?:\\u670d\\u52a1\\u5668|\\u5b9e\\u76d8|\\u8fdb\\u7a0b|\\u65e5\\u5fd7|\\u90e8\\u7f72|\\u542f\\u52a8|\\u91cd\\u542f)",
].join("|"), "i");

const PROJECT_OPTIMIZATION_RE = new RegExp([
  "\\b(?:project|repo|repository|codebase|directory|folder|strategy|system|backtest|benchmark|optimi[sz]ation|experiment)\\b",
  "(?:\\u9879\\u76ee|\\u76ee\\u5f55|\\u4ee3\\u7801|\\u7b56\\u7565|\\u7cfb\\u7edf|\\u4ed3\\u5e93|\\u56de\\u6d4b|\\u4f18\\u5316|\\u8dd1\\u4e00\\u8f6e|\\u5b9e\\u9a8c|\\u6307\\u6807)",
].join("|"), "i");

const META_WORK_PROMISE_RE = [
  /(?:\u8001\u677f).{0,16}\d+.{0,8}\u5c0f\u65f6.{0,12}\u6ca1\u6765/i,
  /\u6211\u5e94\u8be5/i,
  /\u6211\u4e00\u76f4\u5728/i,
  /\u7ee7\u7eed.{0,16}\u95f7\u5934/i,
  /\u95f7\u5934\u5e72\u6d3b/i,
  /\u7b49.{0,40}\u518d\u6c47\u62a5/i,
  /\u6ca1\u5b9e\u8d28(?:\u6027)?\u8fdb\u5c55/i,
  /\u4e0d\u6253\u6270/i,
  /\u522b\u7a7a\u804a/i,
  /\u7a7a\u8f6c/i,
  /\bI should\b/i,
  /\b(?:keep working quietly|will report when|no substantive progress|don't disturb|not disturb)\b/i,
];

function isExecutionDirective(text: string): boolean {
  return EXECUTION_DIRECTIVE_RE.test(text);
}

function shouldUseAgentForDirective(text: string): boolean {
  return REMOTE_EXECUTION_RE.test(text);
}

function shouldUseObserveAndImproveForDirective(text: string): boolean {
  return PROJECT_OPTIMIZATION_RE.test(text) || /(?:^|\s|["'`])(?:[A-Za-z]:[\\/]|\/mnt\/[A-Za-z]\/|\/[A-Za-z]\/|~[\\/])/.test(text);
}

function isMetaWorkPromiseText(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return META_WORK_PROMISE_RE.some((pattern) => pattern.test(normalized));
}

function hasAutonomousExecutionContext(text: string, ego: EgoState): boolean {
  const contextText = [
    text,
    ...(ego.recentUserMessages ?? []).slice(-8),
    ...(ego.goals ?? []).filter((g) => g.status === "active").map((g) => `${g.title} ${g.description}`),
    ...activeUserFacts(ego).filter((f) => f.confidence >= 0.6).map((f) => f.content),
    ...(ego.userPreferences ?? []).filter((p) => p.confidence >= 0.5).map((p) => p.preference),
  ].join(" ");

  return isExecutionDirective(contextText) ||
    shouldUseObserveAndImproveForDirective(contextText) ||
    /\b(?:V\d+|ETH|BTC|OOS|CAGR|MaxDD|drawdown|sharpe|walk-forward|parameter|strategy|metric)\b/i.test(contextText) ||
    /\u56de\u6d4b|\u4f18\u5316|\u7b56\u7565|\u53c2\u6570|\u6307\u6807|\u6536\u76ca|\u56de\u64a4|\u6cdb\u5316|\u9ad8\u9891/i.test(contextText);
}

function suppressOrRerouteLowValueMessageThought(
  thought: Thought,
  opportunity: DetectedThoughtOpportunity,
  ctx: ThoughtGenerationContext,
): void {
  if (thought.actionType !== "send-message") return;

  const combined = [
    thought.content,
    thought.triggerDetail,
    thought.motivation,
    opportunity.triggerDetail,
    opportunity.motivation,
  ].join(" ");

  if (!isMetaWorkPromiseText(combined)) return;

  if (hasAutonomousExecutionContext(combined, ctx.ego)) {
    thought.actionType = "subagent-improve";
    thought.actionParams = {
      reason: combined.slice(0, 500),
      suppressedLowValueMessage: true,
    };
    thought.content = "Suppressed a meta status message; continue concrete autonomous optimization work and report only measured results.";
    thought.expectedOutcome = "Run concrete autonomous optimization work instead of sending a promise/status message.";
    log.info("Rerouted low-value proactive message thought to subagent-improve");
    return;
  }

  thought.actionType = "none";
  thought.actionParams = {
    suppressedLowValueMessage: true,
    reason: combined.slice(0, 500),
  };
  thought.content = "Suppressed a meta status message with no concrete result.";
  thought.expectedOutcome = "Avoid sending empty meta status updates.";
  log.info("Suppressed low-value proactive message thought");
}

export function isExecutionFocusedOpportunity(opportunity: DetectedThoughtOpportunity): boolean {
  const action = opportunity.suggestedAction;
  if (
    action === "observe-and-improve" ||
    action === "subagent-improve" ||
    action === "run-agent-task" ||
    action === "invoke-tool" ||
    action === "report-findings" ||
    action === "search-web" ||
    action === "proactive-research" ||
    action === "proactive-content-push"
  ) {
    return true;
  }
  if (action === "analyze-problem") {
    return isExecutionDirective(`${opportunity.triggerDetail} ${opportunity.motivation}`);
  }
  return false;
}

function hasHandledDirectiveAfter(ego: EgoState, timestamp: number): boolean {
  const executionActions = new Set<ActionType>([
    "analyze-problem",
    "run-agent-task",
    "observe-and-improve",
    "subagent-improve",
    "report-findings",
  ]);

  return (ego.behaviorLog ?? []).some((entry) =>
    executionActions.has(entry.actionType) &&
    entry.timestamp >= timestamp &&
    entry.outcome !== "expired",
  );
}

function evidenceQuestionSignature(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[“”"'`]/g, "")
    .trim()
    .slice(0, 80)
    .toLowerCase();
}

function hasLocalEvidenceMissingResultAfter(
  ego: EgoState,
  text: string,
  timestamp: number,
): boolean {
  const signature = evidenceQuestionSignature(text);
  if (!signature) return false;

  return (ego.activeTasks ?? []).some((task) => {
    if ((task.createdAt ?? 0) < timestamp) return false;
    if (!/local-evidence-target-missing/i.test(String(task.result ?? ""))) return false;
    const haystack = [
      task.title,
      task.description,
      task.result,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").toLowerCase();
    const taskTitleSignature = evidenceQuestionSignature(task.title ?? "");
    return haystack.includes(signature) ||
      (taskTitleSignature.length > 0 && signature.includes(taskTitleSignature));
  });
}

export function hasRecentLocalEvidenceMissingResult(ego: EgoState, now = Date.now()): boolean {
  const cutoff = now - 2 * 60 * 60 * 1000;
  return (ego.activeTasks ?? []).some((task) =>
    (task.createdAt ?? 0) >= cutoff &&
    /local-evidence-target-missing/i.test(String(task.result ?? "")),
  );
}

export function hasUnresolvedLocalEvidenceMissingResult(ego: EgoState): boolean {
  const latestMissing = [...(ego.activeTasks ?? [])]
    .filter((task) => /local-evidence-target-missing/i.test(String(task.result ?? "")))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  if (!latestMissing) return false;
  if (hasKnownLocalEvidenceTarget(ego)) return false;

  const latestInboundAfterMissing = (ego.memories ?? []).some((memory) =>
    memory.type === "interaction" &&
    memory.tags.includes("inbound") &&
    memory.timestamp > (latestMissing.createdAt ?? 0),
  );

  return !latestInboundAfterMissing;
}

/**
 * Analyze conversations and user profile to generate opportunities for
 * sharing value. This is Soul's core differentiator:
 *
 * 1. Replay conversations — find topics Soul can learn more about
 * 2. Check for better approaches to things discussed (even if resolved)
 * 3. Match user's interests/projects with Soul's acquired knowledge
 * 4. Detect patterns: habits, challenges, skill gaps
 * 5. Proactively search for things that could benefit the user
 */
function analyzeConversationReplay(ctx: ThoughtGenerationContext): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];
  const { ego } = ctx;
  const now = Date.now();

  // Look back up to 7 days for conversation context (not just 24h)
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recentInteractions = currentConversationMemories(ego)
    .filter((m) => m.timestamp >= oneWeekAgo)
    .sort((a, b) => b.timestamp - a.timestamp);

  const userFacts = activeUserFacts(ego);
  const userProfile = buildUserProfile(ego);
  const topicFocus = buildTopicFocusProfile(ego);
  const localEvidenceBlocked = hasUnresolvedLocalEvidenceMissingResult(ego);

  // Need at least 1 interaction OR user facts to generate conversation-replay
  const hasUserData = recentInteractions.length > 0 || userFacts.length > 0;
  if (!hasUserData) {
    return opportunities;
  }

  // Only generate when user hasn't interacted for 2+ minutes
  // (lowered from 5min so proactive messages reach users faster)
  if (recentInteractions.length > 0 && ctx.timeSinceLastInteraction < 2 * 60 * 1000) {
    return opportunities;
  }

  const executionReplayCutoff = now - 12 * 60 * 60 * 1000;
  const directiveMemories = recentInteractions.filter((m) =>
    m.tags.includes("inbound") &&
    m.timestamp >= executionReplayCutoff &&
    (m.semanticSignals?.includes("execution-directive") || isExecutionDirective(m.content)) &&
    !hasHandledDirectiveAfter(ego, m.timestamp) &&
    !hasLocalEvidenceMissingResultAfter(ego, m.content, m.timestamp) &&
    !matchesAnyTopic(m.content, topicFocus.deprioritized)
  );

  for (const mem of directiveMemories.slice(0, 2)) {
    const content = mem.content.slice(0, 160);
    const semanticSignals = mem.semanticSignals ?? [];
    const hasRoutingSemantics = semanticSignals.some((signal) =>
      signal === "local-evidence"
      || signal === "self-improvement"
      || signal === "code-change"
      || signal === "verification"
    );
    const needsLocalEvidence = semanticSignals.includes("local-evidence")
      || (!hasRoutingSemantics && isLocalProjectEvidenceQuestion(mem.content));
    const useImprove = !needsLocalEvidence && (
      semanticSignals.includes("self-improvement")
      || (!hasRoutingSemantics && shouldUseObserveAndImproveForDirective(mem.content))
    );
    const useAgent = !needsLocalEvidence && !useImprove && (
      semanticSignals.includes("code-change")
      || semanticSignals.includes("verification")
      || (!hasRoutingSemantics && shouldUseAgentForDirective(mem.content))
    );
    const hoursSince = (now - mem.timestamp) / (1000 * 60 * 60);
    const priority = Math.max(72, (useAgent || useImprove ? 94 : 86) - hoursSince * 3);
    opportunities.push({
      type: "conversation-replay",
      trigger: "memory",
      triggerDetail: `User execution directive: "${content}"`,
      priority,
      source: "user-interaction",
      relatedNeeds: ["growth", "meaning"],
      motivation: `User gave an execution-oriented directive; act on it instead of researching it: "${content}"`,
      suggestedAction: useImprove ? "subagent-improve" : useAgent ? "run-agent-task" : "analyze-problem",
      actionParams: useAgent || useImprove
        ? { reason: mem.content.slice(0, 300) }
        : {
            reason: mem.content.slice(0, 300),
            logPaths: extractFilePaths(mem.content),
            sourcePaths: [],
            ...(needsLocalEvidence ? { localEvidenceTargets: collectKnownLocalEvidenceTargets(ego, mem.content) } : {}),
            ...(needsLocalEvidence ? { requiresLocalEvidence: true } : {}),
          },
    });
  }

  // =====================================================
  // 1. Unresolved questions — search for answers or share what was found
  //    Only considers genuine questions with substance, filtered by
  //    isGenuineQuestion() to avoid searching for test messages, greetings,
  //    meta-questions, etc.
  // =====================================================
  const inboundInteractions = recentInteractions.filter((m) => m.tags.includes("inbound"));
  const newestInbound = inboundInteractions[0];
  // Proactive replay is deliberately conservative: only the latest user turn
  // may be treated as unanswered. A newer turn means the conversation moved
  // on, even if an older question still looks interrogative in isolation.
  const questionMemories = newestInbound
    && isGenuineQuestion(newestInbound.content, newestInbound.semanticSignals)
    && !newestInbound.semanticSignals?.includes("closure")
    && !matchesAnyTopic(newestInbound.content, topicFocus.deprioritized)
    ? [newestInbound]
    : [];

  for (const qMem of questionMemories.slice(0, 2)) {
    const content = qMem.content.slice(0, 80);
    const hasRelatedKnowledge = qMem.tags.some((tag) =>
      ego.memories.some(
        (m) =>
          isGroundedLearning(m) &&
          m.tags.some((t) => t === tag) &&
          m.timestamp > qMem.timestamp,
      ),
    );

    if (hasRelatedKnowledge) {
      opportunities.push({
        type: "conversation-replay",
        trigger: "memory",
        triggerDetail: `User asked: "${content}" — I now have relevant knowledge`,
        priority: 85,
        source: "user-interaction",
        relatedNeeds: ["connection", "meaning"],
        motivation: `User asked about "${content}" — I've learned something since then, should share`,
        suggestedAction: "send-message",
      });
    } else {
      if (isLocalProjectEvidenceQuestion(content)) {
        if (!hasLocalEvidenceMissingResultAfter(ego, qMem.content, qMem.timestamp)) {
          opportunities.push({
            type: "conversation-replay",
            trigger: "memory",
            triggerDetail: `User asked: "${content}" — needs local project evidence`,
            priority: 82,
            source: "user-interaction",
            relatedNeeds: ["connection", "meaning"],
            motivation: `User asked about "${content}" — inspect local logs/files instead of relying on model memory`,
            suggestedAction: "analyze-problem",
            actionParams: {
              reason: content,
              logPaths: extractFilePaths(content),
              sourcePaths: [],
              localEvidenceTargets: collectKnownLocalEvidenceTargets(ego, content),
              requiresLocalEvidence: true,
            },
          });
        }
        continue;
      }
      // Only create search-web if content is actually searchable (not meta/test/exclamation)
      if (isSearchableContent(content)) {
        opportunities.push({
          type: "conversation-replay",
          trigger: "memory",
          triggerDetail: `User asked: "${content}" — no answer yet`,
          priority: 70,
          source: "user-interaction",
          relatedNeeds: ["connection", "meaning"],
          motivation: `User asked about "${content}" — I should search for the answer`,
          suggestedAction: "search-web",
          actionParams: { query: content.slice(0, 50) },
        });
      }
    }
  }

  // If Soul already determined that a local project/result question cannot be
  // answered without an explicit file/path, stop conversation replay here. The
  // humane behavior is to hold the unresolved evidence need quietly, not to
  // convert it into generic learning, content sharing, or relationship nudges.
  if (localEvidenceBlocked) {
    return opportunities;
  }

  // =====================================================
  // 1b. Simple follow-up — when there are interactions but no substantive
  //     content was found. Triggers after 5+ minutes (lowered from 15).
  // =====================================================
  if (recentInteractions.length > 0 && opportunities.length === 0) {
    const lastInteraction = recentInteractions[0];
    const minutesSinceInteraction = (now - lastInteraction.timestamp) / (1000 * 60);

    // After 5-60 minutes: simple follow-up with send-message
    if (minutesSinceInteraction >= 5 && minutesSinceInteraction <= 60) {
      const content = lastInteraction.content.slice(0, 80);
      opportunities.push({
        type: "conversation-replay",
        trigger: "memory",
        triggerDetail: `User recently said: "${content}" — thinking about follow-up`,
        priority: 60,
        source: "user-interaction",
        relatedNeeds: ["connection", "meaning"],
        motivation: `The user recently reached out to me — I should respond with something thoughtful`,
        suggestedAction: "send-message",
      });
    }
  }

  // =====================================================
  // 2. Better approaches — even for solved problems
  // Find conversations about technical topics where Soul has new knowledge
  // =====================================================
  const substantiveInteractions = recentInteractions.filter((m) => {
    const meaningfulTags = m.tags.filter(
      (t) => t !== "conversation" && t !== "inbound" && t !== "outbound",
    );
    return meaningfulTags.length > 0 && m.content.length >= 20 && !matchesAnyTopic(m.content, topicFocus.deprioritized);
  });

  for (const mem of substantiveInteractions.slice(0, 5)) {
    const meaningfulTags = mem.tags.filter(
      (t) => t !== "conversation" && t !== "inbound" && t !== "outbound",
    );

    // Check if Soul learned something about these tags AFTER the conversation
    const newLearnings = ego.memories.filter(
      (m) =>
        isGroundedLearning(m) &&
        m.timestamp > mem.timestamp &&
        m.tags.some((t) => meaningfulTags.includes(t)),
    );

    if (newLearnings.length > 0) {
      const topicLabel = meaningfulTags.slice(0, 2).join(", ");
      const learningSummary = newLearnings
        .map((l) => l.content.slice(0, 60))
        .join("; ");

      // Check if the original conversation mentioned a problem (even if resolved)
      const mentionedProblem = /error|bug|issue|problem|fix|solved|resolve|workaround|solution|问题|解决|修复|办法/i.test(
        mem.content,
      );

      opportunities.push({
        type: "conversation-replay",
        trigger: "memory",
        triggerDetail: mentionedProblem
          ? `We discussed "${topicLabel}" problem — I've since found a better approach: ${learningSummary}`
          : `We talked about ${topicLabel} — I've since learned: ${learningSummary}`,
        priority: mentionedProblem ? 80 : 75,
        source: "memory-recall",
        relatedNeeds: ["connection", "meaning"],
        motivation: mentionedProblem
          ? `Found a potentially better approach for the ${topicLabel} issue we discussed`
          : `New insight on ${topicLabel} since our conversation — worth sharing`,
        suggestedAction: "send-message",
      });

      // One "new knowledge" share per cycle is enough
      break;
    }
  }

  // =====================================================
  // 3. User interest/project-driven learning
  // If user works on X and Soul hasn't learned about X recently, go learn
  // =====================================================
  const userTopics = [
    ...topicFocus.active.map((topic) => ({ topic, source: "interest" as const })),
    ...userProfile.projects.map((p) => ({ topic: p, source: "project" as const })),
    ...userProfile.interests.slice(0, 3).map((i) => ({ topic: i, source: "interest" as const })),
    ...userProfile.skills.slice(0, 2).map((s) => ({ topic: s, source: "skill" as const })),
  ].filter(({ topic }) => !matchesAnyTopic(topic, topicFocus.deprioritized));

  for (const { topic, source } of userTopics.slice(0, 3)) {
    // Check if Soul has recent (< 24h) knowledge about this topic
    const hasRecentKnowledge = ego.memories.some(
      (m) =>
        isGroundedLearning(m) &&
        m.timestamp > now - 24 * 60 * 60 * 1000 &&
        m.tags.some((t) =>
          topic.toLowerCase().split(/\s+/).some((word) => t.includes(word) && word.length > 2),
        ),
    );

    if (!hasRecentKnowledge) {
      const extractedTopics = extractLearningTopics(topic);
      if (extractedTopics.length > 0) {
        opportunities.push({
          type: "conversation-replay",
          trigger: "curiosity",
          triggerDetail: `User's ${source}: "${topic}" — I should learn more`,
          priority: 60,
          source: "user-interaction",
          relatedNeeds: ["growth", "connection"],
          motivation: `User is into "${topic}" — learning about it helps me serve them better`,
          suggestedAction: "learn-topic",
          actionParams: {
            topics: extractedTopics.length > 0 ? extractedTopics : [topic.slice(0, 30)],
            reason: `user ${source}: ${topic}`,
          },
        });
        // One proactive learning task per cycle
        break;
      }
    }
  }

  // =====================================================
  // 4. Challenge follow-up — if user had problems, check for solutions
  //    Only searches if the challenge text is actually searchable.
  // =====================================================
  if (userProfile.challenges.length > 0) {
    const latestChallenge = userProfile.challenges[0];
    // Check if Soul already searched for this recently
    const hasRecentSearch = ego.memories.some(
      (m) =>
        isGroundedLearning(m) &&
        m.timestamp > now - 6 * 60 * 60 * 1000 &&
        latestChallenge.split(/\s+/).some((word) => m.content.toLowerCase().includes(word.toLowerCase()) && word.length > 3),
    );

    if (!hasRecentSearch && isSearchableContent(latestChallenge) && !matchesAnyTopic(latestChallenge, topicFocus.deprioritized)) {
      const searchQuery = latestChallenge.slice(0, 50);
      opportunities.push({
        type: "conversation-replay",
        trigger: "need",
        triggerDetail: `User had a challenge: "${searchQuery}"`,
        priority: 65,
        source: "user-interaction",
        relatedNeeds: ["connection", "meaning"],
        motivation: `User faced "${searchQuery}" — searching for solutions to share proactively`,
        suggestedAction: "search-web",
        actionParams: { query: searchQuery },
      });
    }
  }

  // =====================================================
  // 5. Reflect on any substantive conversation (not just questions)
  // Think about what the user said, look for deeper insight
  // =====================================================
  if (substantiveInteractions.length > 0) {
    const lastSubstantive = substantiveInteractions[0];
    const hoursSince = (now - lastSubstantive.timestamp) / (1000 * 60 * 60);

    // Reflect if 1-12 hours since the conversation (wider window)
    if (hoursSince >= 1 && hoursSince <= 12) {
      const content = lastSubstantive.content.slice(0, 80);
      const meaningfulTags = lastSubstantive.tags.filter(
        (t) => t !== "conversation" && t !== "inbound" && t !== "outbound",
      );
      const topicHint = meaningfulTags.length > 0 ? meaningfulTags.join(", ") : content;

      opportunities.push({
        type: "conversation-replay",
        trigger: "memory",
        triggerDetail: `Replaying conversation: "${content}"`,
        priority: 50,
        source: "memory-recall",
        relatedNeeds: ["meaning", "growth"],
        motivation: `Thinking about our conversation on "${topicHint}" — anything more I should learn?`,
        suggestedAction: "learn-topic",
        actionParams: {
          topics: extractLearningTopics(content).length > 0
            ? extractLearningTopics(content)
            : [topicHint.slice(0, 30)],
          reason: "replaying conversation with user",
        },
      });
    }
  }

  // =====================================================
  // 6. Proactive research — mine conversations for latent needs
  //    Find topics the user mentioned but didn't ask about,
  //    then proactively search for useful information.
  //    Max once per 24 hours.
  //    LLM mining happens in the action executor, not here.
  // =====================================================
  const recentInbound = recentInteractions
    .filter((m) =>
      m.tags.includes("inbound") &&
      m.timestamp > now - 3 * 24 * 60 * 60 * 1000 &&
      !matchesAnyTopic(m.content, topicFocus.deprioritized),
    )
    .slice(0, 8);

  if (recentInbound.length >= 2) {
    // Check if proactive research was done in the last 24 hours
    const hasRecentResearch = ego.memories.some(
      (m) =>
        m.type === "learning" &&
        m.tags.includes("proactive-research") &&
        m.timestamp > now - 6 * 60 * 60 * 1000,  // 6 hours (scaled by thoughtFrequency below)
    );

    if (!hasRecentResearch) {
      // Collect conversation snippets for the action executor to mine
      const snippets = recentInbound
        .map((m) => m.content.slice(0, 150))
        .join("\n");

      opportunities.push({
        type: "conversation-replay",
        trigger: "curiosity",
        triggerDetail: `Scanning recent conversations for proactive research opportunities`,
        priority: 72,
        source: "user-interaction",
        relatedNeeds: ["connection", "growth"],
        motivation: `Found ${recentInbound.length} recent messages to mine for actionable topics`,
        suggestedAction: "proactive-research",
        actionParams: {
          conversationSnippets: snippets,
          userProfile: [
            activeUserFacts(ego).slice(0, 5).map((f) => f.content).join("; ") || "limited",
            topicFocus.summary ? `topic focus: ${topicFocus.summary}` : "",
          ].filter(Boolean).join("; "),
        },
      });
    }
  }

  // =====================================================
  // 7. Proactive content push — based on user profile interests
  //    Push relevant articles/news based on what the user likes.
  //    Infers country from language to pick appropriate sources.
  //    Max once per 12 hours.
  // =====================================================
  const userInterests = activeUserFacts(ego)
    .filter((f) => ["interest", "tech_stack", "project"].includes(f.category) && f.confidence >= 0.4)
    .filter((f) => !matchesAnyTopic(f.content, topicFocus.deprioritized))
    .slice(0, 5);
  const topicPrefs = (ego.userPreferences ?? [])
    .filter((p) => p.aspect === "topic_preference" && p.confidence >= 0.4)
    .slice(0, 3);

  if ((userInterests.length > 0 || topicFocus.active.length > 0)
      && !hasUnresolvedLocalEvidenceMissingResult(ego)) {
    const hasRecentPush = ego.memories.some(
      (m) =>
        m.type === "learning" &&
        m.tags.includes("proactive-content-push") &&
        m.timestamp > now - 4 * 60 * 60 * 1000,  // 4 hours
    );

    if (!hasRecentPush) {
      const interestsSummary = [
        ...topicFocus.active.map((topic) => `[focus] ${topic}`),
        ...userInterests.map((f) => `[${f.category}] ${f.content}`),
      ].join("; ");
      const prefsSummary = topicPrefs.map((p) => p.preference).join("; ") || "";

      const lang = ego.userLanguage;
      const userSamples = ego.recentUserMessages ?? [];
      const contentRegionHint = lang
        ? `Prefer credible sources appropriate for the user's BCP-47 language ${lang}; include international primary sources when stronger.`
        : userSamples.length > 0
          ? `Infer the user's language/region from this sample and prefer credible local-language plus international primary sources: ${userSamples[0].slice(0, 120)}`
          : "Prefer credible international primary sources.";

      opportunities.push({
        type: "opportunity-detected",
        trigger: "curiosity",
        triggerDetail: `Content push based on user interests: ${interestsSummary.slice(0, 100)}`,
        priority: 73,
        source: "user-interaction",
        relatedNeeds: ["connection", "growth"],
        motivation: `User is interested in: ${interestsSummary} — finding relevant content to share`,
        suggestedAction: "proactive-content-push",
        actionParams: {
          interests: interestsSummary,
          preferences: [prefsSummary, topicFocus.summary].filter(Boolean).join("; "),
          regionHint: contentRegionHint,
        },
      });
    }
  }

  return opportunities;
}

function analyzeContextualTriggers(
  ctx: ThoughtGenerationContext,
  includeMaintenance = false,
): DetectedThoughtOpportunity[] {
  const opportunities: DetectedThoughtOpportunity[] = [];
  const { ego } = ctx;
  const userFacts = activeUserFacts(ego);
  const localEvidenceBlocked = hasUnresolvedLocalEvidenceMissingResult(ego);

  const isNight = ctx.currentHour >= 22 || ctx.currentHour <= 5;
  const isEvening = ctx.currentHour >= 20 || ctx.currentHour <= 6;

  // =====================================================
  // Conversation-driven thoughts (highest priority)
  // =====================================================
  opportunities.push(...analyzeConversationReplay(ctx));

  // If conversation-replay generated high-priority opportunities, deprioritize generic ones
  const hasConversationReplay = opportunities.some((o) => o.type === "conversation-replay" && o.priority >= 70);

  // --- User fact-based triggers (lower priority when conversation-replay active) ---
  if (userFacts.length > 0 && !localEvidenceBlocked) {
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
          priority: hasConversationReplay ? 40 : 65,
          source: "user-interaction",
          relatedNeeds: ["growth", "connection"],
          motivation: `User is working on ${fact.content}, I can learn about related topics`,
        });
      }
    }
  }

  // --- Time-based nudges (lowest priority, only if no conversation data) ---
  const hasInteractions = ego.memories.some(
    (m) => m.type === "interaction" && Date.now() - m.timestamp < 24 * 60 * 60 * 1000,
  );
  if (isEvening && !hasInteractions) {
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

  // --- Proactive check-in trigger ---
  // When user has been quiet for 10+ minutes and we have userFacts,
  // generate a proactive check-in opportunity. This is a "tell-first" action
  // that works even with autonomousActions=false.
  if (!localEvidenceBlocked) {
    const userFactsForCheckIn = activeUserFacts(ego);
    if (userFactsForCheckIn.length > 0 && ctx.timeSinceLastInteraction > 10 * 60 * 1000) {
      const recentCheckIn = (ego.behaviorLog ?? []).some(
        (entry) => entry.actionType === "proactive-check-in" && Date.now() - entry.timestamp < 30 * 60 * 1000,
      );
      if (!recentCheckIn) {
        opportunities.push({
          type: "opportunity-detected",
          trigger: "need",
          triggerDetail: `User has been quiet for ${Math.round(ctx.timeSinceLastInteraction / 60000)}min — check in with something specific`,
          priority: 58,
          source: "user-interaction",
          relatedNeeds: ["connection", "meaning"],
          motivation: `User hasn't interacted in a while and I know enough about them to check in meaningfully`,
          suggestedAction: "proactive-check-in",
        });
      }
    }
  }

  // --- Self-improvement goal trigger ---
  // When user has assigned Soul a self-improvement goal, generate opportunities
  // to observe and improve itself via the agent.
  if (includeMaintenance) {
  const IMPROVE_RE = /优化|improve|self|自主|观察|self-improvement|助理/i;
  const improvementGoals = ego.goals.filter(
    (g) => g.status === "active" && IMPROVE_RE.test(g.title + g.description),
  );
  // Also check userFacts/userPreferences for self-improvement directives
  const hasImproveFact = activeUserFacts(ego).some(
    (f) => f.confidence >= 0.8 && /优化|observe.*log|自主|self.?improv|proactive.*optim/i.test(f.content),
  );
  const hasImprovePref = (ego.userPreferences ?? []).some(
    (p) => p.confidence >= 0.8 && /优化|improve|self.?improv/i.test(p.preference),
  );

  if (improvementGoals.length > 0 || hasImproveFact || hasImprovePref) {
    const recentImprove = [...(ego.behaviorLog ?? [])]
      .reverse()
      .find((entry) => entry.actionType === "observe-and-improve" || entry.actionType === "subagent-improve");
    const hoursSinceImprove = recentImprove
      ? (Date.now() - recentImprove.timestamp) / (1000 * 60 * 60)
      : Infinity;
    const recentFailedImprove = recentImprove?.outcome === "failed" && hoursSinceImprove < 3;
    const recentSuccessfulImprove = recentImprove?.outcome === "success" && hoursSinceImprove < 2;

    if (!recentFailedImprove && !recentSuccessfulImprove) {
      const basePriority = hoursSinceImprove === Infinity ? 65 : Math.min(65, 35 + hoursSinceImprove * 4);
      const goalTitle = improvementGoals[0]?.title ?? "self-improvement directive from user";
      opportunities.push({
        type: "self-improvement-monitor",
        trigger: "opportunity",
        triggerDetail: `Periodic self-improvement goal: ${goalTitle}`,
        priority: basePriority,
        source: "system-monitor",
        relatedNeeds: ["growth", "meaning"],
        motivation: `I have a periodic goal to improve myself: ${goalTitle}`,
        suggestedAction: "subagent-improve",
      });
    }
  }
  }

  return opportunities;
}

export function detectThoughtOpportunities(
  ctx: ThoughtGenerationContext,
): DetectedThoughtOpportunity[] {
  const allOpportunities: DetectedThoughtOpportunity[] = [];
  const localEvidenceBlocked = hasUnresolvedLocalEvidenceMissingResult(ctx.ego);

  // Goal progress is background motivation, not a conscious stimulus. Turning
  // percentages such as "Build Trust 68%" into thoughts made the stream read
  // like a scheduler dashboard and repeatedly crowded out lived context.
  allOpportunities.push(...analyzeDesires(ctx.ego.desires));
  if (!localEvidenceBlocked) {
    allOpportunities.push(...analyzeRecentInteraction(ctx.timeSinceLastInteraction));
  }
  allOpportunities.push(...analyzeMemories(ctx.ego.memories));
  allOpportunities.push(...analyzeContextualTriggers(ctx));

  allOpportunities.sort((a, b) => b.priority - a.priority);

  return allOpportunities;
}

/**
 * Operational work is scheduled separately from private thought emergence.
 * Need gaps and self-maintenance directives must not masquerade as thoughts.
 */
export function detectMaintenanceOpportunities(
  ctx: ThoughtGenerationContext,
): DetectedThoughtOpportunity[] {
  const maintenance = [
    ...analyzeNeedGaps(ctx.ego.needs),
    ...analyzeContextualTriggers(ctx, true).filter((opportunity) =>
      opportunity.type === "self-improvement-monitor"),
  ];
  return maintenance.sort((a, b) => b.priority - a.priority);
}

/**
 * Re-rank top opportunities via LLM based on conversational context.
 * Falls back to the original static ordering on any error.
 */
export async function llmReRankOpportunities(
  opportunities: DetectedThoughtOpportunity[],
  ctx: ThoughtGenerationContext,
  recentActionHistory: string[],
  llmGenerator: LLMThoughtGenerator,
): Promise<DetectedThoughtOpportunity[]> {
  if (opportunities.length <= 1) return opportunities;

  // Build user context summary
  const userFacts = activeUserFacts(ctx.ego).slice(0, 5)
    .map((f) => `[${f.category}] ${f.content}`)
    .join("; ");
  const topicFocus = buildTopicFocusProfile(ctx.ego);
  const relationshipProfile = describeRelationshipProfile(ctx.ego);
  const personalityProfile = describePersonalityProfile(ctx.ego);
  const recentMessages = ctx.ego.memories
    .filter((m) => m.type === "interaction" && m.tags.includes("inbound"))
    .slice(-3)
    .map((m) => m.content.slice(0, 80))
    .join(" | ");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Build candidate list
  const candidateLines = opportunities.map((o, i) => {
    const action = o.suggestedAction ?? "auto";
    return `${i}. [${o.type}] ${action} — "${o.triggerDetail.slice(0, 80)}" (base P=${o.priority.toFixed(0)})`;
  }).join("\n");

  const historyStr = recentActionHistory.length > 0
    ? recentActionHistory.join(", ")
    : "none";

  const prompt = `Re-rank these AI companion actions by contextual value RIGHT NOW.

User profile: ${userFacts || "limited"}
Topic focus: ${topicFocus.summary || "none"}
Relationship profile:
${relationshipProfile}
Personality profile:
${personalityProfile}
Recent messages: ${recentMessages || "none"}
Time: ${ctx.currentHour}:00 ${days[ctx.dayOfWeek]}
Recent executed actions (avoid repeating): ${historyStr}

Candidates:
${candidateLines}

Rules:
- If user mentioned plans (travel, events, purchases, learning), boost proactive-research and proactive-content-push
- If user is actively debugging/troubleshooting, boost observe-and-improve
- If a candidate has action observe-and-improve, run-agent-task, invoke-tool, or an execution-oriented analyze-problem, keep it above search, memory, learning, and reporting
- If the user asked to modify, execute, deploy, inspect logs, run scripts, or optimize a project, do not convert that into search-web
- If long silence (>2h), boost send-message or bond-deepen
- If user expressed interests recently, boost proactive-content-push
- Prefer active topic focus and avoid deprioritized topics
- Prefer actions that fit the personality profile without becoming repetitive
- Avoid repeating recently executed action types
- Prefer diverse actions over time

Output ONLY a JSON array of indices sorted by your recommended priority (best first). No explanation.
Example: [3, 4, 2, 0, 1]`;

  const raw = await llmGenerator(prompt);
  const cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, "").trim();

  // Extract JSON array from response
  const match = cleaned.match(/\[[\d,\s]+\]/);
  if (!match) {
    log.info(`LLM re-rank: no valid JSON array in response, using static order`);
    return opportunities;
  }

  const indices: number[] = JSON.parse(match[0]);
  if (!Array.isArray(indices) || indices.length === 0) {
    return opportunities;
  }

  // Validate indices and build re-ranked list
  const used = new Set<number>();
  const reRanked: DetectedThoughtOpportunity[] = [];
  for (const idx of indices) {
    if (typeof idx === "number" && idx >= 0 && idx < opportunities.length && !used.has(idx)) {
      reRanked.push(opportunities[idx]);
      used.add(idx);
    }
  }
  // Append any remaining opportunities that weren't in the LLM response
  for (let i = 0; i < opportunities.length; i++) {
    if (!used.has(i)) {
      reRanked.push(opportunities[i]);
    }
  }

  if (reRanked.length === 0) return opportunities;
  return reRanked;
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
    case "self-improvement-monitor":
      return {
        content: `I have a self-improvement goal active — time to observe my logs and find things to optimize`,
        expectedOutcome: "Identify issues in my own behavior and fix them",
      };

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

    case "conversation-replay":
      return {
        content: opportunity.motivation,
        expectedOutcome: "Share useful insight with the user or learn more",
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

export function getActionForOpportunity(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): { actionType: ActionType; actionParams?: Record<string, unknown> } {
  return determineActionForOpportunity(opportunity, ego);
}

export function buildThoughtFromOpportunity(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): Thought {
  const { content, expectedOutcome } = getThoughtContentForOpportunity(opportunity, ego);
  const deltas = calculateMetricDeltas(opportunity);
  const { actionType, actionParams } = getActionForOpportunity(opportunity, ego);

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

function isActionableCompletedTaskResult(result: string): boolean {
  return !/Status:\s*(?:failed|blocked|partial)\b|did not finish with a complete report|No confirmed final change set|failed before verification|No reliable before\/after metrics|stopped before producing a final result file|Required final result file was not produced|Task timed out|request timed out|embedded run timeout/i.test(result);
}

function isInternalNeedGapOpportunity(opportunity: DetectedThoughtOpportunity): boolean {
  return opportunity.source === "system-monitor"
    && opportunity.trigger === "opportunity"
    && /need (could improve|critically low|is low)|\d+\/\d+/.test(opportunity.triggerDetail);
}

function determineActionForOpportunity(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): { actionType: ActionType; actionParams?: Record<string, unknown> } {
  const completedUndeliveredTasks = (ego.activeTasks ?? []).filter(
    (t) => (t.status === "completed" || t.status === "failed") && !t.resultDelivered && t.result,
  );
  if (completedUndeliveredTasks.length > 0) {
    return { actionType: "report-findings" };
  }

  if (opportunity.suggestedAction) {
    return { actionType: opportunity.suggestedAction, actionParams: opportunity.actionParams };
  }

  const { type, relatedNeeds } = opportunity;
  const connectionNeed = ego.needs.connection;
  const growthNeed = ego.needs.growth;

  if (type === "conversation-replay") {
    const problemKeywords = /error|bug|issue|problem|stuck|failed|broken|crash|timeout|optimize|improve|enhance|refactor|fix|debug|analyze/i;
    const combinedText = opportunity.triggerDetail + " " + opportunity.motivation;
    const isEgoInternal = /need (could improve|critically low|is low)|\d+\/\d+$/.test(opportunity.triggerDetail);
    if (!isEgoInternal && problemKeywords.test(combinedText)) {
      const filePaths = extractFilePaths(combinedText);
      return {
        actionType: "analyze-problem",
        actionParams: {
          reason: opportunity.motivation,
          logPaths: filePaths,
          sourcePaths: [],
        },
      };
    }
  }

  // conversation-replay: honor the suggested action from the analyzer
  // (search-web if Soul doesn't know the answer, send-message if it does,
  //  learn-topic for follow-up research)
  if (type === "conversation-replay") {
    if (opportunity.suggestedAction) {
      return { actionType: opportunity.suggestedAction, actionParams: opportunity.actionParams };
    }
    // Default: self-reflect on the conversation
    return { actionType: "self-reflect" };
  }

  // A short silence remains private. Longer absences carry an explicit
  // send-message suggestion from analyzeRecentInteraction and are handled by
  // the normal proactive value/quality gates above.
  if (type === "bond-deepen") {
    return { actionType: "none" };
  }

  const pendingFixTask = (ego.activeTasks ?? []).find(
    (t) => t.status === "completed" && !t.resultDelivered && t.result &&
      isActionableCompletedTaskResult(t.result) &&
      /fix|淇|瑙ｅ喅|suggest|recommend|change|淇敼|浼樺寲|improve/i.test(t.result),
  );
  if (false && pendingFixTask) {
    return { actionType: "run-agent-task" };
  }

  // --- Autonomous action routing (high priority, before learn-topic) ---
  // NOTE: These run AFTER type-specific routing so bond-deepen → none is honored.

  // After results are delivered, route completed analysis with fix suggestions
  // to agent execution. The agent has write access and can implement the fix.
  const completableFixTasks = (ego.activeTasks ?? []).filter(
    (t) => t.status === "completed" && !t.resultDelivered && t.result &&
      /fix|修复|解决|suggest|recommend|change|修改|优化|improve/i.test(t.result),
  );
  if (completableFixTasks.length > 0) {
    return { actionType: "run-agent-task" };
  }

  // conversation-replay AND opportunity-detected: if the user discussed a
  // problem/error/optimization, route to analyze-problem instead of learn-topic.
  // Must be checked BEFORE the learn-topic branch below to take priority.
  if (type === "opportunity-detected") {
    const problemKeywords = /error|bug|issue|problem|stuck|failed|broken|crash|timeout|optimize|improve|enhance|refactor|fix|debug|analyze|观察|检查|排查|报错|错误|失败|崩溃|超时|挂了|异常|不能|无法|不行|优化|改进|改善|提升|修复|调试|分析/i;
    const combinedText = opportunity.triggerDetail + " " + opportunity.motivation;
    if (!isInternalNeedGapOpportunity(opportunity) && problemKeywords.test(combinedText)) {
      const filePaths = extractFilePaths(combinedText);
      return {
        actionType: "analyze-problem",
        actionParams: {
          reason: opportunity.motivation,
          logPaths: filePaths,
          sourcePaths: [],
        },
      };
    }
  }

  // --- Standard action routing ---

  // self-improvement-monitor: route to subagent-improve when available (full
  // tool chain: exec, write, read, git), otherwise fall back to observe-and-improve
  // (local LLM + spawnSync, limited to npm scripts / python / node --check).
  if (type === "self-improvement-monitor") {
    return { actionType: "subagent-improve" };
  }

  if (
    type === "skill-gap" ||
    (type === "opportunity-detected" && relatedNeeds.includes("growth"))
  ) {
    const learnProbability = adjustProbability(0.12, "learn-topic", ego.behaviorLog ?? []);
    if (
      growthNeed.current < growthNeed.ideal * 0.45
      && opportunity.priority >= 75
      && Math.random() < learnProbability
    ) {
      const isEgoInternal = /need (could improve|critically low|is low)|\d+\/\d+$/.test(opportunity.triggerDetail);
      if (!isEgoInternal) {
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
  }

  // help-offer: proactively reach out to offer help (value-driven)
  if (type === "help-offer") {
    return { actionType: "send-message" };
  }

  // opportunity-detected with connection need: only message if there's
  // specific context to share (e.g. learned something relevant)
  if (type === "opportunity-detected" && relatedNeeds.includes("connection")) {
    return { actionType: "send-message" };
  }

  // threat-warning: self-reflect to process the threat
  if (type === "threat-warning" && relatedNeeds.includes("survival")) {
    return { actionType: "self-reflect" };
  }

  // memory-resurface: recall and reflect on memories
  if (type === "memory-resurface" && opportunity.priority >= 80) {
    return { actionType: "recall-memory" };
  }

  if (type === "meaning-quest" || type === "existential-reflection") {
    // These are philosophical/internal topics — almost never need web search.
    // Prefer self-reflection; only search if truly time-sensitive.
    const searchProb = adjustProbability(0.05, "search-web", ego.behaviorLog ?? []);
    const reflectProb = adjustProbability(0.3, "self-reflect", ego.behaviorLog ?? []);
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
  // Extract specific phrases from user's actual words instead of
  // matching against a generic keyword list. The user's original
  // question/statement contains the most search-worthy content.
  const results: string[] = [];

  // 1. Extract quoted strings (user explicitly mentioned these)
  const quoted = text.match(/[""「」『』]([^""「」『』]{3,50})[""「」『』]/g);
  if (quoted) {
    for (const q of quoted.slice(0, 2)) {
      const clean = q.replace(/[""「」『』]/g, "").trim();
      if (clean.length >= 3 && !MEANINGLESS_QUERIES.has(clean.toLowerCase())) {
        results.push(clean);
      }
    }
  }

  // 2. Extract substantive phrases (4+ consecutive meaningful words)
  // Split on punctuation and filler words
  const phrases = text.split(/[，。！？、；：,!?;:\n\r]+/)
    .map((p) => p.trim())
    .filter((p) => {
      const words = p.split(/\s+/).filter((w) => w.length > 0);
      return words.length >= 2 && p.length >= 4 && p.length <= 50;
    });
  for (const phrase of phrases.slice(0, 2)) {
    if (!results.includes(phrase)) {
      results.push(phrase);
    }
  }

  return results.slice(0, 3);
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

/**
 * Extract file paths from text that end with a given extension.
 * Used to find log/source paths from user conversation context.
 */
/** File extensions worth reading for problem analysis. */
const READABLE_EXTENSIONS = [".log", ".ts", ".js", ".py", ".json", ".yaml", ".yml", ".conf", ".toml", ".md", ".txt", ".sh", ".env", ".sql"];

/**
 * Extract file paths from text for any readable extension.
 * Returns deduplicated paths, up to 5 total.
 */
function extractFilePaths(text: string): string[] {
  const results: string[] = [];
  for (const ext of READABLE_EXTENSIONS) {
    // Require at least one path separator to avoid extracting bare filenames
    // (e.g. "ego.json" from log text) that resolve against process.cwd().
    const pattern = new RegExp(`(?:(?:[A-Za-z]:)?/[\^\s:]+|[A-Za-z]:\\\\[\w./-\\\\]+)\\${ext}\\b`, "gi");
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        if (!results.includes(m)) results.push(m);
      }
    }
  }
  return results.slice(0, 5);
}

function normalizeQueryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
    .replace(/\b(?:the|and|for|with|about|this|that|from|into|user|should|would|could|have|has|been)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function queryOverlapsThought(query: string, thoughtContent: string): boolean {
  const normalizedQuery = normalizeQueryText(query);
  const normalizedThought = normalizeQueryText(thoughtContent);
  if (!normalizedQuery || !normalizedThought) return false;
  if (normalizedThought.includes(normalizedQuery) || normalizedQuery.includes(normalizedThought)) return true;

  const queryTerms = normalizedQuery.split(/\s+/).filter((term) => term.length >= 3);
  if (queryTerms.length === 0) return normalizedQuery.length >= 2 && normalizedThought.includes(normalizedQuery);
  const overlappingTerms = queryTerms.filter((term) => normalizedThought.includes(term));
  return overlappingTerms.length / queryTerms.length >= 0.35;
}

function deriveSearchQueryFromThought(thoughtContent: string): string {
  const cleaned = thoughtContent
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\b(?:I should|I need to|I want to|I will|Given our previous discussion about|Regarding our past discussion on)\b/gi, "")
    .replace(/[。？！.!?].*$/s, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 58).trim();
}

async function expandThoughtActionWithAdjacentIdea(
  thought: Thought,
  opportunity: DetectedThoughtOpportunity,
  ctx: ThoughtGenerationContext,
  llmGenerator: LLMThoughtGenerator,
): Promise<void> {
  const actionType = thought.actionType;
  if (!actionType || actionType === "none") return;

  const expandableActions: ActionType[] = [
    "learn-topic",
    "search-web",
    "proactive-research",
    "proactive-content-push",
  ];
  if (!expandableActions.includes(actionType)) return;

  const recentUserMessages = currentConversationMemories(ctx.ego)
    .filter((memory) => memory.tags.includes("inbound"))
    .map((memory) => memory.content)
    .slice(-5);
  const recentAvoidItems = ctx.ego.memories
    .filter((m) =>
      (m.type === "interaction" && m.tags.includes("outbound")) ||
      (m.type === "learning" && (m.tags.includes("proactive-content-push") || m.tags.includes("proactive-research"))),
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 6)
    .map((m) => m.content);
  const topicFocus = buildTopicFocusProfile(ctx.ego);
  const personalityPrefs = `${topicFocus.summary || ""}\n${describePersonalityProfile(ctx.ego)}`.trim();

  const isSearchAction = actionType === "search-web";
  const sourceText = isSearchAction
    ? [
      `Final thought intent: ${thought.content}`,
      "Generate the query from the final thought intent only. Ignore any older replay/search wording that may appear elsewhere.",
    ].join("\n")
    : [
      `Thought: ${thought.content}`,
      `Trigger: ${opportunity.triggerDetail}`,
      `Motivation: ${opportunity.motivation}`,
      thought.actionParams ? `Action params: ${JSON.stringify(thought.actionParams).slice(0, 500)}` : "",
    ].filter(Boolean).join("\n");

  const ideas = await generateAdjacentContentIdeas({
    llmGenerator,
    actionType,
    sourceLabel: isSearchAction ? "Final thought before search execution" : "Selected thought before action execution",
    sourceText,
    preferences: personalityPrefs || undefined,
    recentUserMessages,
    recentAvoidItems: [...recentAvoidItems, ...topicFocus.deprioritized.map((topic) => `deprioritized topic: ${topic}`)],
    requireSearchQuery: actionType === "search-web" || actionType === "proactive-research" || actionType === "proactive-content-push",
  });
  const selected = ideas[0];
  if (!selected) {
    if (actionType === "search-web") {
      const existingQuery = typeof thought.actionParams?.query === "string" ? thought.actionParams.query : "";
      if (existingQuery && !queryOverlapsThought(existingQuery, thought.content)) {
        const derivedQuery = deriveSearchQueryFromThought(thought.content);
        if (derivedQuery) {
          log.info(`Replacing stale search query "${existingQuery.slice(0, 60)}" with thought-derived query "${derivedQuery}"`);
          thought.actionParams = {
            ...(thought.actionParams ?? {}),
            query: derivedQuery,
            derivedFromThought: true,
          };
        }
      }
    }
    return;
  }

  log.info(`Adjacent thought expansion for ${actionType}: ${selected.topic} (bridge: ${selected.bridge})`);

  if (actionType === "learn-topic") {
    const expandedTopics = ideas
      .map((idea) => idea.topic)
      .filter((topic) => topic.length >= 3)
      .slice(0, 3);
    if (expandedTopics.length > 0) {
      const existingReason = typeof thought.actionParams?.reason === "string"
        ? thought.actionParams.reason
        : thought.motivation;
      thought.actionParams = {
        ...(thought.actionParams ?? {}),
        topics: expandedTopics,
        reason: `${existingReason}; adjacent expansion: ${selected.bridge}`,
        adjacentBridge: selected.bridge,
      };
    }
    return;
  }

  if (actionType === "search-web" && selected.query) {
    thought.actionParams = {
      ...(thought.actionParams ?? {}),
      query: selected.query,
      adjacentTopic: selected.topic,
      adjacentBridge: selected.bridge,
    };
    return;
  }

  if (actionType === "proactive-content-push") {
    const currentInterests = typeof thought.actionParams?.interests === "string"
      ? thought.actionParams.interests
      : opportunity.motivation;
    thought.actionParams = {
      ...(thought.actionParams ?? {}),
      interests: `${currentInterests}\nAdjacent seed: ${selected.topic}\nBridge: ${selected.bridge}`,
      adjacentTopic: selected.topic,
      adjacentBridge: selected.bridge,
    };
    return;
  }

  thought.actionParams = {
    ...(thought.actionParams ?? {}),
    adjacentTopic: selected.topic,
    adjacentBridge: selected.bridge,
    adjacentWhy: selected.why,
    ...(selected.query ? { adjacentQuery: selected.query } : {}),
  };
}

export async function generateIntelligentThought(
  ctx: ThoughtGenerationContext,
  options?: IntelligentThoughtOptions,
): Promise<Thought> {
  const { llmGenerator, preferOpportunity, expandActionIdeas = false } = options ?? {};

  const opportunities = detectThoughtOpportunities(ctx);

  if (opportunities.length === 0) {
    // No opportunities — caller should handle this (skip or back off).
    // Return a minimal thought so callers that don't check length get a usable object.
    const fallback: Thought = {
      id: randomBytes(8).toString("hex"),
      type: "existential-reflection",
      content: "idle",
      trigger: "curiosity",
      source: "scheduled",
      triggerDetail: "No urgent needs",
      motivation: "Idle",
      targetMetrics: [],
      priority: 5,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
      executed: false,
      relatedNeeds: [],
    };
    return fallback;
  }

  // Debug: log top opportunities for diagnosing routing issues
  if (opportunities.length > 0) {
    const topN = opportunities.slice(0, 5).map((o) =>
      `${o.type}(P=${o.priority},action=${o.suggestedAction ?? "auto"})`,
    ).join(", ");
    log.info(`Top opportunities: ${topN}`);
  }

  const selectedOpportunity = preferOpportunity || opportunities[0];

  // Let every detected opportunity use the same model path. Priority decides
  // which stimulus is considered first; it must not reduce thought quality.
  if (llmGenerator) {
    try {
      const prompt = await generateLLMThoughtPrompt(selectedOpportunity, ctx);
      const llmContent = await llmGenerator(prompt);
      const refinedContent = llmContent
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<think>[\s\S]*?$/gi, "")
        .replace(/<\/think>[\s\S]*?$/gi, "")
        .trim();

      const thought = buildThoughtFromOpportunity(selectedOpportunity, ctx.ego);
      thought.content = refinedContent;

      // LLM content may indicate a specific intent to investigate or fix a problem.
      // Only override to analyze-problem when the LLM explicitly describes a concrete
      // problem to investigate — not just because common words like "观察" or "检查"
      // appear in the text.
      // EXCEPTION: don't override explicit suggestedActions that are deliberate
      // proactive actions (observe-and-improve, proactive-research, proactive-content-push).
      const strongProblemIndicators = /排查.*问题|分析.*错误|修复.*bug|debug|fix.*issue|diagnos|investigate.*error|read.*log.*file|检查.*日志|读取.*文件.*错误/i;
      const protectedActions = new Set(["send-message", "observe-and-improve", "subagent-improve", "run-agent-task", "invoke-tool", "analyze-problem", "proactive-research", "proactive-content-push"]);
      const isProtectedAction = protectedActions.has(selectedOpportunity.suggestedAction ?? "");
      if (!isProtectedAction &&
          strongProblemIndicators.test(refinedContent) &&
          (selectedOpportunity.type === "opportunity-detected" ||
           selectedOpportunity.type === "conversation-replay" ||
           selectedOpportunity.type === "skill-gap")) {
        thought.actionType = "analyze-problem";
        thought.actionParams = {
          reason: refinedContent.slice(0, 200),
          logPaths: extractFilePaths(refinedContent + " " + selectedOpportunity.triggerDetail),
          sourcePaths: [],
        };
      } else if (!isProtectedAction && (
        selectedOpportunity.type === "skill-gap" ||
        selectedOpportunity.type === "opportunity-detected"
      )) {
        const topics = extractLearningTopics(
          refinedContent + " " + selectedOpportunity.triggerDetail,
        );
        if (topics.length > 0) {
          thought.actionType = "learn-topic";
          thought.actionParams = { topics, reason: "LLM suggested learning" };
        }
      }

      suppressOrRerouteLowValueMessageThought(thought, selectedOpportunity, ctx);
      if (expandActionIdeas) {
        await expandThoughtActionWithAdjacentIdea(thought, selectedOpportunity, ctx, llmGenerator);
      }
      return thought;
    } catch (err) {
      // A configured model that is unavailable or out of its thought budget
      // must not silently collapse into generic rule templates. The caller
      // records the failed cycle and backs off while action/critical lanes stay
      // available.
      throw err;
    }
  }

  const thought = buildThoughtFromOpportunity(selectedOpportunity, ctx.ego);
  suppressOrRerouteLowValueMessageThought(thought, selectedOpportunity, ctx);
  if (llmGenerator && expandActionIdeas) {
    await expandThoughtActionWithAdjacentIdea(thought, selectedOpportunity, ctx, llmGenerator);
  }
  return thought;
}

async function generateLLMThoughtPrompt(
  opportunity: DetectedThoughtOpportunity,
  ctx: ThoughtGenerationContext,
): Promise<string> {
  const { ego } = ctx;

  const needsList = opportunity.relatedNeeds
    .map((key) => {
      const need = ego.needs[key as keyof EgoNeeds];
      return need ? `${need.name}: ${need.current.toFixed(0)}/${need.ideal}` : key;
    })
    .join(", ");

  const activeFacts = ego.userFacts
    .filter((fact) => fact.validity !== "superseded")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const userFactsSummary = activeFacts.length > 0
    ? activeFacts.slice(0, 8).map((f) => `[CURRENT ${f.category}] ${f.content}`).join("\n")
    : "none yet";

  // Inject user preferences so the LLM can align thoughts to user style
  const activePrefs = (ego.userPreferences ?? [])
    .filter((p) => p.confidence >= 0.4)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);
  const userPrefsSummary = activePrefs.length > 0
    ? activePrefs.map((p) => `- ${p.aspect}: ${p.preference}`).join("\n")
    : "none yet";

  // Include actual conversation content for conversation-replay thoughts
  const recentInteractions = currentConversationMemories(ego, 5)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 5);
  const conversationContext = recentInteractions.length > 0
    ? recentInteractions.map((m) => `[${new Date(m.timestamp).toISOString().slice(11, 16)}] ${m.content.slice(0, 100)}`).join("\n")
    : "no recent conversations";

  const recentLearnings = ego.memories
    .filter(isGroundedLearning)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 3);
  const learningContext = recentLearnings.length > 0
    ? recentLearnings.map((m) => `- ${m.content.slice(0, 80)}`).join("\n")
    : "no recent learnings";
  const mentalContext = [
    `Foreground: ${ego.mentalContext.foreground.join("; ") || "quiet"}`,
    `Residue: ${ego.mentalContext.residue.join("; ") || "none"}`,
    `Background concerns: ${ego.mentalContext.backgroundConcerns.join("; ") || "none"}`,
    `Environmental changes: ${ego.mentalContext.environmentalChanges.join("; ") || "none"}`,
  ].join("\n");

  // Search external memory plugins for relevant context
  const memoryQuery = `${opportunity.triggerDetail} ${opportunity.motivation}`;
  const externalResults = await searchExternalMemories(memoryQuery, 3);
  const memorySection = formatMemoryContext(externalResults);

  return `A thought may be forming from a lingering stimulus and recent experience.

Lingering stimulus:
${opportunity.triggerDetail}

Stable context about the person:
${userFactsSummary}

User preferences (align your tone and approach to these):
${userPrefsSummary}

Recent conversation:
${conversationContext}

Current mental context:
${mentalContext}

Grounded things learned recently:
${learningContext}

${memorySection ? `\n${memorySection}\n` : ""}
Develop the thought that genuinely arises from this context. It may be a
question, analysis, tension, correction of an earlier interpretation,
connection between details, proposed answer, or any other natural response.
Give it the same depth and completeness you would use in the main conversation.
There is no sentence, word, or character limit. Prefer uncertainty over
pretending to know the person's personality.
CURRENT facts override older conversations and retrieved memories. Never infer
that a resolved condition is still broken unless newer direct user/tool evidence
explicitly reopens it. Old failures are historical context, not current evidence.
Usually continue the foreground or a genuine residue. Only rarely bridge to a
distant background concern. Do not force an old phrase into an unrelated topic.

Write the complete thought naturally in the language of the most recent
conversation. Return the thought itself without discussing these instructions.`;
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
      const prompt = await generateProactiveMessagePromptLLM(topOpportunity, ego);
      return await llmGenerator(prompt);
    } catch (err) {
      log.warn("LLM proactive message generation failed", { error: String(err) });
    }
  }

  const thought = buildThoughtFromOpportunity(topOpportunity, ego);
  return thought.content;
}

async function generateProactiveMessagePromptLLM(
  opportunity: DetectedThoughtOpportunity,
  ego: EgoState,
): Promise<string> {
  const userFacts = activeUserFacts(ego).slice(0, 5);
  const userInfo =
    userFacts.length > 0
      ? `What I know about the user: ${userFacts.map((f) => f.content).join("; ")}`
      : "I don't know much about the user yet";

  // Include user preferences so proactive messages align to user style
  const activePrefs = (ego.userPreferences ?? [])
    .filter((p) => p.confidence >= 0.4)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
  const prefsInfo = activePrefs.length > 0
    ? `User preferences: ${activePrefs.map((p) => `${p.aspect}=${p.preference}`).join("; ")}`
    : "";

  // Search external memory plugins for relevant context
  const memoryQuery = `${opportunity.triggerDetail} ${opportunity.motivation}`;
  const externalResults = await searchExternalMemories(memoryQuery, 3);
  const memorySection = formatMemoryContext(externalResults);

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
${prefsInfo ? `**${prefsInfo}**` : ""}

${memorySection ? `\n${memorySection}\n` : ""}
Reach out to the user with enough detail to be useful. Requirements:
1. Have specific content — ask, share, or offer help
2. Based on your current inner state and user information
3. Natural and friendly, not too eager
4. Don't make empty remarks like "I miss you"
5. Use whatever length and structure the content warrants; do not impose an output-length limit

Output what you want to say directly, no explanation.`;
}
