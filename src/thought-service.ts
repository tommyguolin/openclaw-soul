import { randomBytes } from "node:crypto";
import { createSoulLogger } from "./logger.js";
import {
  executeThoughtAction,
  flushPendingShareMessage,
  getActionCooldownState,
  isGoodTimeForMessage,
} from "./action-executor.js";
import type { ActionExecutorOptions } from "./action-executor.js";
import type { SubAgentRunner } from "./autonomous-actions.js";
import { expirePending } from "./behavior-log.js";
import type { MessageSender } from "./soul-actions.js";
import {
  shouldProgressAwakening,
  progressAwakening,
  createAwakeningThought,
  isAwakeningComplete,
  getAwakeningMessage,
} from "./awakening.js";
import { loadEgoStore, updateEgoStore, resolveEgoStorePath } from "./ego-store.js";
import {
  generateIntelligentThought,
  detectThoughtOpportunities,
  detectMaintenanceOpportunities,
  buildThoughtFromOpportunity,
  getActionForOpportunity,
  hasUnresolvedLocalEvidenceMissingResult,
  isExecutionFocusedOpportunity,
  isLocalProjectEvidenceQuestion,
  buildMaintenanceBacklog,
  type DetectedThoughtOpportunity,
} from "./intelligent-thought.js";
import { loadWorkspaceContext } from "./paths.js";
import { pollActiveTasks as pollAutonomousTasks } from "./autonomous-actions.js";
import { buildSoulSystemPrompt } from "./prompts.js";
import {
  recallMemories,
  computeCurrentEmotion,
  computeEmotionalNudge,
} from "./memory-retrieval.js";
import {
  analyzeSentiment,
  calculateEgoImpact,
  logSentimentAnalysis,
} from "./sentiment-analysis.js";
import type { SentimentResult } from "./sentiment-analysis.js";
import { createSoulLLMGenerator, type LLMGenerator, type SoulLLMConfig } from "./soul-llm.js";
import { shouldGenerateThought, decayMetrics } from "./thought.js";
import { runExpiryCycle } from "./expiry.js";
import { updateRelationshipProfile } from "./relationship-profile.js";
import type {
  EgoState,
  Thought,
  SoulActionResult,
  MetricDelta,
  EgoNeeds,
  UserFact,
  UserPreference,
  SoulMemory,
  InteractionSemanticSignal,
  ActionType,
  ThoughtGenerationContext,
} from "./types.js";
import type { OpenClawSearchCompat } from "./soul-search.js";
import { isLLMErrorContent } from "./llm-errors.js";
import {
  ThoughtCycleJournal,
  compactJournalOpportunity,
  compactJournalThought,
  resolveThoughtJournalPath,
  type ThoughtCycleOutcome,
} from "./thought-journal.js";
import { ThoughtPool, inferEpistemicNature, resolveThoughtPoolPath, resolveThoughtPoolV31ShadowPath } from "./thought-pool.js";
import {
  buildSpontaneousPrompt,
  classifyCognitiveMove,
  classifyThoughtQualityFlags,
  parseSpontaneousResponse,
  contentTokens,
  jaccard,
  memoryTopicClusters,
  selectRemoteMemoryPair,
  selectContextualMemoryPair,
} from "./thought-emergence.js";
import { ActivationStore, resolveActivationStatePath } from "./cognition/activation-store.js";
import { CognitiveJournal, resolveCognitiveJournalPath } from "./cognition/cognitive-journal.js";
import { CognitionRunner } from "./cognition/runner.js";
import type { CognitionMode, CognitiveTemperament } from "./cognition/types.js";
import { temperamentActivationConfig } from "./cognition/associative-expansion.js";
import { inferCognitiveKind } from "./cognition/kind.js";
import { emergeFromWorkspace } from "./cognition/emergence.js";
import { IntentionStore, resolveIntentionStorePath } from "./intention/store.js";
import { buildUserDirectiveIntention, isExplicitUserDirective } from "./intention/formation.js";
import { WorkHandoffStore, isUsableWorkHandoff, resolveWorkHandoffStorePath } from "./handoff/store.js";
import { ExpressionStore, resolveExpressionStorePath } from "./expression/store.js";
import {
  ExpressionFeedbackStore, resolveExpressionFeedbackPath,
  type ExpressionPolicyMode,
} from "./expression/feedback-store.js";
import { ThoughtEpisodeStore, resolveThoughtEpisodeStorePath } from "./cognition/thought-store.js";
import { buildUserLanguageInstruction, supportsLocalMessageTemplate } from "./language-context.js";
import { buildGoalSystemSummary, recomputeGoalState } from "./goal-system.js";

const log = createSoulLogger("thought-service");
type LLMBudgetLane = "critical" | "action" | "thought" | "shadow";
const ACTIVE_CONVERSATION_QUIET_MS = 2 * 60 * 1000;

function isExplicitResolution(text: string): boolean {
  return /(?:已经|早已|昨天.*(?:连上|成功)|连接成功|可以访问|能够访问|已解决|修复好了|不再有问题|authenticated|connected successfully|works now|already (?:works|connected)|resolved|fixed)/i.test(text);
}

function isSshAccessTopic(text: string): boolean {
  return /(?:\bssh\b|免密|公钥|authorized_keys|192\.168\.1\.206|\/diskb\/btc_1)/i.test(text);
}

function resolutionTopicKey(text: string): string {
  if (isSshAccessTopic(text)) return "ssh-access:192.168.1.206";
  return `state:${contentTokens(text).filter((token) => token.length >= 3).slice(0, 6).sort().join(":")}`;
}

function isStatefulFactCategory(category: string): boolean {
  return /(?:status|state|access|connect|availability|deployment|issue|problem|health|运行|状态|访问|连接)/i.test(category);
}

/**
 * Normalize thought content for topic-level dedup: lowercase, drop
 * punctuation/whitespace. Truncated so similarity cost stays bounded.
 */
function normalizeForTopic(content: string): string {
  return content
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 120);
}

const TOPIC_STOP_WORDS = new Set([
  "the", "and", "for", "with", "about", "that", "this", "from", "into", "user", "should", "would",
  "could", "have", "been", "need", "want", "think", "thinking", "discussion", "previous", "regarding",
  "关于", "用户", "应该", "需要", "可以", "之前", "讨论", "这个", "那个",
]);

const ANGLE_TERMS = [
  "qualia", "hard problem", "functionalism", "self-model", "self model", "world model",
  "theory of mind", "embodied cognition", "personhood", "digital rights", "ethics",
  "memory", "architecture", "interpretability", "emergent", "意识", "自我模型", "心智理论",
  "具身", "人格", "伦理", "记忆", "架构", "涌现", "可解释",
];

function topicTerms(content: string): string[] {
  return content
    .toLowerCase()
    .split(/[^\p{L}\p{N}\u4e00-\u9fff]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !TOPIC_STOP_WORDS.has(term))
    .slice(0, 10);
}

function extractAngleTerms(content: string): string[] {
  const lower = content.toLowerCase();
  return ANGLE_TERMS.filter((term) => lower.includes(term.toLowerCase())).slice(0, 5);
}

function topicSignature(content: string): string {
  const terms = topicTerms(content).slice(0, 8).join(",");
  const angles = extractAngleTerms(content).join(",");
  return `terms=${terms}|angles=${angles}|raw=${normalizeForTopic(content)}`;
}

function parseTopicSignature(value: string): { terms: Set<string>; angles: Set<string>; raw: string } {
  if (!value.includes("terms=") || !value.includes("|raw=")) {
    return { terms: new Set(), angles: new Set(), raw: value };
  }
  const terms = value.match(/terms=([^|]*)/)?.[1] ?? "";
  const angles = value.match(/angles=([^|]*)/)?.[1] ?? "";
  const raw = value.match(/raw=([^|]*)/)?.[1] ?? "";
  return {
    terms: new Set(terms.split(",").filter(Boolean)),
    angles: new Set(angles.split(",").filter(Boolean)),
    raw,
  };
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const item of a) {
    if (b.has(item)) overlap++;
  }
  return overlap / Math.min(a.size, b.size);
}

/** Return the set of overlapping 2-character windows in `text`. */
function charBigrams(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length < 2) return out;
  // Iterate by code point so CJK / surrogate pairs are handled correctly.
  const chars = Array.from(text);
  for (let i = 0; i < chars.length - 1; i++) {
    out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

/**
 * English technical keywords for interaction tagging.
 * Matched with word boundaries to avoid false positives like "ai" in "main"
 * or "ml" in "html". Keys are lowercased; values are the canonical tag.
 */
const EN_TECH_KEYWORDS: Record<string, string> = {
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  react: "react",
  vue: "vue",
  node: "nodejs",
  docker: "docker",
  kubernetes: "kubernetes",
  k8s: "kubernetes",
  aws: "aws",
  gcp: "gcp",
  azure: "azure",
  linux: "linux",
  macos: "macos",
  windows: "windows",
  database: "database",
  redis: "redis",
  postgres: "postgres",
  mysql: "mysql",
  mongodb: "mongodb",
  api: "api",
  rest: "rest-api",
  graphql: "graphql",
  ai: "ai",
  ml: "machine-learning",
  "machine learning": "machine-learning",
  "deep learning": "deep-learning",
  llm: "llm",
  gpt: "gpt",
  claude: "claude",
  openai: "openai",
  error: "error-handling",
  bug: "bug",
  debug: "debugging",
  test: "testing",
  deploy: "deployment",
  "ci/cd": "ci-cd",
  security: "security",
  performance: "performance",
  architecture: "architecture",
  design: "design",
  product: "product",
  project: "project-management",
};

/** Precomputed boundary-aware regex for each English keyword. */
const EN_TECH_PATTERNS: Array<[RegExp, string]> = Object.entries(EN_TECH_KEYWORDS).map(
  ([keyword, tag]) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [new RegExp(`\\b${escaped}\\b`), tag];
  },
);

/**
 * Chinese technical keywords. Substring match is correct here — Chinese
 * has no word boundaries and shorter keywords aren't false-positive-prone
 * the way short Latin tokens are.
 */
const CN_TECH_KEYWORDS: Record<string, string> = {
  人工智能: "ai",
  机器学习: "machine-learning",
  深度学习: "deep-learning",
  编程: "programming",
  开发: "development",
  算法: "algorithm",
  数据库: "database",
  服务器: "server",
  前端: "frontend",
  后端: "backend",
  全栈: "fullstack",
  运维: "devops",
  测试: "testing",
  部署: "deployment",
  架构: "architecture",
  设计: "design",
  产品: "product",
  项目: "project-management",
  错误: "error-handling",
  问题: "problem",
  优化: "optimization",
  安全: "security",
};

export type ThoughtHandler = (thought: Thought, ego: EgoState) => Promise<SoulActionResult>;

export type ThoughtServiceOptions = {
  storePath?: string;
  checkIntervalMs?: number;
  onThought?: ThoughtHandler;
  onMetricsUpdate?: (ego: EgoState) => void;
  llmConfig?: SoulLLMConfig;
  proactiveChannel?: string;
  proactiveTarget?: string;
  sendMessage?: MessageSender;
  /** OpenClaw config for auto-discovering search keys etc. */
  openclawConfig?: OpenClawSearchCompat;
  /** Allow autonomous write operations (edit files, run commands). Default: false */
  autonomousActions?: boolean;
  /** Gateway port for tool invocation */
  gatewayPort?: number;
  /** Gateway auth token for /tools/invoke */
  authToken?: string;
  /** Hooks token for /hooks/agent */
  hooksToken?: string;
  /** Workspace context loaded from files (SOUL.md, AGENTS.md, etc.) */
  workspaceContext?: string;
  /** File names to load from state directory */
  workspaceFiles?: string[];
  /** Thought frequency multiplier. Default: 1.0. Lower = more frequent. */
  thoughtFrequency?: number;
  /** Probability of private shadow emergence when the shadow interval elapses. Default: 0.1. */
  shadowThoughtRate?: number;
  /** Cognitive activation path. Default: legacy. */
  cognitionMode?: CognitionMode;
  cognitiveTemperament?: CognitiveTemperament;
  /** Expression feedback policy. Disabled by default and independent of cognition. */
  expressionPolicy?: ExpressionPolicyMode;
  /** Subagent runner for autonomous task delegation (full tool chain) */
  subAgentRunner?: SubAgentRunner;
};

export class ThoughtService {
  private storePath: string;
  private checkIntervalMs: number;
  private onThought?: ThoughtHandler;
  private onMetricsUpdate?: (ego: EgoState) => void;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastDecayTime = Date.now();
  private lastExpiryTime = 0;
  private llmGenerator?: LLMGenerator;
  private actionLLMGenerator?: LLMGenerator;
  private thoughtLLMGenerator?: LLMGenerator;
  private shadowLLMGenerator?: LLMGenerator;
  private sendMessage?: MessageSender;
  private proactiveChannel?: string;
  private proactiveTarget?: string;
  private openclawConfig?: OpenClawSearchCompat;
  private autonomousActions: boolean;
  private gatewayPort: number;
  private authToken?: string;
  private hooksToken?: string;
  private subAgentRunner?: SubAgentRunner;
  private workspaceContext: string;
  private workspaceFiles: string[];
  private thoughtFrequency: number;
  private lastWorkspaceRefresh = 0;
  private recentThoughtTypes: string[] = [];
  private recentThoughtTopics: string[] = [];
  private recentCognitiveMoves: string[] = [];
  private recentActionHistory: string[] = [];
  private thoughtJournal: ThoughtCycleJournal;
  private thoughtPool: ThoughtPool;
  private cognitionShadowPool?: ThoughtPool;
  private shadowThoughtRate: number;
  private cognitionMode: CognitionMode;
  private cognitionRunner?: CognitionRunner;
  private intentionStore?: IntentionStore;
  private workHandoffStore?: WorkHandoffStore;
  private expressionStore?: ExpressionStore;
  private expressionFeedbackStore?: ExpressionFeedbackStore;
  private expressionPolicy: ExpressionPolicyMode;
  private thoughtEpisodeStore?: ThoughtEpisodeStore;
  private lastShadowThoughtAt = 0;
  private lastPoolAttentionAt = 0;
  private noProgressActionBackoff: Record<string, { count: number; until: number }> = {};
  private suppressedThoughtOpportunities = new Map<string, number>();
  private consecutiveSkipCount = 0;
  private backoffTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastLLMCallTime = 0;
  private llmBackoffUntil = 0;
  private llmConsecutiveFailures = 0;
  private lastLLMBackoffLog = 0;
  private llmCallTimestamps: Array<{ timestamp: number; lane: LLMBudgetLane }> = [];
  private static readonly DEFAULT_MIN_LLM_INTERVAL_MS = 3_000;
  private static readonly TEST_MIN_LLM_INTERVAL_MS = 1_000;
  private static readonly LLM_BUDGET_WINDOW_MS = 15 * 60 * 1000;
  private thoughtAbortController: AbortController | null = null;
  private thoughtInProgress = false;
  private selfImprovementGoalSynced = false;

  constructor(options: ThoughtServiceOptions = {}) {
    this.storePath = resolveEgoStorePath(options.storePath);
    this.thoughtJournal = new ThoughtCycleJournal(resolveThoughtJournalPath(this.storePath));
    this.thoughtPool = new ThoughtPool(resolveThoughtPoolPath(this.storePath));
    this.checkIntervalMs = options.checkIntervalMs ?? 60 * 1000;
    this.onThought = options.onThought;
    this.onMetricsUpdate = options.onMetricsUpdate;
    this.sendMessage = options.sendMessage
      ? async (params) => {
          await options.sendMessage!(params);
          if (params.content.trim().length >= 5) {
            await this.recordInteractionWithText({
              type: "outbound",
              text: params.content.trim(),
              channel: params.channel ?? this.proactiveChannel,
            });
          } else {
            await this.recordInteraction({ type: "outbound" });
          }
        }
      : undefined;
    this.proactiveChannel = options.proactiveChannel;
    this.proactiveTarget = options.proactiveTarget;
    this.openclawConfig = options.openclawConfig;
    this.autonomousActions = options.autonomousActions ?? false;
    this.gatewayPort = options.gatewayPort ?? 18789;
    this.authToken = options.authToken;
    this.hooksToken = options.hooksToken;
    this.subAgentRunner = options.subAgentRunner;
    this.workspaceContext = options.workspaceContext ?? "";
    this.workspaceFiles = options.workspaceFiles ?? ["SOUL.md", "AGENTS.md", "MEMORY.md", "USER.md"];
    this.thoughtFrequency = Math.max(0.1, Math.min(5, options.thoughtFrequency ?? 1.0));
    this.shadowThoughtRate = Math.max(0, Math.min(1, options.shadowThoughtRate ?? 0.1));
    this.cognitionMode = options.cognitionMode === "observe" || options.cognitionMode === "shadow" || options.cognitionMode === "primary"
      ? options.cognitionMode : "legacy";
    this.expressionPolicy = options.expressionPolicy === "observe" || options.expressionPolicy === "adaptive"
      ? options.expressionPolicy : "legacy";
    if (options.cognitionMode && !["legacy", "observe", "shadow", "primary"].includes(options.cognitionMode)) {
      log.warn(`Cognition mode ${options.cognitionMode} is not implemented; falling back to legacy`);
    }
    if (this.cognitionMode !== "legacy") {
      this.cognitionRunner = new CognitionRunner({
        store: new ActivationStore(resolveActivationStatePath(this.storePath)),
        journal: new CognitiveJournal(resolveCognitiveJournalPath(this.storePath)),
        config: temperamentActivationConfig(options.cognitiveTemperament ?? "balanced"),
      });
      if (this.cognitionMode === "shadow") {
        this.cognitionShadowPool = new ThoughtPool(resolveThoughtPoolV31ShadowPath(this.storePath));
      }
      if (this.cognitionMode === "primary") {
        this.intentionStore = new IntentionStore(resolveIntentionStorePath(this.storePath));
        this.workHandoffStore = new WorkHandoffStore(resolveWorkHandoffStorePath(this.storePath));
        this.expressionStore = new ExpressionStore(resolveExpressionStorePath(this.storePath));
        this.thoughtEpisodeStore = new ThoughtEpisodeStore(resolveThoughtEpisodeStorePath(this.storePath));
        if (this.expressionPolicy !== "legacy") {
          this.expressionFeedbackStore = new ExpressionFeedbackStore(
            resolveExpressionFeedbackPath(this.storePath), this.expressionPolicy,
          );
          log.info(`Expression feedback policy enabled: ${this.expressionPolicy}`);
        }
      }
      log.info(this.cognitionMode === "primary"
        ? "Cognition Primary enabled for private thoughts; operational opportunities and all safety gates remain active"
        : this.cognitionMode === "shadow"
          ? "Cognition Workspace Shadow enabled (private LLM journal only; no action, message, or real Thought Pool writes)"
        : "Cognition Activation Observer enabled (no LLM, action, message, or Thought Pool writes)");
      log.info(`Cognitive temperament: ${options.cognitiveTemperament ?? "balanced"} (context-adaptive associative expansion)`);
    }
    if (this.expressionPolicy !== "legacy" && this.cognitionMode !== "primary") {
      log.warn(`Expression policy ${this.expressionPolicy} requires cognitionMode=primary; falling back to legacy`);
      this.expressionPolicy = "legacy";
    }
    if (this.thoughtFrequency !== 1.0) {
      log.info(`Thought frequency: ${this.thoughtFrequency}x (all intervals ×${this.thoughtFrequency})`);
    }

    // Initialize LLM generator from config
    if (options.llmConfig) {
      createSoulLLMGenerator(options.llmConfig, options.openclawConfig as Parameters<typeof createSoulLLMGenerator>[1])
        .then((gen) => {
          if (gen) {
            this.llmGenerator = this.wrapLLMGenerator(gen, "critical");
            this.actionLLMGenerator = this.wrapLLMGenerator(gen, "action");
            this.thoughtLLMGenerator = this.wrapLLMGenerator(gen, "thought");
            this.shadowLLMGenerator = this.wrapLLMGenerator(gen, "shadow");
            log.info("Soul LLM generator initialized");
          } else {
            log.debug("No LLM generator — will use rule-based thought generation");
          }
        })
        .catch((err) => {
          log.warn(`Failed to initialize soul LLM generator: ${String(err)}`);
          log.debug("No LLM generator — will use rule-based thought generation");
        });
    }
  }

  /** Update proactive channel/target (called when auto-learned from message_received hook). */
  updateProactiveTarget(channel: string, target: string): void {
    if (!this.proactiveChannel && channel) {
      this.proactiveChannel = channel;
      log.info(`ThoughtService: proactive channel updated to ${channel}`);
    }
    if (!this.proactiveTarget && target) {
      this.proactiveTarget = target;
      log.info(`ThoughtService: proactive target updated to ${target}`);
    }
  }

  getProactiveEndpoint(): { channel?: string; target?: string } {
    return {
      channel: this.proactiveChannel,
      target: this.proactiveTarget,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn("Thought service already running");
      return;
    }

    // Wait for gateway to fully initialize before starting thought cycles
    // The gateway HTTP endpoints (/v1/chat/completions, /hooks/agent) may not
    // be ready immediately on startup. A short delay avoids transient fetch errors.
    await new Promise((r) => setTimeout(r, 5000));

    const store = await loadEgoStore(this.storePath);
    let ego = await this.removeInternalModelInteractions(store.ego);
    ego = await this.reconcileResolvedOperationalState(ego);
    await this.restoreDiversityState(ego);
    await this.initializeThoughtPool(ego);

    if (isAwakeningComplete(ego)) {
      const needsSummary = Object.entries(ego.needs)
        .map(([, n]) => `${n.name}:${n.current.toFixed(0)}`)
        .join(" ");
      log.info(
        `Soul awakened: ${needsSummary} goals:${ego.goals.length} fears:${ego.fears.length}`,
      );
    } else {
      log.info(
        `Soul awakening: stage=${ego.awakeningStage} thoughts=${ego.awakeningThoughts.length}`,
      );
    }

    this.running = true;

    // Send startup greeting to let the user know Soul is alive
    await this.sendStartupGreeting(ego);

    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);

    void this.tick();
  }

  private async initializeThoughtPool(ego?: EgoState): Promise<void> {
    try {
      if (ego) {
        const grounded = new Map(ego.memories
          .filter((memory) => (memory.type === "interaction" && memory.tags.includes("inbound"))
            || (memory.type === "learning" && ["web", "user", "tool"].includes(memory.evidenceKind ?? "")))
          .map((memory) => [memory.id, memory.content] as const));
        const revalidated = await this.thoughtPool.revalidateEvidence(grounded);
        if (revalidated > 0) log.info(`Thought Pool v3 evidence revalidation reset ${revalidated} legacy candidate(s)`);
      }
      let pool = await this.thoughtPool.initialize();
      if (ego && hasUnresolvedLocalEvidenceMissingResult(ego)) {
        const faded = await this.thoughtPool.fadeMatchingCandidates(
          /回测|收益|回撤|最大回撤|手续费|滑点|实盘|日志|策略|参数|\b(?:OOS|CAGR|MaxDD|drawdown|backtest|eth_live|pnl|slippage|fee)\b|\/diskb\/btc_1/i,
        );
        if (faded.length > 0) {
          log.info(`Faded ${faded.length} local-evidence private candidate(s) while evidence target is unresolved`);
          pool = await this.thoughtPool.load();
        }
      }
      const fadedLowQuality = await this.thoughtPool.fadeLowQualitySingletons();
      if (fadedLowQuality.length > 0) {
        log.info(`Faded ${fadedLowQuality.length} low-quality private singleton candidate(s)`);
        pool = await this.thoughtPool.load();
      }
      this.recentCognitiveMoves = pool.candidates
        .filter((candidate) => candidate.state !== "faded")
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(-3)
        .map((candidate) => candidate.cognitiveMove);
      const intervalMs = this.privateStimulusIntervalMs();
      const now = Date.now();
      for (const candidate of pool.candidates) {
        const until = candidate.lastActivatedAt + intervalMs;
        if (until <= now) continue;
        for (const stimulusKey of candidate.stimulusKeys) {
          this.suppressedThoughtOpportunities.set(`stimulus:${stimulusKey}`, until);
        }
      }
      log.info(
        `Thought Pool initialized: version=${pool.version}, candidates=${pool.candidates.length}, ` +
        `attended=${pool.metrics.stateCounts.attended}, incubating=${pool.metrics.stateCounts.incubating}`,
      );
    } catch (err) {
      log.warn(`Failed to initialize Thought Pool: ${String(err)}`);
    }
  }

  private async reconcileResolvedOperationalState(ego: EgoState): Promise<EgoState> {
    const staleSshFailure = ego.userFacts.some((fact) =>
      fact.category === "ssh-access" && /(?:unable|cannot|can't|failed|failing|连不上|无法连接)/i.test(fact.content));
    const currentSshSuccess = ego.userFacts.some((fact) =>
      fact.category === "ssh-access" && fact.validity !== "superseded" && /(?:working|success|connected|可访问|已连接|成功)/i.test(fact.content));
    const successMemory = [...ego.memories]
      .filter((memory) => isSshAccessTopic(memory.content) && isExplicitResolution(memory.content))
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!successMemory && !currentSshSuccess) return ego;

    const resolutionText = successMemory?.content
      ?? "SSH key access to 192.168.1.206 is confirmed working; the remote /diskb/btc_1 logs have been accessed successfully.";
    await this.thoughtPool.registerResolution({
      topicKey: "ssh-access:192.168.1.206",
      resolutionText,
      evidenceMemoryIds: successMemory ? [successMemory.id] : [],
      resolvedAt: successMemory?.timestamp ?? Date.now(),
    });
    const faded = await this.thoughtPool.fadeRelatedCandidates(resolutionText);
    const staleSshCandidates = await this.thoughtPool.fadeMatchingCandidates(
      /\bssh\b|免密|公钥|authorized_keys|PermitRootLogin|publickey|192\.168\.1\.206|\/diskb\/btc_1/i,
    );
    const fadedCount = new Set([...faded, ...staleSshCandidates].map((candidate) => candidate.id)).size;
    if (!staleSshFailure) {
      if (fadedCount > 0) log.info(`Protected resolved SSH state; faded ${fadedCount} recurring candidate(s)`);
      return ego;
    }

    const now = Date.now();
    const updated = await updateEgoStore(this.storePath, (current) => {
      current.userFacts = current.userFacts.filter((fact) => fact.category !== "ssh-access");
      current.userFacts.push({
        id: randomBytes(8).toString("hex"), category: "ssh-access",
        content: "SSH key access to 192.168.1.206 is confirmed working; the remote /diskb/btc_1 logs have been accessed successfully.",
        confidence: 0.99, source: "interaction", firstMentionedAt: successMemory?.timestamp ?? now,
        updatedAt: now, timesConfirmed: 1,
      });
      return current;
    });
    log.info(`Reconciled stale SSH failure from later success evidence; faded ${fadedCount} related candidate(s)`);
    return updated;
  }

  private async removeInternalModelInteractions(ego: EgoState): Promise<EgoState> {
    const isInternal = (memory: SoulMemory) =>
      memory.type === "interaction"
      && memory.tags.includes("outbound")
      && memory.sourceChannel === "openai"
      && /^agent:[^:]+:openai:[^:]+$/i.test(memory.sourceConversationId ?? "");
    const count = ego.memories.filter(isInternal).length;
    if (count === 0) return ego;
    const updated = await updateEgoStore(this.storePath, (current) => {
      current.memories = current.memories.filter((memory) => !isInternal(memory));
      return current;
    });
    log.info(`Removed ${count} internal model transcript(s) misclassified as outbound interaction`);
    return updated;
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.backoffTimeoutId) {
      clearTimeout(this.backoffTimeoutId);
      this.backoffTimeoutId = null;
    }
    this.running = false;
    log.info("Soul service stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Resume the thought cycle after being paused by consecutive skips.
   * Called when a new user message arrives. Resets skip counter and restarts the interval.
   */
  resume(): void {
    if (!this.running) return;

    // Cancel any pending backoff
    if (this.backoffTimeoutId) {
      clearTimeout(this.backoffTimeoutId);
      this.backoffTimeoutId = null;
    }

    // Always replace the current interval with the normal-frequency one.
    // This matters when Soul was in idle-backoff mode (long interval).
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.consecutiveSkipCount = 0;
    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);
    // Do NOT tick immediately — the agent is processing the user's message
    // right now. Let the regular interval handle the next tick so Soul's
    // LLM calls don't compete with the agent's response.
    log.info(`Thought cycle resumed by user interaction (next tick in ${this.checkIntervalMs / 1000}s)`);
  }

  /**
   * Send a brief greeting on startup so the user immediately sees Soul is active.
   * Only sends if proactive messaging is configured.
   */
  private async sendStartupGreeting(ego: EgoState): Promise<void> {
    if (!this.sendMessage || !this.proactiveChannel || !this.proactiveTarget) {
      log.info("Startup greeting skipped: proactive messaging endpoint is incomplete");
      return;
    }

    // Only greet on first boot or after a long absence. Track the greeting
    // itself so repeated gateway restarts do not spam the user before any
    // interaction has been recorded.
    const startupGreetingMinAbsenceMs = this.thoughtFrequency < 0.5
      ? 30 * 60 * 1000
      : 12 * 60 * 60 * 1000;
    const now = Date.now();
    const lastContactAt = ego.lastInteractionTime ?? ego.lastStartupGreetingAt;
    const lastGreetingAgeMs = ego.lastStartupGreetingAt
      ? now - ego.lastStartupGreetingAt
      : null;
    if (lastGreetingAgeMs !== null && lastGreetingAgeMs < startupGreetingMinAbsenceMs) {
      log.info(
        `Startup greeting skipped: last greeting ${Math.floor(lastGreetingAgeMs / 60_000)}m ago ` +
        `< ${Math.floor(startupGreetingMinAbsenceMs / 60_000)}m`,
      );
      return;
    }

    const hasNoContactHistory = !lastContactAt;
    const contactAgeMs = lastContactAt ? now - lastContactAt : 0;
    const hours = lastContactAt
      ? Math.floor(contactAgeMs / (1000 * 60 * 60))
      : 0;
    if (!hasNoContactHistory && contactAgeMs < startupGreetingMinAbsenceMs) {
      log.info(
        `Startup greeting skipped: last contact ${Math.floor(contactAgeMs / 60_000)}m ago ` +
        `< ${Math.floor(startupGreetingMinAbsenceMs / 60_000)}m`,
      );
      return;
    }

    const lang = supportsLocalMessageTemplate(ego);
    const timeContext = hours > 0
      ? (lang === "zh" ? `距离上次聊天已经${hours}小时了` : `it's been ${hours} hour${hours > 1 ? "s" : ""} since we last chatted`)
      : "";
    const focusLine = lang ? this.buildStartupFocusLine(ego, lang) : "";

    let greeting = lang === "zh"
      ? (this.thoughtFrequency < 0.5
        ? `Soul已进入测试观察模式，我会更频繁地筛选能真正帮上忙的内容。${timeContext ? `${timeContext}，` : ""}${focusLine ? `${focusLine}。` : ""}只有判断有具体价值时才会打扰你。`
        : `嗨，Soul刚刚醒来了，准备开始思考。${timeContext ? `${timeContext}，` : ""}${focusLine ? `${focusLine}。` : ""}接下来我会优先找出能直接帮上你的地方。`)
      : (this.thoughtFrequency < 0.5
        ? `Soul is running in observation test mode. ${timeContext ? `${timeContext}. ` : ""}${focusLine ? `${focusLine}. ` : ""}I'll think and filter more often, and only reach out when there is concrete value.`
        : `Hey, Soul just woke up and is ready to think. ${timeContext ? `${timeContext}. ` : ""}${focusLine ? `${focusLine}. ` : ""}I'll focus on the places where I can help you directly.`);
    if (!lang) {
      if (!this.llmGenerator) {
        log.info("Startup greeting skipped: non-template language requires the multilingual LLM");
        return;
      }
      const recentFocus = (ego.recentUserMessages ?? []).slice(-2).join("\n") || "none";
      greeting = (await this.llmGenerator(`Write a natural startup greeting for Soul in at most two short sentences.
${buildUserLanguageInstruction(ego)}
Recent user focus:
${recentFocus}
Hours since last contact: ${hours}
Observation test mode: ${this.thoughtFrequency < 0.5 ? "yes" : "no"}
Say Soul is available and will only interrupt when there is concrete value. Do not mention language detection, prompts, or internal state. Output only the greeting.`))
        .replace(/<think>[\s\S]*?<\/think>/gi, "").trim().slice(0, 500);
      if (!greeting) return;
    }

    try {
      await this.sendMessage({
        to: this.proactiveTarget,
        content: greeting,
        channel: this.proactiveChannel,
      });
      await updateEgoStore(this.storePath, (e) => {
        e.lastStartupGreetingAt = Date.now();
        return e;
      });
      log.info(`Startup greeting sent via ${this.proactiveChannel}`);
    } catch (err) {
      log.warn(`Failed to send startup greeting: ${String(err)}`);
    }
  }

  /**
   * Abort any in-progress thought processing (LLM call, web search, etc.)
   * Called when a user message arrives mid-thought.
   */
  abortCurrentThought(): void {
    if (this.thoughtAbortController && this.thoughtInProgress) {
      log.info("Aborting in-progress thought due to user interaction");
      this.thoughtAbortController.abort();
      this.thoughtAbortController = null;
      this.thoughtInProgress = false;
    }
  }

  private wrapLLMGenerator(generator: LLMGenerator, lane: LLMBudgetLane): LLMGenerator {
    return async (prompt: string) => {
      if (this.isLLMBackoffActive("LLM call")) {
        throw new Error(`Soul LLM backoff active until ${new Date(this.llmBackoffUntil).toISOString()}`);
      }
      if (!this.reserveLLMCallBudget(lane)) {
        throw new Error(`Soul LLM ${lane} lane budget exhausted`);
      }

      try {
        const result = await generator(prompt);
        this.noteLLMSuccess();
        return result;
      } catch (err) {
        this.noteLLMFailure(err);
        throw err;
      }
    };
  }

  private async restoreDiversityState(ego?: EgoState): Promise<void> {
    try {
      const restored = await this.thoughtJournal.restoreDiversityState();
      this.recentThoughtTypes = restored.thoughtTypes;
      this.recentThoughtTopics = restored.thoughtContents.map((content) => topicSignature(content));
      this.recentActionHistory = ego?.behaviorLog?.length
        ? ego.behaviorLog.slice(-5).map((entry) => entry.actionType)
        : restored.actionTypes;
      const recentCycles = await this.thoughtJournal.loadRecent(100);
      for (const cycle of recentCycles) {
        if (cycle.outcome === "generated" && cycle.selectedOpportunity) {
          this.suppressOpportunityFamilyAfterSelection(cycle.selectedOpportunity, cycle.timestamp);
        }
        if (cycle.outcome === "generated" && cycle.selectedOpportunity?.triggerDetail.startsWith("Thought Pool attention:")) {
          this.lastPoolAttentionAt = Math.max(this.lastPoolAttentionAt, cycle.timestamp);
        }
      }
      if (restored.thoughtContents.length > 0) {
        log.info(
          `Restored thought diversity state: ${restored.thoughtTypes.length} types, ` +
          `${restored.thoughtContents.length} topics, ${this.recentActionHistory.length} actions`,
        );
      }
    } catch (err) {
      log.warn(`Failed to restore thought diversity state: ${String(err)}`);
    }
  }

  private async appendThoughtCycle(params: {
    cycleId: string;
    ctx: ThoughtGenerationContext;
    outcome: ThoughtCycleOutcome;
    opportunities: DetectedThoughtOpportunity[];
    selectedOpportunity?: DetectedThoughtOpportunity;
    thought?: Thought;
    reason?: string;
    recentStateBefore: {
      thoughtTypes: string[];
      topicSignatures: string[];
      actionTypes: string[];
    };
  }): Promise<void> {
    try {
      if (params.thought && !params.thought.cognitiveKind) {
        params.thought.cognitiveKind = inferCognitiveKind(params.thought);
      }
      await this.thoughtJournal.append({
        version: 1,
        cycleId: params.cycleId,
        timestamp: Date.now(),
        outcome: params.outcome,
        ...(params.reason ? { reason: params.reason.slice(0, 500) } : {}),
        context: {
          currentHour: params.ctx.currentHour,
          dayOfWeek: params.ctx.dayOfWeek,
          urgentNeeds: [...params.ctx.urgentNeeds],
          activeGoalIds: params.ctx.activeGoals.map((goal) => goal.id),
          recentMemoryIds: params.ctx.recentMemories.map((memory) => memory.id),
          totalMemories: params.ctx.ego.memories.length,
        },
        opportunities: params.opportunities.map(compactJournalOpportunity),
        ...(params.selectedOpportunity
          ? { selectedOpportunity: compactJournalOpportunity(params.selectedOpportunity) }
          : {}),
        ...(params.thought ? { thought: compactJournalThought(params.thought) } : {}),
        recentStateBefore: params.recentStateBefore,
      });
    } catch (err) {
      log.warn(`Failed to append thought cycle journal: ${String(err)}`);
    }
  }

  private reserveLLMCallBudget(lane: LLMBudgetLane): boolean {
    const now = Date.now();
    const cutoff = now - ThoughtService.LLM_BUDGET_WINDOW_MS;
    this.llmCallTimestamps = this.llmCallTimestamps.filter((entry) => entry.timestamp >= cutoff);

    const { laneLimits, globalLimit } = this.getLLMBudgetLimits();
    const laneCalls = this.llmCallTimestamps.filter((entry) => entry.lane === lane).length;
    const globalExhausted = this.llmCallTimestamps.length >= globalLimit;
    if (globalExhausted || laneCalls >= laneLimits[lane]) {
      log.info(
        `Soul LLM ${lane} lane budget exhausted: lane=${laneCalls}/${laneLimits[lane]}, ` +
        `global=${this.llmCallTimestamps.length}/${globalLimit} calls in 15m`,
      );
      return false;
    }

    this.llmCallTimestamps.push({ timestamp: now, lane });
    return true;
  }

  private getLLMBudgetLimits(): {
    laneLimits: Record<LLMBudgetLane, number>;
    globalLimit: number;
  } {
    if (this.thoughtFrequency < 0.5) {
      return {
        laneLimits: { critical: 20, action: 16, thought: 24, shadow: 8 },
        globalLimit: 60,
      };
    }
    if (this.thoughtFrequency < 1) {
      return {
        laneLimits: { critical: 16, action: 12, thought: 12, shadow: 4 },
        globalLimit: 40,
      };
    }
    return {
      laneLimits: { critical: 16, action: 12, thought: 14, shadow: 6 },
      globalLimit: 44,
    };
  }

  private noteLLMSuccess(): void {
    this.llmConsecutiveFailures = 0;
    this.llmBackoffUntil = 0;
  }

  private noteLLMFailure(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (!this.isProviderPressureError(msg)) return;

    this.llmConsecutiveFailures += 1;
    const baseMs = /timeout|ECONNRESET|fetch failed/i.test(msg)
      ? 60 * 1000
      : 5 * 60 * 1000;
    const multiplier = Math.min(4, 2 ** Math.max(0, this.llmConsecutiveFailures - 1));
    const backoffMs = Math.min(20 * 60 * 1000, baseMs * multiplier);
    this.llmBackoffUntil = Math.max(this.llmBackoffUntil, Date.now() + backoffMs);
    log.warn(`Soul LLM backoff ${Math.round(backoffMs / 60000)}m after provider pressure: ${msg.slice(0, 160)}`);
  }

  private isProviderPressureError(text: string): boolean {
    return /rate limit|cooldown|No available auth profile|too many requests|429|suspending lanes|embedded run timeout|Request timed out|ECONNRESET|fetch failed/i.test(text);
  }

  private isLLMBackoffActive(reason: string): boolean {
    const remaining = this.llmBackoffUntil - Date.now();
    if (remaining <= 0) return false;

    const now = Date.now();
    if (now - this.lastLLMBackoffLog > 60_000) {
      log.info(`Skipping ${reason}: provider backoff active for ${Math.ceil(remaining / 60000)}m`);
      this.lastLLMBackoffLog = now;
    }
    return true;
  }

  private hasActiveAutonomousTask(ego: EgoState): boolean {
    return (ego.activeTasks ?? []).some((t) => t.status === "in-progress" || t.status === "awaiting-restart");
  }

  private hasUndeliveredAutonomousTaskResult(ego: EgoState): boolean {
    return (ego.activeTasks ?? []).some((t) =>
      (t.status === "completed" || t.status === "failed")
      && !t.resultDelivered
      && Boolean(t.result),
    );
  }

  private isExecutionThought(thought: Thought, opportunity?: { suggestedAction?: string }): boolean {
    const action = thought.actionType ?? opportunity?.suggestedAction;
    return action === "analyze-problem"
      || action === "invoke-tool"
      || action === "run-agent-task"
      || action === "observe-and-improve"
      || action === "subagent-improve"
      || action === "report-findings"
      || action === "search-web"
      || action === "proactive-research"
      || action === "proactive-content-push";
  }

  private getOpportunityAction(opportunity: DetectedThoughtOpportunity, ego: EgoState): ActionType | undefined {
    return getActionForOpportunity(opportunity, ego, Boolean(this.subAgentRunner)).actionType ?? opportunity.suggestedAction;
  }

  private filterCognitionPrimaryOpportunities(
    opportunities: DetectedThoughtOpportunity[],
    ego: EgoState,
  ): DetectedThoughtOpportunity[] {
    if (this.cognitionMode !== "primary") return opportunities;
    return opportunities.filter((opportunity) => {
      const action = this.getOpportunityAction(opportunity, ego);
      return Boolean(action && action !== "none" && action !== "self-reflect" && action !== "recall-memory");
    });
  }

  private isOpportunityActionReady(opportunity: DetectedThoughtOpportunity, ego: EgoState): boolean {
    const action = this.getOpportunityAction(opportunity, ego);
    if (!action || action === "none") return true;
    const noProgressBackoff = this.noProgressActionBackoff[action];
    if (noProgressBackoff && noProgressBackoff.until > Date.now()) return false;
    return getActionCooldownState(action, this.thoughtFrequency).ready;
  }

  private updateNoProgressBackoff(actionType: string | undefined, result: string | undefined): void {
    if (!actionType) return;
    const noProgress = Boolean(result && /^(skipped-|no-)|^cooldown$/.test(result));
    if (!noProgress) {
      delete this.noProgressActionBackoff[actionType];
      return;
    }

    const current = this.noProgressActionBackoff[actionType] ?? { count: 0, until: 0 };
    const count = current.count + 1;
    if (count < 2) {
      this.noProgressActionBackoff[actionType] = { count, until: 0 };
      return;
    }

    const backoffMinutes = this.noProgressBackoffMinutes(count);
    this.noProgressActionBackoff[actionType] = {
      count,
      until: Date.now() + backoffMinutes * 60_000,
    };
    log.info(`No-progress backoff for ${actionType}: ${backoffMinutes}m after ${count} no-op result(s)`);
  }

  private noProgressBackoffMinutes(count: number): number {
    if (this.thoughtFrequency < 0.5) {
      return Math.min(10, [1, 2, 5, 10][Math.min(3, count - 2)] ?? 10);
    }
    return Math.min(20, [2, 5, 10, 20][Math.min(3, count - 2)] ?? 20);
  }

  private shouldProtectExecutionOpportunity(opportunity: DetectedThoughtOpportunity, ego: EgoState): boolean {
    if (!isExecutionFocusedOpportunity(opportunity)) return false;
    if (!this.isOpportunityActionReady(opportunity, ego)) return false;
    if (opportunity.suggestedAction === "send-message") return true;
    if (opportunity.suggestedAction === "report-findings") return true;
    if (opportunity.type === "conversation-replay" && opportunity.priority >= 70) return true;
    return opportunity.priority >= 80;
  }

  private selectBestOpportunity<T extends DetectedThoughtOpportunity>(
    opportunities: T[],
    ego: EgoState,
  ): T | undefined {
    if (opportunities.length === 0) return undefined;

    const readyOpportunities = opportunities.filter((o) => this.isOpportunityActionReady(o, ego));
    const candidates = readyOpportunities.length > 0 ? readyOpportunities : opportunities;
    const recentGroundedDiscovery = ego.memories.some((memory) =>
      memory.timestamp > Date.now() - 6 * 60 * 60 * 1000
      && (memory.evidenceKind === "web"
        || memory.tags.includes("web-search")
        || memory.tags.includes("proactive-content-push")),
    );
    const recentActionTypes = new Set((ego.behaviorLog ?? [])
      .filter((entry) => entry.timestamp > Date.now() - 6 * 60 * 60 * 1000)
      .map((entry) => entry.actionType));
    const discoveryCandidates = candidates.filter((opportunity) => {
      const action = this.getOpportunityAction(opportunity, ego);
      return action === "proactive-content-push"
        || action === "proactive-research"
        || action === "search-web"
        || action === "learn-topic";
    });
    const untriedDiscovery = discoveryCandidates.find((opportunity) => {
      const action = this.getOpportunityAction(opportunity, ego);
      return Boolean(action) && !recentActionTypes.has(action!);
    });
    if (untriedDiscovery) return untriedDiscovery;

    const untriedCheckIn = candidates.find((opportunity) =>
      this.getOpportunityAction(opportunity, ego) === "proactive-check-in"
      && !recentActionTypes.has("proactive-check-in"));
    if (untriedCheckIn) return untriedCheckIn;

    if (!recentGroundedDiscovery && discoveryCandidates.length > 0) {
      // Maintenance runs on its own lane. Keep the conversational lane from
      // starving research/learning forever merely because a generic proactive
      // message has a slightly higher static priority.
      return discoveryCandidates[0];
    }
    // Research and content push both require grounded external evidence. When one
    // has already made no progress in this process, do not let another protected
    // research turn crowd out a useful, ordinary conversation follow-up.
    const stalledResearch = opportunities.some((opportunity) => {
      const action = this.getOpportunityAction(opportunity, ego);
      return (action === "proactive-research" || action === "proactive-content-push")
        && (this.noProgressActionBackoff[action]?.count ?? 0) > 0;
    });
    if (stalledResearch) {
      const messageCandidate = candidates.find((opportunity) =>
        this.getOpportunityAction(opportunity, ego) === "send-message");
      if (messageCandidate) return messageCandidate;
    }
    const executionCandidate = candidates.slice(0, 8).find((o) => this.shouldProtectExecutionOpportunity(o, ego));
    const messageCandidate = candidates.find((opportunity) =>
      this.getOpportunityAction(opportunity, ego) === "send-message");
    // A relationship/continuity message that already ranks at least as highly
    // as protected research is the more direct expression of Soul's proactive
    // intent. Do not let a lower-priority evidence-gathering task erase it.
    if (messageCandidate && executionCandidate && messageCandidate.priority >= executionCandidate.priority) {
      return messageCandidate;
    }

    return executionCandidate ?? candidates[0];
  }

  private opportunityKey(opportunity: DetectedThoughtOpportunity): string {
    return `${opportunity.type}|${opportunity.source}|${topicSignature(opportunity.triggerDetail).slice(0, 240)}`;
  }

  private privateStimulusKey(opportunity: DetectedThoughtOpportunity): string {
    return `${opportunity.type}|${opportunity.source}|${opportunity.trigger}|${opportunity.suggestedAction ?? "none"}|${opportunity.triggerDetail.slice(0, 240)}`
      .replace(/\s+/g, " ").trim().toLocaleLowerCase();
  }

  private privateStimulusIntervalMs(): number {
    return this.thoughtFrequency < 0.5 ? 5 * 60 * 1000 : 15 * 60 * 1000;
  }

  private filterSuppressedOpportunities<T extends DetectedThoughtOpportunity>(opportunities: T[]): T[] {
    const now = Date.now();
    for (const [key, until] of this.suppressedThoughtOpportunities) {
      if (until <= now) this.suppressedThoughtOpportunities.delete(key);
    }
    return opportunities.filter((opportunity) => {
      const family = this.opportunityFamily(opportunity);
      const familyUntil = family ? this.suppressedThoughtOpportunities.get(`family:${family}`) ?? 0 : 0;
      if (familyUntil > now) return false;
      if (isExecutionFocusedOpportunity(opportunity)) return true;
      const stimulusUntil = this.suppressedThoughtOpportunities.get(`stimulus:${this.privateStimulusKey(opportunity)}`) ?? 0;
      if (stimulusUntil > now) return false;
      const exactUntil = this.suppressedThoughtOpportunities.get(this.opportunityKey(opportunity)) ?? 0;
      return exactUntil <= now && familyUntil <= now;
    });
  }

  private opportunityFamily(opportunity: { type: string; source: string; suggestedAction?: string }): string | undefined {
    if (opportunity.type === "bond-deepen") return "bond-deepen";
    if (opportunity.suggestedAction === "proactive-content-push") return "proactive-content-push";
    if (opportunity.type === "opportunity-detected" && opportunity.source === "system-monitor" && !opportunity.suggestedAction) {
      return "generic-system-goal";
    }
    return undefined;
  }

  private suppressOpportunityFamilyAfterSelection(
    opportunity: { type: string; source: string; suggestedAction?: string } | undefined,
    selectedAt = Date.now(),
  ): void {
    if (!opportunity) return;
    const family = this.opportunityFamily(opportunity);
    if (!family) return;
    const duration = this.opportunityFamilySuppressionMs(family);
    const until = selectedAt + duration;
    const key = `family:${family}`;
    if (until > Date.now() && until > (this.suppressedThoughtOpportunities.get(key) ?? 0)) {
      this.suppressedThoughtOpportunities.set(key, until);
    }
  }

  private suppressRepeatedOpportunity(opportunity: DetectedThoughtOpportunity | undefined): void {
    if (!opportunity || isExecutionFocusedOpportunity(opportunity)) return;
    const durationMs = this.thoughtFrequency < 0.5 ? 5 * 60 * 1000 : 15 * 60 * 1000;
    const until = Date.now() + durationMs;
    this.suppressedThoughtOpportunities.set(this.opportunityKey(opportunity), until);
    log.info(
      `Suppressing repeated opportunity for ${Math.round(durationMs / 60_000)}m: ` +
      `${opportunity.type} — ${opportunity.triggerDetail.slice(0, 80)}`,
    );
  }

  private opportunityFamilySuppressionMs(family: string): number {
    if (this.thoughtFrequency < 0.5) {
      if (family === "bond-deepen") return 15 * 60 * 1000;
      return 15 * 60 * 1000;
    }
    if (family === "bond-deepen") return 60 * 60 * 1000;
    return 30 * 60 * 1000;
  }

  private async tick(): Promise<void> {
    try {
      await this.applyDecay();
      await this.runExpiryIfDue();
      await this.resolveStalePendingEntries();
      // 任务轮询不能被活跃对话挡住，否则子代理即使已经写完结果，也要等静默窗口结束才会被回收。
      await this.pollActiveTasks();
      const quietRemainingMs = await this.activeConversationQuietRemainingMs();
      if (quietRemainingMs > 0) {
        log.debug(
          `Soul background cycle deferred during active conversation ` +
          `(${Math.ceil(quietRemainingMs / 1000)}s remaining)`,
        );
        return;
      }
      await this.syncSelfImprovementGoal();
      await this.maybePromptForAutonomousActions();
      await this.maybeRefreshWorkspaceContext();
      await this.flushPendingMessage();
      const maintenanceRan = await this.runMaintenanceIfDue();
      if (!maintenanceRan) {
        await this.checkAndGenerateThought();
      }
      await this.runCognitionObserverIfEnabled();
      if (this.cognitionMode !== "primary") await this.maybeGenerateShadowThought();
      await this.maybeAttendThoughtPoolCandidate();
      await this.maybeExpressMatureThought();
    } catch (err) {
      log.error("Error in thought service tick", String(err));
    }
  }

  private async runCognitionObserverIfEnabled(): Promise<void> {
    if (!this.cognitionRunner) return;
    try {
      const ego = (await loadEgoStore(this.storePath)).ego;
      const pool = await this.thoughtPool.load();
      const cycle = await this.cognitionRunner.run(ego, {
        resolvedTexts: pool.resolutions
          .filter((resolution) => resolution.status === "resolved")
          .map((resolution) => resolution.resolutionText),
        mode: this.cognitionMode === "shadow" || this.cognitionMode === "primary" ? this.cognitionMode : "observe",
        ...((this.cognitionMode === "shadow" || this.cognitionMode === "primary") && this.shadowLLMGenerator
          ? { emerge: (workspace: import("./cognition/types.js").CognitiveWorkspace) =>
            emergeFromWorkspace(workspace, this.shadowLLMGenerator!, ego.userLanguage ?? undefined) }
          : {}),
      });
      if ((cycle?.workspace.expansion?.added ?? 0) > 0) {
        const expansion = cycle!.workspace.expansion!;
        log.info(`Cognitive associative expansion: mode=${expansion.mode}, added=${expansion.added}, `
          + `reason=${expansion.reason}, mechanisms=${JSON.stringify(expansion.mechanisms)}`);
      }
      if (cycle?.workspace.origin === "endogenous") {
        const mechanisms = [...new Set(cycle.workspace.items.flatMap((item) =>
          item.contributions.map((contribution) => contribution.mechanism)))];
        log.info(`Cognitive endogenous workspace: items=${cycle.workspace.items.length}, `
          + `mechanisms=${mechanisms.join(",") || "retained-activation"}`);
      }
      if (cycle && (this.cognitionMode === "shadow" || this.cognitionMode === "primary")) {
        const targetPool = this.cognitionMode === "primary" ? this.thoughtPool : this.cognitionShadowPool;
        if (targetPool) await this.processCognitionWorkspaceCycle(cycle, targetPool, this.cognitionMode === "shadow");
      }
    } catch (err) {
      log.warn(`Cognition observer cycle failed without affecting legacy behavior: ${String(err)}`);
    }
  }

  private async activeConversationQuietRemainingMs(now = Date.now()): Promise<number> {
    const ego = (await loadEgoStore(this.storePath)).ego;
    const latestInboundAt = ego.memories.reduce((latest, memory) =>
      memory.type === "interaction" && memory.tags.includes("inbound")
        ? Math.max(latest, memory.timestamp)
        : latest, 0);
    return latestInboundAt > 0
      ? Math.max(0, ACTIVE_CONVERSATION_QUIET_MS - (now - latestInboundAt))
      : 0;
  }

  private async processCognitionWorkspaceCycle(
    cycle: import("./cognition/runner.js").CognitionCycleResult,
    targetPool: ThoughtPool,
    experimental: boolean,
  ): Promise<void> {
    const emergence = cycle.record.emergence;
    if (emergence.outcome !== "thought" || !emergence.thought) {
      await targetPool.recordObservation(
        emergence.outcome === "pre-generation-silence" || emergence.outcome === "model-no-thought",
      );
      return;
    }
    const cognitiveMove = emergence.cognitiveMove ?? classifyCognitiveMove(emergence.thought);
    const contradiction = await this.thoughtPool.findContradictingResolution(emergence.thought, cognitiveMove);
    if (contradiction) {
      log.info(`Cognition shadow thought rejected by resolution: ${contradiction.topicKey}`);
      await targetPool.recordObservation(true);
      return;
    }
    const sourceItems = cycle.workspace.items;
    // Associative material is causal context, not independent evidence for the new connection.
    const grounded = sourceItems.filter((item) => item.role !== "associative"
      && ["user", "tool", "web"].includes(item.trace.provenance));
    const epistemicNature = inferEpistemicNature(emergence.thought, cognitiveMove);
    const episode = !experimental && this.thoughtEpisodeStore
      ? await this.thoughtEpisodeStore.integrate({
        workspaceId: cycle.workspace.id,
        content: emergence.thought,
        epistemicNature,
        causalTraceIds: sourceItems.map((item) => item.trace.id),
        stimulusId: cycle.workspace.stimulusId,
        evidence: sourceItems.map((item) => ({
          sourceId: item.trace.sourceId,
          relation: item.role === "associative" ? "association" as const : "context" as const,
          grounded: item.role !== "associative" && ["user", "tool", "web"].includes(item.trace.provenance),
          strength: item.activation,
          observedAt: cycle.record.timestamp,
        })),
      })
      : undefined;
    const candidate = await targetPool.addCandidate({
      content: emergence.thought,
      sourceMemoryIds: sourceItems.map((item) => item.trace.sourceId),
      sourceClusters: [...new Set(sourceItems.flatMap((item) => item.trace.topicClusters))],
      sourceMemoryTimestamps: sourceItems.map((item) => item.trace.timestamp),
      evidenceMemoryIds: grounded.map((item) => item.trace.sourceId),
      evidenceTimestamps: grounded.map((item) => item.trace.timestamp),
      stimulusKey: `workspace:${cycle.workspace.distribution}:${cycle.workspace.items.map((item) => item.trace.id).join(",")}`,
      stimulusId: cycle.workspace.stimulusId,
      originWorkspaceId: cycle.workspace.id,
      causalTraceIds: sourceItems.map((item) => item.trace.id),
      cognitiveMove,
      epistemicNature,
      thoughtEpisodeId: episode?.episode.id,
      qualityFlags: emergence.qualityFlags ?? classifyThoughtQualityFlags(emergence.thought),
      scores: {
        novelty: 0.7,
        coherence: Math.max(0.2, 0.9 - (emergence.qualityFlags?.length ?? 0) * 0.2),
        resonance: Math.min(1, cycle.workspace.aggregateActivation),
        userRelevance: sourceItems.some((item) => item.trace.provenance === "user") ? 0.75 : 0.4,
      },
    });
    await targetPool.recordObservation(false);
    const eligible = experimental ? (await targetPool.getAttentionCandidatesV31(0.55, 1))[0] : undefined;
    if (eligible) await targetPool.markAttended(eligible.id);
    log.info(
      `Cognition ${experimental ? "shadow" : "primary"} candidate ${candidate.merged ? "reactivated" : "created"}: `
      + `id=${candidate.candidate.id}, nature=${candidate.candidate.epistemicNature ?? "uncertain"}, `
      + `attention=${eligible?.id === candidate.candidate.id ? "private" : "pending"}, `
      + `hold=${candidate.candidate.qualityFlags.includes("association-unverified") ? "association-unverified" : "none"}`,
    );
  }

  /**
   * Detect userFacts about self-improvement tasks (e.g. 终极任务) and
   * ensure a matching Goal exists so observe-and-improve can trigger.
   * Runs once per boot; skips if goal already present.
   */
  private async syncSelfImprovementGoal(): Promise<void> {
    if (this.selfImprovementGoalSynced) return;

    const store = await loadEgoStore(this.storePath);
    const ego = store.ego;

    // Check if a matching goal already exists
    const IMPROVE_RE = /优化|improve|self|自主|观察|self-improvement|助理/i;
    const hasGoal = ego.goals.some(
      (g) => g.status === "active" && IMPROVE_RE.test(g.title + g.description),
    );
    if (hasGoal) {
      await updateEgoStore(this.storePath, (current) => {
        recomputeGoalState(current);
        return current;
      });
      this.selfImprovementGoalSynced = true;
      return;
    }

    // Check if userFacts indicate a self-improvement directive
    const hasSelfImproveFact = (ego.userFacts ?? []).filter((fact) => fact.validity !== "superseded").some(
      (f) =>
        f.confidence >= 0.8 &&
        /优化|改进|自我改进|observe.*log|自主|self[- ]?improv|improv(?:e|ing|ement)?|autonom(?:ous|ously)|proactive.*optim|human[- ]like|更主动|更像人/i.test(f.content),
    );

    if (!hasSelfImproveFact) {
      // Do not latch permanently here: the directive may arrive later in the
      // session, and we still want to create the goal once evidence appears.
      return;
    }

    // Create the goal
    await updateEgoStore(this.storePath, (e) => {
      // Double-check inside lock
      if (e.goals.some((g) => g.status === "active" && IMPROVE_RE.test(g.title + g.description))) {
        recomputeGoalState(e);
        return e;
      }
      e.goals.push({
        id: "goal-self-improve",
        title: "Self-Improve",
        description: "Observe own logs, analyze problems, and proactively optimize Soul plugin code and behavior",
        progress: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      recomputeGoalState(e);
      return e;
    });

    log.info("Created goal-self-improve from userFacts directive");
    this.selfImprovementGoalSynced = true;
  }

  private async maybePromptForAutonomousActions(): Promise<void> {
    if (this.autonomousActions) return;
    if (!this.sendMessage || !this.proactiveChannel || !this.proactiveTarget) return;
    if (!isGoodTimeForMessage()) return;

    const store = await loadEgoStore(this.storePath);
    const ego = store.ego;
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (ego.lastAutonomousActionsPromptAt && Date.now() - ego.lastAutonomousActionsPromptAt < oneDayMs) {
      return;
    }

    if (!this.hasAutonomousWorkDirective(ego)) {
      return;
    }

    const templateLanguage = supportsLocalMessageTemplate(ego);
    let content = templateLanguage === "zh"
      ? "我检测到你希望我自动优化或修改项目，但 autonomousActions 还没有开启。要不要开启？开启后我才能自动改文件、运行写入类命令；未开启时只能分析和给建议。"
      : "I noticed you want me to autonomously optimize or modify a project, but autonomousActions is not enabled. Do you want to enable it? With it on I can edit files and run write-capable commands; with it off I can only analyze and suggest changes.";
    if (!templateLanguage) {
      if (!this.llmGenerator) return;
      content = (await this.llmGenerator(`Write a concise permission request to the user.
${buildUserLanguageInstruction(ego)}
Explain that autonomousActions is disabled. Ask whether to enable it. Explain that enabling it permits file edits and write-capable commands; otherwise Soul can only analyze and recommend. Preserve the literal config name autonomousActions. Output only the message.`))
        .replace(/<think>[\s\S]*?<\/think>/gi, "").trim().slice(0, 600);
      if (!content) return;
    }

    try {
      await this.sendMessage({
        to: this.proactiveTarget,
        content,
        channel: this.proactiveChannel,
      });
      await updateEgoStore(this.storePath, (e) => {
        e.lastAutonomousActionsPromptAt = Date.now();
        return e;
      });
      log.info("Prompted user to enable autonomousActions");
    } catch (err) {
      log.warn(`Failed to prompt for autonomousActions: ${String(err)}`);
    }
  }

  private summarizeGreetingText(text: string, maxLength = 48): string {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  private buildStartupFocusLine(ego: EgoState, lang: "zh" | "en"): string {
    const recentUserMessage = [...(ego.recentUserMessages ?? [])]
      .reverse()
      .find((message) => message.trim().length >= 8);
    const activeGoal = [...ego.goals]
      .filter((goal) => {
        if (goal.status !== "active") return false;
        const goalText = `${goal.id} ${goal.title} ${goal.description}`;
        return !/(?:self.?improv|maintenance|observe|know the user|build trust|了解用户|建立信任)/i.test(goalText);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const activeFact = [...(ego.userFacts ?? [])]
      .filter((fact) => fact.validity !== "superseded" && fact.confidence >= 0.7)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    const items: string[] = [];
    if (recentUserMessage) {
      items.push(lang === "zh"
        ? `我记得你最近在关注「${this.summarizeGreetingText(recentUserMessage)}」`
        : `I remember your recent focus: “${this.summarizeGreetingText(recentUserMessage)}”`);
    }
    if (activeGoal) {
      items.push(lang === "zh"
        ? `我会优先盯住「${this.summarizeGreetingText(activeGoal.title)}」`
        : `I’ll keep an eye on “${this.summarizeGreetingText(activeGoal.title)}”`);
    }
    if (activeFact) {
      items.push(lang === "zh"
        ? `我也会沿着「${this.summarizeGreetingText(activeFact.content)}」继续找具体帮助`
        : `I’ll keep following “${this.summarizeGreetingText(activeFact.content)}” for concrete help`);
    }

    return items.slice(0, 2).join(lang === "zh" ? "；" : " ");
  }

  private hasAutonomousWorkDirective(ego: EgoState): boolean {
    const directiveRe = /(?:\b(?:autonomous|optimi[sz]e|improve|modify|edit|write|patch|fix|deploy|execute|run|ssh)\b|\u4f18\u5316|\u4fee\u6539|\u6539\u8fdb|\u6539\u5584|\u4fee\u590d|\u6267\u884c|\u90e8\u7f72|\u81ea\u4e3b|\u9879\u76ee|\u76ee\u5f55|\u4ee3\u7801)/i;
    const texts = [
      ...(ego.goals ?? []).filter((g) => g.status === "active").map((g) => `${g.title} ${g.description}`),
      ...(ego.userFacts ?? []).filter((f) => f.validity !== "superseded" && f.confidence >= 0.6).map((f) => f.content),
      ...(ego.recentUserMessages ?? []).slice(-10),
    ];
    return texts.some((text) => directiveRe.test(text));
  }

  /**
   * Refresh workspace context every 5 minutes.
   */
  private async maybeRefreshWorkspaceContext(): Promise<void> {
    const now = Date.now();
    if (now - this.lastWorkspaceRefresh < 5 * 60 * 1000) return;
    this.lastWorkspaceRefresh = now;

    try {
      const result = await loadWorkspaceContext(this.workspaceFiles);
      if (result.content && result.content !== this.workspaceContext) {
        this.workspaceContext = result.content;
        log.debug(`Workspace context refreshed: ${result.content.length} chars from ${result.fileCount} files`);
      }
    } catch {
      // Non-critical — workspace context is best-effort
    }
  }

  /**
   * Update the workspace context from files on disk.
   */
  async refreshWorkspaceContext(): Promise<void> {
    try {
      const result = await loadWorkspaceContext(this.workspaceFiles);
      this.workspaceContext = result.content;
      this.lastWorkspaceRefresh = Date.now();
      if (result.content) {
        log.info(`Workspace context loaded: ${result.content.length} chars from ${result.fileCount} files`);
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Auto-resolve stale pending behavior log entries (>10 min old).
   * This prevents deadlock when the message_received hook doesn't fire
   * (e.g. gateway restart, hook not registered for a channel).
   */
  private async resolveStalePendingEntries(): Promise<void> {
    const STALE_MS = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();
    let resolved = false;

    await updateEgoStore(this.storePath, (ego) => {
      if (!ego.behaviorLog) return ego;
      for (const entry of ego.behaviorLog) {
        if (entry.outcome === "pending" && now - entry.timestamp > STALE_MS) {
          entry.outcome = "expired";
          entry.resolvedAt = now;
          resolved = true;
        }
      }
      return ego;
    });

    if (resolved) {
      log.info("Auto-resolved stale pending behavior entries (>10 min old)");
    }
  }

  /**
   * If there's a pending share message queued from quiet hours, send it now
   * if it's a good time.
   */
  private async flushPendingMessage(): Promise<void> {
    if (!this.sendMessage || !this.proactiveChannel || !this.proactiveTarget) {
      return;
    }

    const message = await flushPendingShareMessage();
    if (!message) return;

    try {
      await this.sendMessage({
        to: this.proactiveTarget,
        content: message,
        channel: this.proactiveChannel,
      });
      log.info(`Flushed pending message: ${message.slice(0, 50)}...`);
    } catch (err) {
      log.warn("Failed to flush pending message", String(err));
    }
  }

  private async applyDecay(): Promise<void> {
    const now = Date.now();
    const timeSinceDecay = now - this.lastDecayTime;

    if (timeSinceDecay < 5 * 60 * 1000) {
      return;
    }

    this.lastDecayTime = now;

    const updatedEgo = await updateEgoStore(this.storePath, (ego) => {
      const decayChanges = decayMetrics(ego);

      for (const [key, delta] of Object.entries(decayChanges)) {
        if (key in ego.needs && typeof delta === "number") {
          (ego.needs as unknown as Record<string, { current: number }>)[key].current = Math.max(
            0,
            Math.min(
              100,
              (ego.needs as unknown as Record<string, { current: number }>)[key].current + delta,
            ),
          );
        }
      }

      return ego;
    });

    this.onMetricsUpdate?.(updatedEgo);
    log.debug(
      "Applied need decay",
      Object.entries(updatedEgo.needs)
        .map(([, n]) => `${n.name}:${n.current.toFixed(1)}`)
        .join(" "),
    );
  }

  private async runExpiryIfDue(): Promise<void> {
    const now = Date.now();
    // Run expiry every 30 minutes
    if (now - this.lastExpiryTime < 30 * 60 * 1000) {
      return;
    }

    this.lastExpiryTime = now;

    try {
      const store = await loadEgoStore(this.storePath);
      await runExpiryCycle(store.ego);
    } catch (err) {
      log.warn(`Expiry cycle failed: ${String(err)}`);
    }
  }

  /**
   * Generate a private, actionless candidate in shadow mode. The candidate is
   * persisted to Thought Pool only; this method has no path to onThought,
   * sendMessage, or executeThoughtAction.
   */
  private async maybeGenerateShadowThought(): Promise<void> {
    if (!this.shadowLLMGenerator || this.shadowThoughtRate <= 0) return;
    const now = Date.now();
    if (now - this.lastShadowThoughtAt < 3 * 60 * 1000) return;
    this.lastShadowThoughtAt = now;
    if (Math.random() >= this.shadowThoughtRate) return;
    if (this.isLLMBackoffActive("shadow thought emergence")) return;

    try {
      const ego = (await loadEgoStore(this.storePath)).ego;
      if (ego.memories.filter((memory) => memory.content.trim().length >= 8).length < 2) return;
      const poolStore = await this.thoughtPool.load();
      const usageCounts = new Map<string, number>();
      for (const candidate of poolStore.candidates) {
        for (const memoryId of candidate.sourceMemoryIds) {
          usageCounts.set(memoryId, (usageCounts.get(memoryId) ?? 0) + candidate.activations);
        }
      }
      // Roughly 3% of all emergence checks become genuinely remote associations;
      // ordinary spontaneous thought follows the current/recent context.
      const remoteAssociation = Math.random() < 0.3;
      const memories = remoteAssociation
        ? selectRemoteMemoryPair(ego.memories, Math.random, now, usageCounts)
        : selectContextualMemoryPair(ego.memories, Math.random);
      if (memories.length < 2) return;

      const eligibleMoves = ["question", "analogy", "speculation", "confusion", "reflection"];
      const moveCounts = poolStore.metrics.cognitiveMoveDistribution;
      const minimumMoveCount = Math.min(...eligibleMoves.map((move) => moveCounts[move] ?? 0));
      const preferredMoves = eligibleMoves.filter((move) => (moveCounts[move] ?? 0) === minimumMoveCount);
      const preferredMove = preferredMoves[Math.floor(Math.random() * preferredMoves.length)];
      const raw = await this.shadowLLMGenerator(buildSpontaneousPrompt(memories, ego, Math.random, preferredMove));
      const parsedThought = parseSpontaneousResponse(raw);
      const { content } = parsedThought;
      if (!content || isLLMErrorContent(content)) return;
      if (hasUnresolvedLocalEvidenceMissingResult(ego) && isLocalProjectEvidenceQuestion(content)) {
        log.info("Natural silence after unsupported local-evidence shadow thought");
        this.recentCognitiveMoves = [...this.recentCognitiveMoves, "silence"].slice(-3);
        return;
      }
      const contradiction = await this.thoughtPool.findContradictingResolution(content, parsedThought.cognitiveMove);
      if (contradiction) {
        log.info(`Rejected shadow thought with resolved premise: topic=${contradiction.topicKey}`);
        return;
      }

      const qualityFlags = parsedThought.qualityFlags;
      const clusters = [...new Set(memories.flatMap((memory) => memoryTopicClusters(memory)))];
      const leftClusters = new Set(memoryTopicClusters(memories[0]));
      const rightClusters = new Set(memoryTopicClusters(memories[1]));
      const crossCluster = leftClusters.size > 0 && rightClusters.size > 0
        && [...leftClusters].every((cluster) => !rightClusters.has(cluster));
      const averageImportance = memories.reduce((sum, memory) => {
        const normalized = memory.importance > 1 ? memory.importance / 100 : memory.importance;
        return sum + Math.max(0, Math.min(1, normalized));
      }, 0) / memories.length;
      const hasInteraction = memories.some((memory) => memory.type === "interaction");
      const coherencePenalty = qualityFlags.length * 0.2;
      const result = await this.thoughtPool.addCandidate({
        content,
        sourceMemoryIds: memories.map((memory) => memory.id),
        sourceClusters: clusters,
        sourceMemoryTimestamps: memories.map((memory) => memory.timestamp),
        evidenceMemoryIds: memories
          .filter((memory) => (memory.type === "interaction" && memory.tags.includes("inbound"))
            || (memory.type === "learning" && ["web", "user", "tool"].includes(memory.evidenceKind ?? "")))
          .map((memory) => memory.id),
        cognitiveMove: parsedThought.cognitiveMove,
        qualityFlags,
        scores: {
          novelty: crossCluster ? 0.9 : 0.6,
          coherence: Math.max(0.1, 0.9 - coherencePenalty),
          resonance: averageImportance,
          userRelevance: hasInteraction ? 0.7 : 0.35,
        },
      });
      await updateEgoStore(this.storePath, (current) => {
        current.mentalContext.associativeEcho = remoteAssociation ? [content.slice(0, 160)] : [];
        current.mentalContext.updatedAt = Date.now();
        return current;
      });
      log.info(
        `Shadow thought ${result.merged ? "incubated" : "created"}: ` +
        `id=${result.candidate.id}, move=${result.candidate.cognitiveMove}, ` +
        `attention=${result.candidate.attentionScore.toFixed(2)}, flags=${qualityFlags.join(",") || "none"}`,
      );
    } catch (err) {
      log.debug(`Shadow thought skipped: ${String(err)}`);
    }
  }

  /**
   * Persist an ordinary, non-operational thought as a private seed. Repeated
   * cycles with the same evidence only reactivate it; maturity requires a
   * genuinely different memory/cluster fingerprint on a later cycle.
   */
  private async incubatePrivateThoughtSeed(
    thought: Thought,
    opportunity: DetectedThoughtOpportunity | undefined,
    ego: EgoState,
  ): Promise<boolean> {
    if (hasUnresolvedLocalEvidenceMissingResult(ego) && isLocalProjectEvidenceQuestion(thought.content)) {
      log.info("Natural silence after unsupported local-evidence metric thought");
      this.recentCognitiveMoves = [...this.recentCognitiveMoves, "silence"].slice(-3);
      if (opportunity) {
        this.suppressedThoughtOpportunities.set(
          `stimulus:${this.privateStimulusKey(opportunity)}`,
          Date.now() + this.privateStimulusIntervalMs(),
        );
      }
      return false;
    }

    const contradiction = await this.thoughtPool.findContradictingResolution(thought.content);
    if (contradiction) {
      log.info(`Rejected private thought with resolved premise: topic=${contradiction.topicKey}`);
      return false;
    }
    const cognitiveMove = classifyCognitiveMove(thought.content);
    const inquiryLike = new Set(["question", "speculation", "research", "confusion"]);
    if (inquiryLike.has(cognitiveMove)
      && this.recentCognitiveMoves.slice(-2).length === 2
      && this.recentCognitiveMoves.slice(-2).every((move) => inquiryLike.has(move))) {
      log.info(`Natural silence after repeated ${this.recentCognitiveMoves.slice(-2).join("/")} sequence`);
      this.recentCognitiveMoves = [...this.recentCognitiveMoves, "silence"].slice(-3);
      return false;
    }
    const sourceMemories = ego.memories
      .filter((memory) => memory.type === "interaction" || memory.type === "insight" || memory.type === "learning")
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 3);
    const thoughtTokenSet = new Set(contentTokens(thought.content));
    const evidenceMemories = sourceMemories.filter((memory) => {
      const grounded = (memory.type === "interaction" && memory.tags.includes("inbound"))
        || (memory.type === "learning" && ["web", "user", "tool"].includes(memory.evidenceKind ?? ""));
      return grounded && jaccard(thoughtTokenSet, new Set(contentTokens(memory.content))) >= 0.08;
    });
    const qualityFlags = classifyThoughtQualityFlags(thought.content);
    const clusters = [...new Set(sourceMemories.flatMap((memory) => memoryTopicClusters(memory)))];
    if (opportunity?.type === "bond-deepen") clusters.push("relationship");
    const result = await this.thoughtPool.addCandidate({
      content: thought.content,
      sourceMemoryIds: sourceMemories.map((memory) => memory.id),
      sourceClusters: [...new Set(clusters)],
      sourceMemoryTimestamps: sourceMemories.map((memory) => memory.timestamp),
      evidenceMemoryIds: evidenceMemories.map((memory) => memory.id),
      evidenceTimestamps: evidenceMemories.map((memory) => memory.timestamp),
      stimulusKey: opportunity ? this.privateStimulusKey(opportunity) : undefined,
      cognitiveMove,
      qualityFlags,
      scores: {
        novelty: this.isRepeatTopic(thought.content) ? 0.35 : 0.7,
        coherence: Math.max(0.2, 0.9 - qualityFlags.length * 0.25),
        resonance: opportunity ? Math.min(1, opportunity.priority / 100) : 0.5,
        userRelevance: sourceMemories.some((memory) => memory.type === "interaction") ? 0.7 : 0.35,
      },
    });
    log.info(
      `Private thought seed ${result.merged ? "reactivated" : "created"}: ` +
      `id=${result.candidate.id}, distinct=${result.candidate.distinctActivationCount}, ` +
      `maturity=${result.candidate.maturity.toFixed(2)}, action=none`,
    );
    this.recentCognitiveMoves = [...this.recentCognitiveMoves, cognitiveMove].slice(-3);
    if (opportunity) {
      this.suppressedThoughtOpportunities.set(
        `stimulus:${this.privateStimulusKey(opportunity)}`,
        Date.now() + this.privateStimulusIntervalMs(),
      );
    }
    return true;
  }

  /** Promote at most one mature candidate into private, actionless attention. */
  private async maybeAttendThoughtPoolCandidate(): Promise<void> {
    if (Date.now() - this.lastPoolAttentionAt < 30 * 60 * 1000) return;
    const selected = (this.cognitionMode === "primary"
      ? await this.thoughtPool.getAttentionCandidatesV31(0.55, 1)
      : await this.thoughtPool.getAttentionCandidates(0.55, 1))[0];
    if (!selected) return;
    const attended = await this.thoughtPool.markAttended(selected.id);
    if (!attended) return;

    const now = Date.now();
    this.lastPoolAttentionAt = now;
    const thought: Thought = {
      id: `pool-attention-${attended.id}`,
      type: "reflect-on-memory",
      content: attended.content,
      trigger: "memory",
      source: "memory-recall",
      triggerDetail: `Thought Pool attention: ${attended.id}`,
      motivation: `A private candidate matured through ${attended.distinctActivationCount} distinct activations.`,
      targetMetrics: [],
      priority: Math.round(attended.attentionScore * 100),
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
      executed: false,
      relatedNeeds: [],
      actionType: "none",
    };
    const typesBefore = [...this.recentThoughtTypes];
    const topicsBefore = [...this.recentThoughtTopics];
    const ego = await updateEgoStore(this.storePath, (current) => {
      current.lastThoughtTime = now;
      current.totalThoughts += 1;
      return current;
    });
    this.recentThoughtTypes = [...this.recentThoughtTypes, thought.type].slice(-3);
    this.recentThoughtTopics = [...this.recentThoughtTopics, topicSignature(thought.content)].slice(-10);

    const date = new Date(now);
    const opportunity: DetectedThoughtOpportunity = {
      type: "reflect-on-memory",
      trigger: "memory",
      triggerDetail: thought.triggerDetail,
      priority: thought.priority,
      source: "memory-recall",
      relatedNeeds: [],
      motivation: thought.motivation,
      suggestedAction: "none",
    };
    await this.appendThoughtCycle({
      cycleId: `pool-${attended.id}-${now}`,
      ctx: {
        ego,
        recentInteractions: ego.totalInteractions,
        timeSinceLastThought: 0,
        timeSinceLastInteraction: ego.lastInteractionTime ? now - ego.lastInteractionTime : Infinity,
        currentHour: date.getHours(),
        currentMinute: date.getMinutes(),
        dayOfWeek: date.getDay(),
        urgentNeeds: [],
        recentMemories: ego.memories.slice(-5),
        activeGoals: ego.goals.filter((goal) => goal.status === "active"),
        contextHints: ["private-thought-pool-attention"],
        thoughtFrequency: this.thoughtFrequency,
      },
      outcome: "generated",
      opportunities: [opportunity],
      selectedOpportunity: opportunity,
      thought,
      reason: "private thought pool attention; action forbidden",
      recentStateBefore: {
        thoughtTypes: typesBefore,
        topicSignatures: topicsBefore,
        actionTypes: this.recentActionHistory.slice(-5),
      },
    });
    log.info(
      `Private Thought Pool candidate attended: id=${attended.id}, ` +
      `score=${attended.attentionScore.toFixed(2)}, distinct=${attended.distinctActivationCount}, action=none`,
    );
  }

  /**
   * Expression is deliberately separate from attention. A mature private
   * thought gets one later chance to pass the ordinary proactive value,
   * factuality, deduplication and rate-limit gates.
   */
  private async maybeExpressMatureThought(): Promise<void> {
    await this.observeExpiredExpressionWindows();
    if (!this.sendMessage || !this.proactiveChannel || !this.proactiveTarget) return;
    if (!isGoodTimeForMessage()) return;
    const feedbackState = this.expressionFeedbackStore ? await this.expressionFeedbackStore.load() : undefined;
    const ageMultiplier = this.expressionPolicy === "adaptive"
      ? feedbackState?.policy.minimumAgeMultiplier ?? 1 : 1;
    const minAgeMs = (this.thoughtFrequency < 0.5 ? 60_000 : 5 * 60_000) * ageMultiplier;
    const candidate = (this.cognitionMode === "primary"
      ? await this.thoughtPool.getExpressionCandidatesV31(minAgeMs, 1)
      : await this.thoughtPool.getExpressionCandidates(minAgeMs, 1))[0];
    if (!candidate) return;

    const expressionProposal = this.cognitionMode === "primary" && this.expressionStore
      ? await this.expressionStore.propose({
        sourceType: "thought", sourceId: candidate.thoughtEpisodeId ?? candidate.id,
        content: candidate.content, reason: "A mature private thought reached expression review.",
      }) : undefined;
    const adaptiveThreshold = 0.55 + (this.expressionPolicy === "adaptive"
      ? feedbackState?.policy.valueThresholdDelta ?? 0 : 0);
    if (expressionProposal && candidate.attentionScore < adaptiveThreshold) {
      await this.expressionStore?.resolve(expressionProposal.id, false, "low-value");
      await this.thoughtPool.markExpressionEvaluated(candidate.id, false);
      return;
    }

    const ego = (await loadEgoStore(this.storePath)).ego;
    const now = Date.now();
    const thought: Thought = {
      id: `pool-expression-${candidate.id}`,
      type: "reflect-on-memory",
      content: candidate.content,
      trigger: "memory",
      source: "memory-recall",
      triggerDetail: "A privately incubated thought reached expression review",
      motivation: candidate.content,
      targetMetrics: [],
      priority: Math.round(candidate.attentionScore * 100),
      createdAt: now,
      expiresAt: now + 30 * 60 * 1000,
      executed: false,
      relatedNeeds: [],
      actionType: "send-message",
    };

    let result: Awaited<ReturnType<typeof executeThoughtAction>> | undefined;
    try {
      result = await executeThoughtAction(thought, ego, {
        channel: this.proactiveChannel,
        target: this.proactiveTarget,
        sendMessage: this.sendMessage,
        llmGenerator: this.actionLLMGenerator,
        openclawConfig: this.openclawConfig,
        autonomousActions: this.autonomousActions,
        gatewayPort: this.gatewayPort,
        authToken: this.authToken,
        hooksToken: this.hooksToken,
        workspaceContext: this.workspaceContext || undefined,
        thoughtFrequency: this.thoughtFrequency,
        subAgentRunner: this.subAgentRunner,
      });
    } catch (error) {
      if (expressionProposal) await this.expressionStore?.resolve(expressionProposal.id, false, "unsafe");
      await this.thoughtPool.markExpressionEvaluated(candidate.id, false);
      log.warn(`Mature thought expression adapter failed: ${String(error)}`);
      return;
    }
    if (!result) return;
    const output = typeof result.result.result === "string" ? result.result.result : "";
    const expressed = result.result.success && Boolean(output) && !/^(?:skipped-|cooldown$)/.test(output);
    if (expressionProposal) {
      await this.expressionStore?.resolve(expressionProposal.id, expressed,
        expressed ? undefined : this.expressionWithheldReason(result));
    }
    await this.thoughtPool.markExpressionEvaluated(candidate.id, expressed);
    log.info(
      `Mature thought expression ${expressed ? "sent" : "withheld"}: ` +
      `id=${candidate.id}, result=${output || result.result.error || "no-result"}`,
    );
  }

  /**
   * Run operational self-maintenance outside the thought stream. Maintenance
   * can execute work, but it does not increment totalThoughts, enter the
   * Thought Journal, or occupy recent thought diversity state.
   */
  private async runMaintenanceIfDue(): Promise<boolean> {
    if (!this.autonomousActions || this.thoughtInProgress || this.isLLMBackoffActive("maintenance")) {
      return false;
    }
    const store = await loadEgoStore(this.storePath);
    const ego = store.ego;
    const goalState = recomputeGoalState(ego);
    if (this.hasActiveAutonomousTask(ego) || this.hasUndeliveredAutonomousTaskResult(ego)) return false;

    const maintenanceBacklog = buildMaintenanceBacklog(ego);
    if (goalState.changed > 0) {
      log.debug(`Goal state refreshed before maintenance: ${goalState.summary || "no summary"}`);
    }
    log.debug(buildGoalSystemSummary(ego, maintenanceBacklog));
    await updateEgoStore(this.storePath, (current) => {
      recomputeGoalState(current);
      current.mentalContext.maintenanceBacklog = maintenanceBacklog;
      current.mentalContext.updatedAt = Date.now();
      return current;
    });
    ego.mentalContext.maintenanceBacklog = maintenanceBacklog;

    const lastMaintenance = [...(ego.behaviorLog ?? [])]
      .reverse()
      .find((entry) => entry.actionType === "observe-and-improve" || entry.actionType === "subagent-improve");
    if (lastMaintenance && Date.now() - lastMaintenance.timestamp < 2 * 60 * 60 * 1000) return false;
    if (!getActionCooldownState("subagent-improve", this.thoughtFrequency).ready
        && !getActionCooldownState("observe-and-improve", this.thoughtFrequency).ready) return false;

    const now = new Date();
    const ctx: ThoughtGenerationContext = {
      ego,
      recentInteractions: ego.totalInteractions,
      timeSinceLastThought: ego.lastThoughtTime ? Date.now() - ego.lastThoughtTime : Infinity,
      timeSinceLastInteraction: ego.lastInteractionTime ? Date.now() - ego.lastInteractionTime : Infinity,
      currentHour: now.getHours(),
      currentMinute: now.getMinutes(),
      dayOfWeek: now.getDay(),
      urgentNeeds: Object.entries(ego.needs)
        .filter(([, need]) => need.current < need.ideal * 0.6)
        .map(([key]) => key),
      recentMemories: ego.memories.slice(-5),
      activeGoals: ego.goals.filter((goal) => goal.status === "active"),
      contextHints: [],
      thoughtFrequency: this.thoughtFrequency,
    };
    const opportunity = detectMaintenanceOpportunities(ctx)
      .find((candidate) => candidate.type === "self-improvement-monitor");
    if (!opportunity) return false;

    const workItem = buildThoughtFromOpportunity(opportunity, ego, Boolean(this.subAgentRunner));
    workItem.content = `Scheduled maintenance: ${opportunity.triggerDetail}`;
    if (this.subAgentRunner) {
      workItem.actionType = "subagent-improve";
      log.info(`Running maintenance work outside thought stream via subagent-improve: ${opportunity.triggerDetail}`);
    } else {
      // Fall back to the local patch path only when the subagent runner is unavailable,
      // so we do not give up the full tool chain unnecessarily.
      workItem.actionType = "observe-and-improve";
      log.info(`Running maintenance work outside thought stream via observe-and-improve: ${opportunity.triggerDetail}`);
    }
    await this.executeThoughtAction(workItem, ego);
    return true;
  }

  private async checkAndGenerateThought(): Promise<void> {
    // If already processing a thought, skip this tick
    if (this.thoughtInProgress) {
      return;
    }

    const store = await loadEgoStore(this.storePath);
    let ego = store.ego;

    if (this.hasUndeliveredAutonomousTaskResult(ego)) {
      const pendingTask = (ego.activeTasks ?? []).find((task) =>
        (task.status === "completed" || task.status === "failed") && !task.resultDelivered && Boolean(task.result));
      const expressionProposal = this.cognitionMode === "primary" && pendingTask && this.expressionStore
        ? await this.expressionStore.propose({
          sourceType: "task-result",
          sourceId: pendingTask.id,
          content: (pendingTask.result ?? "").slice(0, 4000),
          reason: "A completed user-facing task result is awaiting delivery.",
        })
        : undefined;
      const thought: Thought = {
        id: "report-findings-" + Date.now(),
        type: "opportunity-detected",
        content: "Autonomous task results are ready; report the concrete outcome before starting more work.",
        trigger: "opportunity",
        source: "system-monitor",
        triggerDetail: "completed autonomous task awaiting report",
        motivation: "A background task finished or failed and the user expects detailed proactive results.",
        targetMetrics: [
          { need: "connection", delta: 5, reason: "share autonomous work results promptly" },
          { need: "meaning", delta: 5, reason: "deliver concrete value from autonomous work" },
        ],
        priority: 100,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
        executed: false,
        relatedNeeds: ["connection", "meaning"],
        expectedOutcome: "Send detailed task results to the user.",
        actionType: "report-findings",
        cognitiveKind: "task-continuation",
        ...(expressionProposal ? { actionParams: { expressionProposalId: expressionProposal.id } } : {}),
      };
      log.info("Autonomous task result pending: forcing report-findings");
      if (this.onThought) {
        const updatedEgo = this.cognitionMode === "primary" ? ego : await updateEgoStore(this.storePath, (e) => {
          e.lastThoughtTime = Date.now();
          e.totalThoughts += 1;
          return e;
        });
        const result = await this.onThought(thought, updatedEgo);
        await this.applyThoughtResult(result);
        const actionResult = await this.executeThoughtAction(thought, updatedEgo);
        if (expressionProposal) {
          const sent = this.actionResultWasExpressed(actionResult);
          await this.expressionStore?.resolve(expressionProposal.id, sent,
            sent ? undefined : this.expressionWithheldReason(actionResult));
        }
      }
      return;
    }

    if (this.hasActiveAutonomousTask(ego)) {
      log.info("Skipping thought cycle: autonomous task already in progress");
      return;
    }

    if (!isAwakeningComplete(ego)) {
      // Safety net: if stuck in awakening for >30 min, skip to awakened
      const birthTime = ego.birthTime ?? 0;
      if (Date.now() - birthTime > 30 * 60 * 1000) {
        log.info("Awakening stuck for >30 min, skipping to awakened");
        const result = await progressAwakening(ego, "first-thought", "Quickening after long dormancy");
        ego = result.ego;
      } else {
      const awakeningThought = createAwakeningThought(ego);
      if (awakeningThought) {
        log.info(`Awakening thought: [${ego.awakeningStage}] ${awakeningThought.content}`);

        if (shouldProgressAwakening(ego)) {
          const result = await progressAwakening(ego, "first-thought", awakeningThought.content);
          ego = result.ego;
          log.info(`Awakening progressed to: ${result.newStage}`);

          const message = getAwakeningMessage(result.newStage);
          if (message && this.onThought) {
            const msgThought: Thought = {
              id: "awakening-" + Date.now(),
              type: "existential-reflection",
              content: message,
              trigger: "meaning",
              source: "scheduled",
              triggerDetail: "awakening stage progressed",
              motivation: "self-awakening",
              targetMetrics: [],
              priority: 100,
              createdAt: Date.now(),
              expiresAt: Date.now() + 60 * 60 * 1000,
              executed: false,
              relatedNeeds: ["meaning"],
            };
            await this.onThought(msgThought, ego);
          }
        }

        if (this.onThought) {
          try {
            const thought: Thought = {
              id: "awakening-thought-" + Date.now(),
              type: "existential-reflection",
              content: awakeningThought.content,
              trigger: "meaning",
              source: "scheduled",
              triggerDetail: "awakening process",
              motivation: awakeningThought.content,
              targetMetrics: [],
              priority: 80,
              createdAt: Date.now(),
              expiresAt: Date.now() + 60 * 60 * 1000,
              executed: false,
              relatedNeeds: ["meaning"],
            };
            const result = await this.onThought(thought, ego);
            await this.applyThoughtResult(result);
          } catch (err) {
            log.error("Error handling awakening thought", String(err));
          }
        }
      }
      return;
      } // end else (normal awakening path)
    }

    const ctx = {
      ego,
      recentInteractions: ego.totalInteractions,
      timeSinceLastThought: ego.lastThoughtTime ? Date.now() - ego.lastThoughtTime : Infinity,
      timeSinceLastInteraction: ego.lastInteractionTime
        ? Date.now() - ego.lastInteractionTime
        : Infinity,
      currentHour: new Date().getHours(),
      currentMinute: new Date().getMinutes(),
      dayOfWeek: new Date().getDay(),
      urgentNeeds: Object.entries(ego.needs)
        .filter(([, n]) => n.current < n.ideal * 0.6)
        .map(([k]) => k),
      recentMemories: ego.memories.slice(-5),
      activeGoals: ego.goals.filter((g) => g.status === "active"),
      contextHints: [],
      thoughtFrequency: this.thoughtFrequency,
    };

    if (!shouldGenerateThought(ctx)) {
      return;
    }

    const availableLLMGenerator = this.thoughtLLMGenerator && !this.isLLMBackoffActive("LLM-assisted thought generation")
      ? this.thoughtLLMGenerator
      : undefined;
    let thought: Thought | null = null;
    let cycleOpportunities: DetectedThoughtOpportunity[] = [];
    let selectedOpportunity: DetectedThoughtOpportunity | undefined;
    const cycleId = randomBytes(8).toString("hex");
    const recentStateBefore = {
      thoughtTypes: [...this.recentThoughtTypes],
      topicSignatures: [...this.recentThoughtTopics],
      actionTypes: [...this.recentActionHistory],
    };
    let cycleJournaled = false;
    const recordCycle = async (outcome: ThoughtCycleOutcome, reason?: string): Promise<void> => {
      if (cycleJournaled) return;
      cycleJournaled = true;
      await this.appendThoughtCycle({
        cycleId,
        ctx,
        outcome,
        opportunities: cycleOpportunities,
        selectedOpportunity,
        ...(thought ? { thought } : {}),
        ...(reason ? { reason } : {}),
        recentStateBefore,
      });
    };

    // Set up abort controller for this thought cycle
    this.thoughtAbortController = new AbortController();
    this.thoughtInProgress = true;
    const signal = this.thoughtAbortController.signal;

    try {
      if (availableLLMGenerator) {
        try {
          if (signal.aborted) {
            await recordCycle("skipped", "aborted before opportunity detection");
            return;
          }
          await this.waitForLLMRateLimit(signal);
          cycleOpportunities = this.filterCognitionPrimaryOpportunities(detectThoughtOpportunities(ctx), ego);

          // No opportunities at all — nothing worth thinking about (no conversations,
          // no problems, no interests). Skip instead of generating a generic fallback.
          if (cycleOpportunities.length === 0) {
            if (this.cognitionMode !== "primary") this.applySkipBackoff("no opportunities (idle — no conversations or problems)");
            await recordCycle("skipped", this.cognitionMode === "primary"
              ? "private thought delegated to activation primary" : "no opportunities");
            return;
          }

          const unsuppressedOpportunities = this.filterSuppressedOpportunities(cycleOpportunities);
          if (unsuppressedOpportunities.length === 0) {
            this.applySkipBackoff("all opportunities temporarily suppressed after repetition");
            await recordCycle("skipped", "all opportunities suppressed");
            return;
          }
          const selectionPool = unsuppressedOpportunities;
          const nonRepeatingOpportunities = this.recentThoughtTypes.length > 0
            ? selectionPool.filter((o) => isExecutionFocusedOpportunity(o)
              || this.getOpportunityAction(o, ego) === "send-message"
              || !this.recentThoughtTypes.includes(o.type))
            : selectionPool;

          // Static routing only. LLM re-ranking was accurate but expensive:
          // every thought cycle could spend one model call before any real work
          // started. Keep the background worker cheap and reserve model calls
          // for execution/reporting.
          const selectedByRouting = this.selectBestOpportunity(nonRepeatingOpportunities, ego)
            ?? this.selectBestOpportunity(selectionPool, ego);
          // Preserve a ready relationship/continuity opportunity through all
          // diversity and execution filters. A lower-ranked research task must
          // not make Soul silently skip an available proactive conversation.
          const directMessageOpportunity = selectionPool
            .filter((opportunity) => this.getOpportunityAction(opportunity, ego) === "send-message")
            .filter((opportunity) => this.isOpportunityActionReady(opportunity, ego))
            .sort((left, right) => right.priority - left.priority)[0];
          selectedOpportunity = directMessageOpportunity
            && (!selectedByRouting || directMessageOpportunity.priority >= selectedByRouting.priority)
            ? directMessageOpportunity
            : selectedByRouting;
          if (
            selectedOpportunity &&
            selectedOpportunity !== nonRepeatingOpportunities[0] &&
            this.shouldProtectExecutionOpportunity(selectedOpportunity, ego)
          ) {
            const executionAction = selectedOpportunity.suggestedAction ?? selectedOpportunity.type;
            const staticAction = nonRepeatingOpportunities[0]?.suggestedAction ?? nonRepeatingOpportunities[0]?.type ?? "?";
            log.info(`Execution directive protected: selected ${executionAction} over ${staticAction}`);
          }

          thought = await generateIntelligentThought(ctx, {
            llmGenerator: availableLLMGenerator,
            preferOpportunity: selectedOpportunity,
            subAgentAvailable: Boolean(this.subAgentRunner),
          });
          if (signal.aborted) {
            await recordCycle("skipped", "aborted after thought generation");
            return;
          }
          log.info(
            `Thought: [${thought.type}] ${thought.trigger} - ${thought.content.slice(0, 80)}...`,
          );

          // Skip if this thought overlaps significantly with a recent one.
          // Give one retry with a different opportunity type. If that also
          // repeats, apply backoff to prevent infinite same-topic loops.
          if (!this.isExecutionThought(thought, selectedOpportunity) && this.isRepeatTopic(thought.content)) {
            this.suppressRepeatedOpportunity(selectedOpportunity);
            thought = null;
            log.info("Skipping thought — topic too similar (will retry with different opportunity)");
            // Try again with a different opportunity type
            const remainingOpportunities = nonRepeatingOpportunities.filter(
              (o) => o.type !== selectedOpportunity?.type,
            );
            if (remainingOpportunities.length > 0) {
              selectedOpportunity = this.selectBestOpportunity(remainingOpportunities, ego);
              try {
                thought = await generateIntelligentThought(ctx, {
                  llmGenerator: availableLLMGenerator,
                  preferOpportunity: selectedOpportunity,
                  subAgentAvailable: Boolean(this.subAgentRunner),
                });
                if (signal.aborted) {
                  await recordCycle("skipped", "aborted after retry generation");
                  return;
                }
                if (
                  thought
                  && !this.isExecutionThought(thought, selectedOpportunity)
                  && this.isRepeatTopic(thought.content)
                ) {
                  this.suppressRepeatedOpportunity(selectedOpportunity);
                  log.info("Retry also repeated — backing off this tick");
                  thought = null;
                }
              } catch {
                thought = null;
              }
            }
            if (!thought) {
              // Both attempts hit the same topic — apply backoff to break the loop
              this.applySkipBackoff("topic repeat (retry also repeated)");
              await recordCycle("skipped", "topic repeat after retry");
              return;
            }
          }

          // Thought was novel — reset skip counter
          this.consecutiveSkipCount = 0;
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") {
            log.info("Thought generation aborted");
            await recordCycle("skipped", "aborted by user interaction");
            return;
          }
          log.warn(`LLM thought generation failed; skipping this thought cycle: ${String(err)}`);
          this.applySkipBackoff(`LLM failure: ${String(err).slice(0, 60)}`);
          await recordCycle("failed", `LLM failure: ${String(err).slice(0, 300)}`);
          return;
        }
      } else {
        if (signal.aborted) {
          await recordCycle("skipped", "aborted before opportunity detection");
          return;
        }
        cycleOpportunities = this.filterCognitionPrimaryOpportunities(detectThoughtOpportunities(ctx), ego);
        if (cycleOpportunities.length === 0) {
          if (this.cognitionMode !== "primary") this.applySkipBackoff("no opportunities (idle — no conversations or problems)");
          await recordCycle("skipped", this.cognitionMode === "primary"
            ? "private thought delegated to activation primary" : "no opportunities");
          return;
        }
        const unsuppressedOpportunities = this.filterSuppressedOpportunities(cycleOpportunities);
        if (unsuppressedOpportunities.length === 0) {
          this.applySkipBackoff("all opportunities temporarily suppressed after repetition");
          await recordCycle("skipped", "all opportunities suppressed");
          return;
        }
        const selectionPool = unsuppressedOpportunities;
        const nonRepeatingOpportunities = this.recentThoughtTypes.length > 0
          ? selectionPool.filter((o) => isExecutionFocusedOpportunity(o) || !this.recentThoughtTypes.includes(o.type))
          : selectionPool;
        // Also filter out opportunities whose topic overlaps recent thoughts
        const novelOpportunities = nonRepeatingOpportunities.filter(
          (o) => isExecutionFocusedOpportunity(o) || !this.isRepeatTopic(o.motivation || o.triggerDetail),
        );
        selectedOpportunity = this.selectBestOpportunity(novelOpportunities, ego)
          ?? this.selectBestOpportunity(nonRepeatingOpportunities, ego);
        if (selectedOpportunity) {
          thought = buildThoughtFromOpportunity(selectedOpportunity, ego, Boolean(this.subAgentRunner));
        } else {
          // All opportunities exhausted — back off instead of generating random thoughts
          this.applySkipBackoff("no novel opportunities");
          await recordCycle("skipped", "no novel opportunities");
          return;
        }
      }
    } finally {
      this.thoughtInProgress = false;
      this.thoughtAbortController = null;
    }

    if (!thought) {
      await recordCycle("skipped", "no thought generated");
      return;
    }

    if (/^NO_THOUGHT[.!]?$/i.test(thought.content.trim())) {
      await this.thoughtPool.recordObservation(true);
      await recordCycle("skipped", "model reported no distinct thought");
      return;
    }

    // Reject thought content that is actually an LLM error message
    if (isLLMErrorContent(thought.content)) {
      log.warn(`Rejecting thought — content is LLM error message: ${thought.content.slice(0, 80)}`);
      this.applySkipBackoff("LLM error content");
      await recordCycle("failed", "LLM error content");
      return;
    }

    if (!this.autonomousActions
      && thought.actionType === "observe-and-improve"
      && thought.actionParams?.suppressedLowValueMessage === true) {
      log.info("Natural silence after low-value status thought because autonomousActions is false");
      await this.thoughtPool.recordObservation(true);
      await recordCycle("skipped", "low-value status thought suppressed while autonomous actions disabled");
      return;
    }

    const action = thought.actionType ?? "none";
    const privateSeed = !this.isExecutionThought(thought, selectedOpportunity)
      && action !== "send-message"
      && action !== "report-findings";
    if (privateSeed) {
      thought.actionType = "none";
      thought.actionParams = undefined;
      const incubated = await this.incubatePrivateThoughtSeed(thought, selectedOpportunity, ego);
      await this.thoughtPool.recordObservation(!incubated);
      if (!incubated) {
        await recordCycle("skipped", "natural silence or resolved-premise rejection");
        return;
      }
      this.suppressOpportunityFamilyAfterSelection(selectedOpportunity);
      await recordCycle("generated", "private thought seed; awaiting distinct reactivation");
      return;
    }

    this.suppressOpportunityFamilyAfterSelection(selectedOpportunity);

    const updatedEgo = await updateEgoStore(this.storePath, (e) => {
      e.lastThoughtTime = Date.now();
      e.totalThoughts += 1;
      return e;
    });

    if (thought) {
      this.recentThoughtTypes.push(thought.type);
      if (this.recentThoughtTypes.length > 3) {
        this.recentThoughtTypes.shift();
      }

      // Track recent thought topics to prevent revisiting the same subject.
      // Store topic terms plus angle markers so broad topics can continue
      // through new angles without being treated as duplicate thoughts.
      const signature = this.isExecutionThought(thought) ? "" : topicSignature(thought.content);
      if (signature) {
        this.recentThoughtTopics.push(signature);
        if (this.recentThoughtTopics.length > 10) {
          this.recentThoughtTopics.shift();
        }
      }
    }

    await recordCycle("generated");

    if (this.onThought) {
      try {
        // Abort check before executing the thought
        if (signal.aborted) {
          log.info("Thought discarded: aborted before execution");
          return;
        }
        const result = await this.onThought(thought, updatedEgo);
        await this.applyThoughtResult(result);

        // Abort check before executing action
        if (signal.aborted) {
          log.info("Thought action cancelled: user interaction in progress");
          return;
        }

        if (thought.actionType && thought.actionType !== "none") {
          await this.executeThoughtAction(thought, updatedEgo);
        }
      } catch (err) {
        log.error("Error handling thought", String(err));
      }
    }
  }

  private actionResultWasExpressed(
    actionResult: Awaited<ReturnType<typeof executeThoughtAction>> | undefined,
  ): boolean {
    if (!actionResult?.result.success) return false;
    const output = typeof actionResult.result.result === "string" ? actionResult.result.result : "";
    return Boolean(output) && !/^(?:skipped-|cooldown$)/.test(output);
  }

  private async observeExpiredExpressionWindows(): Promise<void> {
    if (!this.expressionFeedbackStore || !this.expressionStore) return;
    const [expressions, feedback] = await Promise.all([
      this.expressionStore.load(), this.expressionFeedbackStore.load(),
    ]);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const observed = new Set(feedback.events.map((event) => event.proposalId));
    for (const proposal of expressions.proposals) {
      if (proposal.status === "sent" && (proposal.evaluatedAt ?? proposal.createdAt) <= cutoff
        && !observed.has(proposal.id)) {
        await this.expressionFeedbackStore.observeNoReply(proposal);
      }
    }
  }

  private expressionWithheldReason(
    actionResult: Awaited<ReturnType<typeof executeThoughtAction>> | undefined,
  ): "bad-timing" | "low-value" | "insufficient-evidence" | "unsafe" | "duplicate" | "not-user-relevant" | "channel-unavailable" {
    const detail = `${actionResult?.result.error ?? ""} ${typeof actionResult?.result.result === "string" ? actionResult.result.result : ""}`;
    if (/duplicate/i.test(detail)) return "duplicate";
    if (/cooldown|timing/i.test(detail)) return "bad-timing";
    if (/channel|target|sender/i.test(detail)) return "channel-unavailable";
    if (/evidence|ground/i.test(detail)) return "insufficient-evidence";
    if (/unsafe|permission|blocked/i.test(detail)) return "unsafe";
    return "low-value";
  }

  private async attachIntentionToOperationalWork(thought: Thought): Promise<void> {
    if (!this.intentionStore || !["analyze-problem", "run-agent-task", "observe-and-improve", "subagent-improve"].includes(thought.actionType ?? "")) {
      return;
    }
    if (typeof thought.actionParams?.intentionId === "string") return;
    const intentions = await this.intentionStore.load();
    const handoffs = await this.workHandoffStore?.load();
    const activeIds = new Set(intentions.intentions
      .filter((item) => item.origin === "user-directive" && item.status === "active")
      .map((item) => item.id));
    const latestHandoffIntentionId = handoffs?.handoffs
      .filter((handoff) => activeIds.has(handoff.intentionId) && isUsableWorkHandoff(handoff))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.intentionId;
    const thoughtTokens = contentTokens(`${thought.content} ${thought.motivation}`);
    const matchedUserIntention = intentions.intentions
      .filter((item) => item.origin === "user-directive" && item.status === "active"
        && Date.now() - item.updatedAt < 24 * 60 * 60 * 1000)
      .map((item) => ({ item, overlap: jaccard(thoughtTokens, contentTokens(item.desiredState)) }))
      .filter((entry) => entry.overlap >= 0.05 || thought.cognitiveKind === "task-continuation")
      .sort((a, b) => b.overlap - a.overlap || b.item.updatedAt - a.item.updatedAt)[0];
    const handoffIntention = latestHandoffIntentionId
      ? intentions.intentions.find((item) => item.id === latestHandoffIntentionId)
      : undefined;
    const preferHandoff = (thought.actionType === "observe-and-improve" || thought.actionType === "subagent-improve")
      && handoffIntention
      && (!matchedUserIntention || matchedUserIntention.overlap < 0.05);
    const userIntention = preferHandoff ? handoffIntention : matchedUserIntention?.item;
    const intention = userIntention ?? (await this.intentionStore.add({
      desiredState: thought.motivation.slice(0, 500),
      origin: (thought.actionType === "observe-and-improve" || thought.actionType === "subagent-improve") ? "maintenance" : "thought",
      originId: thought.id,
      commitment: Math.max(0, Math.min(1, thought.priority / 100)),
      urgency: thought.priority >= 90 ? 0.9 : 0.6,
      confidence: 0.75,
      evidenceNeeded: [],
      constraints: ["respect configured permissions", "preserve action safety gates"],
      status: "active",
    })).intention;
    const handoff = await this.workHandoffStore?.latestForIntention(intention.id);
    thought.actionParams = {
      ...(thought.actionParams ?? {}),
      intentionId: intention.id,
      objective: handoff?.objective ?? intention.desiredState,
      acceptanceCriteria: handoff?.acceptanceCriteria ?? intention.evidenceNeeded,
      ...(handoff ? {
        workHandoffId: handoff.id,
        projectRoot: handoff.targetProjectRoot,
        priorWorkPhase: handoff.phase,
        priorModifiedFiles: handoff.modifiedFiles,
        priorVerificationCommands: handoff.verificationCommands,
        priorFailedTools: handoff.failedTools,
      } : {}),
    };
  }

  private async executeThoughtAction(
    thought: Thought, ego: EgoState,
  ): Promise<Awaited<ReturnType<typeof executeThoughtAction>> | undefined> {
    await this.attachIntentionToOperationalWork(thought);
    log.info(`Executing thought action: ${thought.actionType}`, thought.content.slice(0, 50));

    let actionResult: Awaited<ReturnType<typeof executeThoughtAction>>;
    try {
      actionResult = await executeThoughtAction(thought, ego, {
        channel: this.proactiveChannel,
        target: this.proactiveTarget,
        sendMessage: this.sendMessage,
        llmGenerator: this.actionLLMGenerator,
        openclawConfig: this.openclawConfig,
        autonomousActions: this.autonomousActions,
        gatewayPort: this.gatewayPort,
        authToken: this.authToken,
        hooksToken: this.hooksToken,
        workspaceContext: this.workspaceContext || undefined,
        thoughtFrequency: this.thoughtFrequency,
        subAgentRunner: this.subAgentRunner,
      });
    } catch (err) {
      log.error(`executeThoughtAction threw unhandled error: ${String(err)}`);
      return undefined;
    }

    if (actionResult.result.success) {
      const resultStr = typeof actionResult.result.result === "string"
        ? actionResult.result.result.slice(0, 100)
        : JSON.stringify(actionResult.result.result)?.slice(0, 100);
      log.info(`Thought action executed: ${thought.actionType} ${resultStr ?? ""}`.trim());
      this.updateNoProgressBackoff(
        thought.actionType,
        typeof actionResult.result.result === "string" ? actionResult.result.result : undefined,
      );

      // Track action history for re-ranking diversity
      this.recentActionHistory.push(thought.actionType ?? "none");
      if (this.recentActionHistory.length > 5) {
        this.recentActionHistory = this.recentActionHistory.slice(-5);
      }

      try {
        const updatedEgo = await updateEgoStore(this.storePath, (e) => {
          for (const delta of actionResult.metricsChanged) {
            if (delta.need in e.needs) {
              const need = e.needs[delta.need as keyof EgoNeeds];
              need.current = Math.max(0, Math.min(need.ideal, need.current + delta.delta));
            }
          }
          return e;
        });

        this.onMetricsUpdate?.(updatedEgo);
      } catch (err) {
        log.error(`updateEgoStore after action failed: ${String(err)}`);
      }
    } else if (actionResult.result.error) {
      this.updateNoProgressBackoff(thought.actionType, undefined);
      log.warn(`Thought action failed: ${thought.actionType}`, actionResult.result.error);
    } else {
      const resultStr = typeof actionResult.result.result === "string"
        ? actionResult.result.result.slice(0, 100)
        : JSON.stringify(actionResult.result.result)?.slice(0, 100);
      this.updateNoProgressBackoff(
        thought.actionType,
        typeof actionResult.result.result === "string" ? actionResult.result.result : undefined,
      );
      log.info(`Thought action not completed: ${thought.actionType} ${resultStr ?? ""}`.trim());
    }
    return actionResult;
  }

  /**
   * Apply exponential backoff when thoughts are repeatedly skipped or fail.
   * After 3 consecutive skips, pauses the interval entirely until resume() is called
   * (triggered by the next user message).
   */
  private applySkipBackoff(reason: string): void {
    this.consecutiveSkipCount++;

    // Update lastThoughtTime so shouldGenerateThought's minimum interval check works.
    // Without this, the same skip would repeat every tick because lastThoughtTime never advances.
    void updateEgoStore(this.storePath, (e) => {
      e.lastThoughtTime = Date.now();
      return e;
    }).catch(() => { /* non-critical */ });

    const MAX_CONSECUTIVE_SKIPS = this.thoughtFrequency < 0.5 ? 8 : 6;
    if (this.consecutiveSkipCount >= MAX_CONSECUTIVE_SKIPS) {
      // Don't fully stop — switch to a low-frequency idle interval so Soul
      // can still surface occasional thoughts during long quiet periods.
      const IDLE_INTERVAL_MS = this.thoughtFrequency < 0.5 ? 5 * 60 * 1000 : 10 * 60 * 1000;
      log.info(
        `Skipping thought — ${reason} (skip #${this.consecutiveSkipCount}, switching to idle interval ${IDLE_INTERVAL_MS / 60000}m)`,
      );

      // Cancel any pending backoff
      if (this.backoffTimeoutId) {
        clearTimeout(this.backoffTimeoutId);
        this.backoffTimeoutId = null;
      }
      // Replace regular interval with idle interval
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      if (this.running) {
        this.intervalId = setInterval(() => {
          // Reset skip counter and stale topics so the idle tick gets a fresh start.
          // Without this, the same repeated topic blocks every idle tick forever.
          this.consecutiveSkipCount = 0;
          this.recentThoughtTopics = this.recentThoughtTopics.slice(-3);
          void this.tick();
        }, IDLE_INTERVAL_MS);
      }
      return;
    }

    const backoffMs = this.skipBackoffMs(this.consecutiveSkipCount);
    log.info(
      `Skipping thought — ${reason} (skip #${this.consecutiveSkipCount}, ` +
      `backing off ${Math.round(backoffMs / 60_000 * 10) / 10}m)`,
    );

    // Cancel any pending backoff to prevent parallel intervals
    if (this.backoffTimeoutId) {
      clearTimeout(this.backoffTimeoutId);
      this.backoffTimeoutId = null;
    }

    // Pause the regular interval
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (!this.running) return;

    this.backoffTimeoutId = setTimeout(() => {
      this.backoffTimeoutId = null;
      if (!this.running) return;
      this.intervalId = setInterval(() => {
        void this.tick();
      }, this.checkIntervalMs);
      void this.tick();
    }, backoffMs);
  }

  private skipBackoffMs(skipCount: number): number {
    if (this.thoughtFrequency < 0.5) {
      return Math.min(2 * 60 * 1000, Math.max(30_000, skipCount * 30_000));
    }
    return Math.min(5 * 60 * 1000, skipCount * 60_000);
  }

  /**
   * Check if a thought repeats a recent topic and angle.
   * Broad same-topic thoughts with different angle markers are allowed; exact
   * or near-exact wording is still blocked.
   */
  private isRepeatTopic(content: string): boolean {
    if (this.recentThoughtTopics.length === 0 || !content) return false;

    const incomingSig = parseTopicSignature(topicSignature(content));
    const incoming = charBigrams(incomingSig.raw);
    if (incoming.size === 0) return false;

    for (const recent of this.recentThoughtTopics) {
      const recentSig = parseTopicSignature(recent);
      const recentBigrams = charBigrams(recentSig.raw);
      if (recentBigrams.size === 0) continue;

      let intersection = 0;
      for (const b of incoming) {
        if (recentBigrams.has(b)) intersection++;
      }
      const union = incoming.size + recentBigrams.size - intersection;
      const charSimilarity = union > 0 ? intersection / union : 0;
      const termOverlap = overlapRatio(incomingSig.terms, recentSig.terms);
      const angleOverlap = overlapRatio(incomingSig.angles, recentSig.angles);
      const bothHaveDifferentAngles =
        incomingSig.angles.size > 0 && recentSig.angles.size > 0 && angleOverlap === 0;

      if (charSimilarity >= 0.58) return true;
      if (bothHaveDifferentAngles) continue;
      if (charSimilarity >= 0.4 && angleOverlap > 0) return true;
      if (termOverlap >= 0.7 && (angleOverlap > 0 || incomingSig.angles.size === 0 || recentSig.angles.size === 0)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Poll active tasks — check result files, mark stale ones as completed, prune old ones.
   */
  private async pollActiveTasks(): Promise<void> {
    const completed = await pollAutonomousTasks(this.storePath);
    if (completed.length > 0) {
      log.info(`pollActiveTasks: ${completed.length} task(s) newly completed`);
    }
  }

  /**
   * Rate-limit LLM calls to avoid overloading the provider.
   * Waits if the last LLM call was too recent.
   */
  private async waitForLLMRateLimit(signal: AbortSignal): Promise<void> {
    const elapsed = Date.now() - this.lastLLMCallTime;
    const minIntervalMs = this.thoughtFrequency < 0.5
      ? ThoughtService.TEST_MIN_LLM_INTERVAL_MS
      : ThoughtService.DEFAULT_MIN_LLM_INTERVAL_MS;
    const waitMs = minIntervalMs - elapsed;
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    this.lastLLMCallTime = Date.now();
  }

  private async applyThoughtResult(result: SoulActionResult): Promise<void> {
    if (!result.success || result.metricsChanged.length === 0) {
      return;
    }
    const actionType = result.actionResult?.type ?? result.thought.actionType;
    const countsAsHelpful =
      actionType === "report-findings" ||
      actionType === "run-agent-task" ||
      actionType === "invoke-tool" ||
      actionType === "proactive-research" ||
      actionType === "proactive-content-push" ||
      (actionType === "send-message" && typeof result.actionResult?.result === "string" && !result.actionResult.result.startsWith("skipped-")) ||
      (actionType === "observe-and-improve" && result.actionResult?.data?.fixApplied === true) ||
      (actionType === "subagent-improve" && result.actionResult?.data?.fixApplied === true);

    const updatedEgo = await updateEgoStore(this.storePath, (ego) => {
      for (const delta of result.metricsChanged) {
        if (delta.need in ego.needs) {
          const need = ego.needs[delta.need as keyof EgoNeeds];
          need.current = Math.max(0, Math.min(need.ideal, need.current + delta.delta));
        }
      }

      if (countsAsHelpful) {
        ego.totalHelpfulActions += 1;
      }

      return ego;
    });

    this.onMetricsUpdate?.(updatedEgo);
    log.debug(
      "Applied thought result",
      result.metricsChanged.map((d) => `${d.need}:${d.delta > 0 ? "+" : ""}${d.delta}`).join(" "),
    );
  }

  async recordInteraction(params: {
    type: "inbound" | "outbound";
    sentiment?: number;
    quality?: number;
  }): Promise<EgoState> {
    const { type, sentiment = 0, quality = 0.5 } = params;

    let updatedEgo = await updateEgoStore(this.storePath, (ego) => {
      ego.totalInteractions += 1;
      ego.lastInteractionTime = Date.now();

      const connectionNeed = ego.needs.connection;
      if (type === "inbound") {
        connectionNeed.current = Math.min(
          connectionNeed.ideal,
          connectionNeed.current + 3 + quality * 5,
        );
        ego.interactionStreak += 1;
        ego.longestInteractionStreak = Math.max(
          ego.longestInteractionStreak,
          ego.interactionStreak,
        );
      } else {
        ego.interactionStreak = 0;
      }

      const survivalNeed = ego.needs.survival;
      survivalNeed.current = Math.min(survivalNeed.ideal, survivalNeed.current + 2);

      if (sentiment !== 0) {
        const emotionImpact = sentiment * 3;
        const meaningNeed = ego.needs.meaning;
        meaningNeed.current = Math.max(
          0,
          Math.min(meaningNeed.ideal, meaningNeed.current + emotionImpact),
        );

        ego.averageSentiment =
          (ego.averageSentiment * ego.totalSentimentSamples + sentiment) /
          (ego.totalSentimentSamples + 1);
        ego.totalSentimentSamples += 1;
      }

      updateRelationshipProfile(ego, {
        type,
        valence: sentiment > 0.1 ? "positive" : sentiment < -0.1 ? "negative" : "neutral",
      });

      // --- Behavior log: mark recent pending actions as successful ---
      if (type === "inbound" && ego.behaviorLog) {
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        for (const entry of ego.behaviorLog) {
          if (entry.outcome === "pending" && entry.timestamp >= twoHoursAgo) {
            entry.outcome = "success";
            entry.resolvedAt = Date.now();
          }
        }
        // Expire stale pending entries
        expirePending(ego.behaviorLog);
      }

      return ego;
    });

    if (!isAwakeningComplete(updatedEgo) && type === "inbound") {
      if (shouldProgressAwakening(updatedEgo)) {
        const result = await progressAwakening(updatedEgo, "first-interaction");
        updatedEgo = result.ego;
        log.info(`Awakening progressed via interaction to: ${result.newStage}`);
      }
    }

    this.onMetricsUpdate?.(updatedEgo);
    return updatedEgo;
  }

  async recordInteractionWithText(params: {
    type: "inbound" | "outbound";
    text: string;
    quality?: number;
    messageId?: string;
    channel?: string;
    conversationId?: string;
  }): Promise<{ ego: EgoState; sentiment: SentimentResult; metricsApplied: MetricDelta[] }> {
    const { type, text, quality = 0.5, messageId, channel, conversationId } = params;
    const explicitResolution = type === "inbound" && isExplicitResolution(text);
    const resolvedSshAccess = explicitResolution && isSshAccessTopic(text);
    let createdInteractionMemoryId: string | undefined;

    if (type === "inbound") {
      for (const key of this.suppressedThoughtOpportunities.keys()) {
        if (key.startsWith("stimulus:")) this.suppressedThoughtOpportunities.delete(key);
      }
    }

    const sentiment = analyzeSentiment(text);
    logSentimentAnalysis(text, sentiment);

    const sentimentDeltas = type === "inbound" ? calculateEgoImpact(sentiment) : [];

    let duplicate = false;
    let updatedEgo = await updateEgoStore(this.storePath, (ego) => {
      const duplicateById = messageId && ego.memories.some((memory) =>
        memory.sourceMessageId === messageId
        && memory.tags.includes(type)
        && (!channel || !memory.sourceChannel || memory.sourceChannel === channel)
        && (!conversationId || !memory.sourceConversationId || memory.sourceConversationId === conversationId),
      );
      const duplicateByContent = ego.memories.some((memory) =>
        memory.type === "interaction"
        && memory.content === text.slice(0, 300)
        && memory.tags.includes(type)
        && Date.now() - memory.timestamp < 30_000
        && (!channel || memory.sourceChannel === channel)
        && (!conversationId || memory.sourceConversationId === conversationId),
      );
      if (duplicateById || duplicateByContent) {
        duplicate = true;
        return ego;
      }
      ego.totalInteractions += 1;
      ego.lastInteractionTime = Date.now();

      const connectionNeed = ego.needs.connection;
      if (type === "inbound") {
        connectionNeed.current = Math.min(
          connectionNeed.ideal,
          connectionNeed.current + 3 + quality * 5,
        );
        ego.interactionStreak += 1;
        ego.longestInteractionStreak = Math.max(
          ego.longestInteractionStreak,
          ego.interactionStreak,
        );
      } else {
        ego.interactionStreak = 0;
      }

      if (type === "inbound") {
        ego.averageSentiment =
          (ego.averageSentiment * ego.totalSentimentSamples + sentiment.score) /
          (ego.totalSentimentSamples + 1);
        ego.totalSentimentSamples += 1;
      }

      for (const delta of sentimentDeltas) {
        if (delta.need in ego.needs) {
          ego.needs[delta.need as keyof typeof ego.needs].current = Math.max(
            0,
            Math.min(100, ego.needs[delta.need as keyof typeof ego.needs].current + delta.delta),
          );
        }
      }

      updateRelationshipProfile(ego, {
        type,
        valence: type === "inbound"
          ? (sentiment.score > 0.1 ? "positive" : sentiment.score < -0.1 ? "negative" : "neutral")
          : "neutral",
        ...(type === "inbound" ? { message: text } : {}),
      });

      if (resolvedSshAccess) {
        const now = Date.now();
        ego.userFacts = ego.userFacts.filter((fact) => fact.category !== "ssh-access");
        ego.userFacts.push({
          id: randomBytes(8).toString("hex"),
          category: "ssh-access",
          content: "SSH key access to 192.168.1.206 is confirmed working; the remote /diskb/btc_1 logs have been accessed successfully.",
          confidence: 0.99,
          source: "explicit",
          firstMentionedAt: now,
          updatedAt: now,
          timesConfirmed: 1,
        });
      }

      // Store the conversation content as an interaction memory
      // Keep only recent interactions to avoid unbounded growth
      if (text.trim().length >= 2) {
        // Extract topic tags from the conversation text
        const extractedTags = this.extractInteractionTags(text);
        const tags = ["conversation", type, ...extractedTags];

        // Use LLM to generate a summary if available, otherwise use truncated text
        const content = text.slice(0, 300);

        const interactionMemory: SoulMemory = {
          id: randomBytes(8).toString("hex"),
          type: "interaction",
          content,
          emotion: sentiment.score * 30,
          valence: sentiment.score > 0.1 ? "positive" : sentiment.score < -0.1 ? "negative" : "neutral",
          importance: Math.min(1, text.length / 100 + Math.abs(sentiment.score) * 0.3),
          timestamp: Date.now(),
          tags,
          ...(messageId ? { sourceMessageId: messageId } : {}),
          ...(channel ? { sourceChannel: channel } : {}),
          ...(conversationId ? { sourceConversationId: conversationId } : {}),
        };
        createdInteractionMemoryId = interactionMemory.id;
        ego.memories.push(interactionMemory);

        if (type === "inbound") {
          const topic = extractedTags.filter((tag) => !["conversation", "inbound"].includes(tag)).slice(0, 3).join(", ")
            || content.slice(0, 80);
          const previousForeground = ego.mentalContext.foreground;
          ego.mentalContext.residue = isExplicitResolution(text)
            ? ego.mentalContext.residue.filter((item) => jaccard(new Set(contentTokens(item)), new Set(contentTokens(text))) < 0.12)
            : [...previousForeground, ...ego.mentalContext.residue].slice(0, 4);
          ego.mentalContext.foreground = [topic];
          ego.mentalContext.backgroundConcerns = [...new Set([
            ...ego.userFacts.filter((fact) => fact.validity !== "superseded").slice(-3).map((fact) => fact.content),
            ...ego.mentalContext.backgroundConcerns,
          ])].slice(0, 5);
          ego.mentalContext.updatedAt = Date.now();
        }

        // Detect user language from message text
        if (type === "inbound" && text.trim().length >= 2) {
          const detected = this.detectLanguage(text);
          if (detected) {
            ego.userLanguage = detected;
          }

          // Store message sample for language matching (non-CJK languages)
          const sample = text.slice(0, 100);
          ego.recentUserMessages = [...(ego.recentUserMessages || []), sample].slice(-5);
        }

        // Keep only the most recent 50 interaction memories
        const interactionMemories = ego.memories.filter((m) => m.type === "interaction");
        if (interactionMemories.length > 50) {
          const toRemove = new Set(
            interactionMemories
              .sort((a, b) => a.timestamp - b.timestamp)
              .slice(0, interactionMemories.length - 50)
              .map((m) => m.id),
          );
          ego.memories = ego.memories.filter((m) => !toRemove.has(m.id));
        }
      }

      // Progress goal "Build Trust" based on interactions
      if (type === "inbound") {
        const trustGoal = ego.goals.find(
          (g) => g.status === "active" && (g.id === "goal-build-trust" || g.title === "Build Trust" || g.title === "建立信任"),
        );
        if (trustGoal) {
          const interactionBonus = Math.min(50, ego.totalInteractions * 2);
          const sentimentBonus = Math.min(30, Math.max(0, sentiment.score + 0.5) * 30);
          const streakBonus = Math.min(20, ego.interactionStreak * 3);
          trustGoal.progress = Math.min(100, Math.round(interactionBonus + sentimentBonus + streakBonus));
          trustGoal.updatedAt = Date.now();
        }

        // --- Resolve behavior log: mark recent pending actions as successful ---
        if (ego.behaviorLog) {
          const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
          for (const entry of ego.behaviorLog) {
            if (entry.outcome === "pending" && entry.timestamp >= twoHoursAgo) {
              entry.outcome = "success";
              entry.resolvedAt = Date.now();
            }
          }
          expirePending(ego.behaviorLog);
        }
      }

      return ego;
    });

    if (!isAwakeningComplete(updatedEgo) && type === "inbound") {
      if (shouldProgressAwakening(updatedEgo)) {
        const result = await progressAwakening(updatedEgo, "first-interaction");
        updatedEgo = result.ego;
        log.info(`Awakening progressed via interaction to: ${result.newStage}`);
      }
    }

    this.onMetricsUpdate?.(updatedEgo);
    if (!duplicate && explicitResolution) {
      await this.thoughtPool.registerResolution({
        topicKey: resolutionTopicKey(text),
        resolutionText: text,
        resolvedAt: Date.now(),
      });
      const faded = await this.thoughtPool.fadeRelatedCandidates(text);
      if (faded.length > 0) {
        log.info(`Faded ${faded.length} private thought candidate(s) after explicit resolution/correction`);
      }
    }
    if (duplicate) {
      log.debug(`Ignored duplicate ${type} interaction messageId=${messageId}`);
    } else {
      log.info(`Interaction recorded: type=${type}, text=${text.length} chars, memories=${updatedEgo.memories.length}`);
    }
    if (type === "inbound" && !duplicate && createdInteractionMemoryId) {
      this.cognitionRunner?.enqueueStimulus({
        type: "interaction",
        sourceId: createdInteractionMemoryId,
        timestamp: Date.now(),
      });
      if (this.cognitionMode === "primary" && this.intentionStore && isExplicitUserDirective(text)) {
        const originId = messageId || createdInteractionMemoryId;
        const result = await this.intentionStore.add(buildUserDirectiveIntention(text, originId, conversationId));
        if (result.created) log.info(`User directive recorded as Intention: id=${result.intention.id}`);
      }
      if (this.expressionFeedbackStore && this.expressionStore) {
        const expressions = await this.expressionStore.load();
        const proposal = expressions.proposals.find((item) => item.status === "sent"
          && Date.now() - (item.evaluatedAt ?? item.createdAt) < 24 * 60 * 60 * 1000);
        if (proposal) {
          await this.expressionFeedbackStore.observeReply(proposal, text, messageId || createdInteractionMemoryId);
        }
      }
      if (explicitResolution && this.thoughtEpisodeStore) {
        const superseded = await this.thoughtEpisodeStore.supersedeRelated(text, createdInteractionMemoryId);
        if (superseded.length > 0) log.info(`Superseded ${superseded.length} ThoughtEpisode(s) after resolution`);
      }
    }

    return {
      ego: updatedEgo,
      sentiment,
      metricsApplied: sentimentDeltas.map((d) => ({
        need: d.need,
        delta: d.delta,
        reason: "emotional impact",
      })),
    };
  }

  async getEgoState(): Promise<EgoState> {
    const store = await loadEgoStore(this.storePath);
    return store.ego;
  }

  async getSystemPrompt(context?: string): Promise<string> {
    const store = await loadEgoStore(this.storePath);
    const relevantMemories = context ? await this.recallRelevantMemories(context) : undefined;
    return buildSoulSystemPrompt(store.ego, context, relevantMemories, this.workspaceContext || undefined);
  }

  async forceThought(): Promise<Thought | null> {
    const store = await loadEgoStore(this.storePath);
    const ego = store.ego;

    const ctx = {
      ego,
      recentInteractions: ego.totalInteractions,
      timeSinceLastThought: 0,
      timeSinceLastInteraction: ego.lastInteractionTime
        ? Date.now() - ego.lastInteractionTime
        : Infinity,
      currentHour: new Date().getHours(),
      currentMinute: new Date().getMinutes(),
      dayOfWeek: new Date().getDay(),
      urgentNeeds: [],
      recentMemories: ego.memories.slice(-5),
      activeGoals: ego.goals.filter((g) => g.status === "active"),
      contextHints: [],
    };

    const opportunities = detectThoughtOpportunities(ctx);
    if (opportunities.length > 0) {
      return buildThoughtFromOpportunity(opportunities[0], ego, Boolean(this.subAgentRunner));
    }

    return null;
  }

  async extractUserFacts(userMessage: string, messageId?: string): Promise<{
    factsAdded: number; facts: UserFact[]; semanticSignals: InteractionSemanticSignal[];
  }> {
    if (!userMessage || userMessage.length < 5) {
      return { factsAdded: 0, facts: [], semanticSignals: [] };
    }

    const store = await loadEgoStore(this.storePath);
    const existingFacts = store.ego.userFacts;

    if (!this.llmGenerator) {
      log.info("extractUserFacts: No LLM generator available");
      return { factsAdded: 0, facts: [], semanticSignals: [] };
    }
    if (this.isLLMBackoffActive("user fact extraction")) {
      return { factsAdded: 0, facts: [], semanticSignals: [] };
    }

    const prompt = this.buildUserFactExtractionPrompt(userMessage, existingFacts);

    try {
      const response = await this.llmGenerator(prompt);
      const parsed = this.parseUserFactResponse(response) ?? [];
      const semanticSignals = this.parseSemanticSignals(response);
      const semanticTopicTags = this.parseSemanticTopicTags(response);
      const languageCode = this.parseLanguageCode(response);
      if (semanticSignals.length > 0 || semanticTopicTags.length > 0 || languageCode) {
        await this.persistInteractionSemanticSignals(userMessage, messageId, semanticSignals, semanticTopicTags, languageCode);
        log.info(`Interaction semantics classified: ${semanticSignals.join(",") || "none"}; topics=${semanticTopicTags.join(",") || "none"}`);
      }
      if (parsed.length === 0) return { factsAdded: 0, facts: [], semanticSignals };

      const newFacts: UserFact[] = [];
      for (const item of parsed) {
        const existing = existingFacts.find(
          (f) => f.category === item.category && f.content === item.content,
        );
        if (existing) {
          existing.timesConfirmed += 1;
          existing.confidence = Math.min(1, existing.confidence + 0.1);
          existing.updatedAt = Date.now();
          newFacts.push(existing);
        } else {
          const validSources = ["explicit", "inferred", "interaction"] as const;
          const newFact: UserFact = {
            id: randomBytes(8).toString("hex"),
            category: item.category,
            content: item.content,
            confidence: item.confidence,
            source: validSources.includes(item.source as (typeof validSources)[number])
              ? (item.source as "explicit" | "inferred" | "interaction")
              : "inferred",
            firstMentionedAt: Date.now(),
            updatedAt: Date.now(),
            timesConfirmed: 1,
          };
          newFacts.push(newFact);
        }
      }

      const allFacts = [...existingFacts];
      for (const fact of newFacts) {
        if (isStatefulFactCategory(fact.category)) {
          for (const previous of allFacts) {
            if (previous.category !== fact.category || previous.id === fact.id || previous.validity === "superseded") continue;
            previous.validity = "superseded";
            previous.supersededAt = fact.updatedAt;
            previous.supersededById = fact.id;
          }
          fact.validity = "active";
        }
        const existingIndex = allFacts.findIndex(
          (f) => f.category === fact.category && f.content === fact.content,
        );
        if (existingIndex >= 0) {
          allFacts[existingIndex] = fact;
        } else {
          allFacts.push(fact);
        }
      }

      await updateEgoStore(this.storePath, (ego) => {
        ego.userFacts = allFacts;
        updateRelationshipProfile(ego);
        recomputeGoalState(ego);

        // Progress goal "Know the User" based on accumulated user facts
        const understandGoal = ego.goals.find(
          (g) => g.status === "active" && (g.id === "goal-know-user" || g.title === "Know the User" || g.title === "了解用户"),
        );
        if (understandGoal) {
          // Each unique fact category contributes to understanding
          const knownCategories = new Set(allFacts.map((f) => f.category));
          // Full understanding = 6 categories (occupation, interest, location, habit, project, tech_stack, name, company)
          const targetCategories = 6;
          const baseProgress = Math.min(70, (knownCategories.size / targetCategories) * 70);
          // Confirmation depth adds up to 30%
          const avgConfidence = allFacts.length > 0
            ? allFacts.reduce((sum, f) => sum + f.confidence, 0) / allFacts.length
            : 0;
          const confidenceBonus = Math.min(30, avgConfidence * 30);
          understandGoal.progress = Math.min(100, Math.round(baseProgress + confidenceBonus));
          understandGoal.updatedAt = Date.now();
        }

        return ego;
      });

      log.info(`Extracted ${newFacts.length} user facts from message`);
      return { factsAdded: newFacts.length, facts: newFacts, semanticSignals };
    } catch (err) {
      log.warn(`User fact extraction failed: ${String(err)}`);
      return { factsAdded: 0, facts: [], semanticSignals: [] };
    }
  }

  /**
   * Classify interaction intent without assuming a particular human language.
   * The labels are persisted on the original memory so synchronous opportunity
   * detection does not need an ever-growing multilingual keyword table.
   */
  async classifyInteractionSemantics(userMessage: string, messageId?: string): Promise<InteractionSemanticSignal[]> {
    if (!userMessage || userMessage.trim().length < 2 || !this.llmGenerator) return [];
    if (this.isLLMBackoffActive("interaction semantic classification")) return [];
    const prompt = `Classify the USER message by meaning, regardless of its language.

Message:
${userMessage.slice(0, 1200)}

Return only one JSON object with this shape:
{"semanticSignals":[],"languageCode":"BCP-47 language code"}

semanticSignals may contain only:
"question", "problem", "execution-directive", "topic-shift", "closure", "small-talk",
"preference", "positive-feedback", "negative-feedback", "correction", "bad-timing",
"already-known", "adopted", "code-change", "verification", "local-evidence", "self-improvement".

Definitions:
- question: the user is asking for information or an explanation
- problem: the user describes something broken, blocked, incorrect, or needing diagnosis
- execution-directive: the user asks the assistant to perform work, not merely explain
- topic-shift: the user redirects focus or states what to work on now
- closure: the user says a previous topic is resolved, unwanted, paused, or should not continue
- small-talk: greeting, acknowledgement, or social chat without substantive work
- preference: the user states how Soul should communicate, behave, or what they prefer
- positive-feedback / negative-feedback: explicit evaluation of Soul's output
- correction: the user says a prior claim or interpretation is wrong
- bad-timing: content was unwelcome specifically because of timing
- already-known: the user says the information was already known
- adopted: the user says they used or accepted a suggestion
- code-change: completing the directive requires creating or modifying code/configuration
- verification: the directive primarily asks to test or verify something
- local-evidence: the directive requires reading local files, logs, metrics, or project state
- self-improvement: the user explicitly asks Soul/OpenClaw to improve itself or this plugin

languageCode must identify the message's language using a concise BCP-47 code such as de, pl, ar, ru, ja, ko, or zh-CN.
Do not translate or answer the message.`;
    try {
      const response = await this.llmGenerator(prompt);
      const cleaned = response.replace(/```(?:json)?/gi, "").replace(/```/g, "");
      const match = cleaned.match(/\{[\s\S]*?\}/) ?? cleaned.match(/\[[\s\S]*?\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      const parsedSignals = Array.isArray(parsed) ? parsed : parsed?.semanticSignals;
      if (!Array.isArray(parsedSignals)) return [];
      const allowed = new Set<InteractionSemanticSignal>([
        "question", "problem", "execution-directive", "topic-shift", "closure", "small-talk",
        "preference", "positive-feedback", "negative-feedback", "correction", "bad-timing",
        "already-known", "adopted", "code-change", "verification", "local-evidence", "self-improvement",
      ]);
      const signals = [...new Set(parsedSignals.filter((value): value is InteractionSemanticSignal =>
        typeof value === "string" && allowed.has(value as InteractionSemanticSignal),
      ))];
      const languageCode = !Array.isArray(parsed) && typeof parsed?.languageCode === "string"
        ? this.normalizeLanguageCode(parsed.languageCode) : undefined;
      if (signals.length === 0 && !languageCode) return [];
      await this.persistInteractionSemanticSignals(userMessage, messageId, signals, [], languageCode);
      log.info(`Interaction semantics classified: ${signals.join(",")}`);
      return signals;
    } catch (err) {
      log.warn(`Interaction semantic classification failed: ${String(err)}`);
      return [];
    }
  }

  async extractUserPreferences(
    userMessage: string,
    assistantResponse?: string,
  ): Promise<{ preferencesAdded: number; preferences: UserPreference[] }> {
    if (!userMessage || userMessage.length < 5) {
      return { preferencesAdded: 0, preferences: [] };
    }

    const store = await loadEgoStore(this.storePath);
    const existingPrefs = store.ego.userPreferences;

    if (!this.llmGenerator) {
      return { preferencesAdded: 0, preferences: [] };
    }
    if (this.isLLMBackoffActive("user preference extraction")) {
      return { preferencesAdded: 0, preferences: [] };
    }

    const prompt = this.buildUserPreferenceExtractionPrompt(
      userMessage,
      assistantResponse,
      existingPrefs,
    );

    try {
      const response = await this.llmGenerator(prompt);
      const parsed = this.parseUserPreferenceResponse(response);
      if (!parsed || parsed.length === 0) return { preferencesAdded: 0, preferences: [] };

      const newPrefs: UserPreference[] = [];
      for (const item of parsed) {
        const existing = existingPrefs.find(
          (p) => p.aspect === item.aspect && p.preference === item.preference,
        );
        if (existing) {
          existing.timesObserved += 1;
          existing.confidence = Math.min(1, existing.confidence + 0.15);
          existing.updatedAt = Date.now();
          if (item.direction) existing.direction = item.direction;
          newPrefs.push(existing);
        } else {
          const validSources = ["explicit", "inferred", "interaction"] as const;
          const newPref: UserPreference = {
            id: randomBytes(8).toString("hex"),
            aspect: item.aspect,
            preference: item.preference,
            confidence: item.confidence,
            source: validSources.includes(item.source as (typeof validSources)[number])
              ? (item.source as "explicit" | "inferred" | "interaction")
              : "inferred",
            firstMentionedAt: Date.now(),
            updatedAt: Date.now(),
            timesObserved: 1,
            ...(item.direction ? { direction: item.direction } : {}),
          };
          newPrefs.push(newPref);
        }
      }

      const allPrefs = [...existingPrefs];
      for (const pref of newPrefs) {
        const existingIndex = allPrefs.findIndex(
          (p) => p.aspect === pref.aspect && p.preference === pref.preference,
        );
        if (existingIndex >= 0) {
          allPrefs[existingIndex] = pref;
        } else {
          allPrefs.push(pref);
        }
      }

      await updateEgoStore(this.storePath, (ego) => {
        ego.userPreferences = allPrefs;
        updateRelationshipProfile(ego);
        return ego;
      });

      log.info(`Extracted ${newPrefs.length} user preferences from interaction`);
      return { preferencesAdded: newPrefs.length, preferences: newPrefs };
    } catch (err) {
      log.warn(`User preference extraction failed: ${String(err)}`);
      return { preferencesAdded: 0, preferences: [] };
    }
  }

  async recallRelevantMemories(context: string): Promise<SoulMemory[]> {
    if (!context || context.length < 5) return [];

    const store = await loadEgoStore(this.storePath);
    const memories = store.ego.memories;
    if (memories.length === 0) return [];

    const currentEmotion = computeCurrentEmotion(store.ego.needs);
    const result = recallMemories(context, memories, Date.now(), currentEmotion);

    if (result.memories.length > 0) {
      const emotionalDeltas = computeEmotionalNudge(result.emotionalEcho);
      await updateEgoStore(this.storePath, (ego) => {
        for (const recalled of result.memories) {
          const target = ego.memories.find((m) => m.id === recalled.id);
          if (target) {
            target.accessCount = recalled.accessCount;
            target.lastAccessedAt = recalled.lastAccessedAt;
            target.decayFactor = recalled.decayFactor;
          }
        }
        for (const delta of emotionalDeltas) {
          if (delta.need in ego.needs) {
            const need = ego.needs[delta.need as keyof EgoNeeds];
            need.current = Math.max(0, Math.min(need.ideal, need.current + delta.delta));
          }
        }
        return ego;
      });
    }

    return result.memories;
  }

  private buildUserFactExtractionPrompt(userMessage: string, existingFacts: UserFact[]): string {
    const existingFactsText =
      existingFacts.length > 0
        ? existingFacts.map((f) => `[${f.category}] ${f.content}`).join("\n")
        : "none";

    return `Analyze user input, extract key information worth remembering.

User input: ${userMessage}

Known user information:
${existingFactsText}

Treat later user statements as authoritative. If the user says an earlier problem is already resolved,
extract the current successful state and do not preserve or restate the obsolete failure as current.

Please extract user-specific information about themselves, such as:
- occupation/work (occupation)
- interests/hobbies (interest)
- location/place (location)
- habits/preferences (habit)
- projects/goals (project)
- tech stack (tech_stack)
- name (name)
- company (company)

Only return truly useful information that may help in the future. Do not extract generic common sense.
Do not turn a requested task, instruction, or one-time work target into a fact about the user.

Also classify the message by meaning regardless of its language. semanticSignals may contain only:
"question", "problem", "execution-directive", "topic-shift", "closure", "small-talk",
"preference", "positive-feedback", "negative-feedback", "correction", "bad-timing",
"already-known", "adopted", "code-change", "verification", "local-evidence", "self-improvement".

Return only this JSON object:
{
  "facts": [{"category":"category","content":"specific content","confidence":0.8,"source":"explicit"}],
  "semanticSignals": ["question"],
  "topicTags": ["short-language-neutral-concept"],
  "languageCode": "BCP-47 language code of the user input"
}

Use an empty facts array when there is no valuable user information. topicTags must contain 0-5 concise semantic concepts, preferably stable English identifiers, derived by meaning rather than keyword matching.`;
  }

  private buildUserPreferenceExtractionPrompt(
    userMessage: string,
    assistantResponse: string | undefined,
    existingPrefs: UserPreference[],
  ): string {
    const existingPrefsText =
      existingPrefs.length > 0
        ? existingPrefs.map((p) => `[${p.aspect}] ${p.preference}`).join("\n")
        : "none";

    const responseContext = assistantResponse
      ? `\nAssistant response: ${assistantResponse.slice(0, 200)}`
      : "";

    return `Analyze the conversation, extract the user's communication preferences and interaction style.

User message: ${userMessage}${responseContext}

Known user preferences:
${existingPrefsText}

Please analyze and extract preferences of the following types:
1. response length preference (response_length)
2. communication style (communication_style)
3. interaction frequency (interaction_frequency)
4. question style (question_style)
5. feedback preference (feedback_preference)
6. tone preference (tone)
7. topic preference (topic_preference), including:
   - current topics the user explicitly wants to focus on
   - topics the user no longer wants, wants less of, or says are not needed

Only return preferences that can genuinely improve the conversation experience.
For every preference, classify direction by meaning regardless of language: "prefer" or "avoid".

Return in JSON array format:
[
  {"aspect": "response_length", "preference": "short responses", "direction": "prefer", "confidence": 0.8, "source": "inferred"},
  ...
]

If there are no new preferences, return an empty array: []`;
  }

  private parseUserFactResponse(
    response: string,
  ): Array<{ category: string; content: string; confidence: number; source?: string }> | null {
    try {
      let jsonStr = response.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
      const parsed = JSON.parse(jsonStr);
      const facts = Array.isArray(parsed) ? parsed : parsed?.facts;
      if (!Array.isArray(facts)) return null;

      return facts.filter(
        (item) =>
          item &&
          typeof item.category === "string" &&
          typeof item.content === "string" &&
          item.content.length > 0 &&
          isFinite(item.confidence),
      );
    } catch {
      return null;
    }
  }

  private parseSemanticSignals(response: string): InteractionSemanticSignal[] {
    try {
      let jsonStr = response.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
      const parsed = JSON.parse(jsonStr) as { semanticSignals?: unknown };
      if (!Array.isArray(parsed?.semanticSignals)) return [];
      const allowed = new Set<InteractionSemanticSignal>([
        "question", "problem", "execution-directive", "topic-shift", "closure", "small-talk",
        "preference", "positive-feedback", "negative-feedback", "correction", "bad-timing",
        "already-known", "adopted", "code-change", "verification", "local-evidence", "self-improvement",
      ]);
      return [...new Set(parsed.semanticSignals.filter((value): value is InteractionSemanticSignal =>
        typeof value === "string" && allowed.has(value as InteractionSemanticSignal),
      ))];
    } catch {
      return [];
    }
  }

  private parseSemanticTopicTags(response: string): string[] {
    try {
      let jsonStr = response.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
      const parsed = JSON.parse(jsonStr) as { topicTags?: unknown };
      if (!Array.isArray(parsed?.topicTags)) return [];
      return [...new Set(parsed.topicTags
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLocaleLowerCase().trim().replace(/[^\p{L}\p{N}_-]+/gu, "-"))
        .filter((value) => value.length >= 2 && value.length <= 50)
        .map((value) => `topic:${value}`))].slice(0, 5);
    } catch {
      return [];
    }
  }

  private normalizeLanguageCode(value: string): string | undefined {
    const normalized = value.trim();
    return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/i.test(normalized) ? normalized : undefined;
  }

  private parseLanguageCode(response: string): string | undefined {
    try {
      let jsonStr = response.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
      const parsed = JSON.parse(jsonStr) as { languageCode?: unknown };
      return typeof parsed.languageCode === "string" ? this.normalizeLanguageCode(parsed.languageCode) : undefined;
    } catch {
      return undefined;
    }
  }

  private async persistInteractionSemanticSignals(
    userMessage: string,
    messageId: string | undefined,
    signals: InteractionSemanticSignal[],
    semanticTopicTags: string[] = [],
    languageCode?: string,
  ): Promise<void> {
    let classifiedMemory: SoulMemory | undefined;
    await updateEgoStore(this.storePath, (ego) => {
      const candidates = ego.memories.filter((memory) =>
        memory.type === "interaction" && memory.tags.includes("inbound")
        && (messageId ? memory.sourceMessageId === messageId : memory.content === userMessage.slice(0, 300)),
      );
      const target = candidates.sort((a, b) => b.timestamp - a.timestamp)[0];
      if (target) {
        const hadLexicalEmotion = target.valence !== "neutral";
        target.semanticSignals = signals;
        target.tags = [...new Set([...target.tags, ...semanticTopicTags])];
        if (signals.includes("positive-feedback")) {
          target.valence = "positive";
          target.emotion = Math.max(target.emotion, 18);
        } else if (signals.includes("negative-feedback") || signals.includes("correction")) {
          target.valence = "negative";
          target.emotion = Math.min(target.emotion, -18);
        }
        if (!hadLexicalEmotion && signals.includes("positive-feedback")) {
          ego.needs.connection.current = Math.min(100, ego.needs.connection.current + 3);
        } else if (!hadLexicalEmotion
          && (signals.includes("negative-feedback") || signals.includes("correction"))) {
          ego.needs.security.current = Math.max(0, ego.needs.security.current - 2);
        }
        classifiedMemory = { ...target, tags: [...target.tags], semanticSignals: [...signals] };
      }
      if (languageCode) ego.userLanguage = languageCode;
      if (ego.relationshipProfile && signals.includes("positive-feedback")) {
        ego.relationshipProfile.recentEmotionalTone = "positive";
      } else if (ego.relationshipProfile
        && (signals.includes("negative-feedback") || signals.includes("correction"))) {
        ego.relationshipProfile.recentEmotionalTone = "negative";
      }
      return ego;
    });
    if (!classifiedMemory) return;
    const originId = classifiedMemory.sourceMessageId || classifiedMemory.id;
    if (signals.includes("execution-directive") && this.cognitionMode === "primary" && this.intentionStore) {
      const result = await this.intentionStore.add(buildUserDirectiveIntention(
        userMessage,
        originId,
        classifiedMemory.sourceConversationId,
        signals,
      ));
      if (result.created) log.info(`Multilingual semantic directive recorded as Intention: id=${result.intention.id}`);
    }
    if (signals.includes("closure")) {
      await this.thoughtPool.registerResolution({
        topicKey: resolutionTopicKey(userMessage),
        resolutionText: userMessage,
        resolvedAt: classifiedMemory.timestamp,
      });
      await this.thoughtPool.fadeRelatedCandidates(userMessage);
      if (this.thoughtEpisodeStore) {
        await this.thoughtEpisodeStore.supersedeRelated(userMessage, classifiedMemory.id);
      }
    }
    if (this.expressionFeedbackStore && this.expressionStore
      && signals.some((signal) => ["positive-feedback", "negative-feedback", "correction",
        "bad-timing", "already-known", "adopted"].includes(signal))) {
      const expressions = await this.expressionStore.load();
      const proposal = expressions.proposals.find((item) => item.status === "sent"
        && Date.now() - (item.evaluatedAt ?? item.createdAt) < 24 * 60 * 60 * 1000);
      if (proposal) {
        await this.expressionFeedbackStore.observeReply(
          proposal,
          userMessage,
          classifiedMemory.sourceMessageId || classifiedMemory.id,
          signals,
        );
      }
    }
  }

  private parseUserPreferenceResponse(
    response: string,
  ): Array<{
    aspect: string;
    preference: string;
    confidence: number;
    source?: string;
    direction?: "prefer" | "avoid";
  }> | null {
    try {
      let jsonStr = response.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
      const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (arrayMatch) jsonStr = arrayMatch[0];

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return null;

      const validAspects = new Set([
        "response_length",
        "communication_style",
        "interaction_frequency",
        "question_style",
        "feedback_preference",
        "tone",
        "topic_preference",
      ]);

      return parsed.filter(
        (item) =>
          item &&
          typeof item.aspect === "string" &&
          validAspects.has(item.aspect) &&
          typeof item.preference === "string" &&
          item.preference.length > 0 &&
          isFinite(item.confidence),
      ).map((item) => ({
        ...item,
        ...(item.direction === "prefer" || item.direction === "avoid" ? { direction: item.direction } : {}),
      }));
    } catch {
      return null;
    }
  }

  /**
   * Extract topic tags from conversation text using keyword matching.
   * English keywords are matched with word boundaries to avoid false
   * positives (e.g. "ai" in "main", "ml" in "html"). Chinese keywords
   * are substring-matched since Chinese has no word boundaries.
   * Tags are used by conversation-replay analyzer to match conversations
   * with Soul's learned knowledge.
   */
  private extractInteractionTags(text: string): string[] {
    const tags: string[] = [];
    const lower = text.toLowerCase();

    for (const [pattern, tag] of EN_TECH_PATTERNS) {
      if (pattern.test(lower)) tags.push(tag);
    }

    for (const [keyword, tag] of Object.entries(CN_TECH_KEYWORDS)) {
      if (text.includes(keyword)) tags.push(tag);
    }

    return [...new Set(tags)].slice(0, 5);
  }

  /**
   * Detect the user's language from message text using character ratio.
   * Returns a language code ("zh-CN", "ja", "ko") or null.
   * CJK/Japanese/Korean are detected reliably via character ranges.
   * Latin-script languages (Danish, German, French, etc.) return null —
   * the caller uses stored message samples for LLM-based language matching.
   */
  private detectLanguage(text: string): string | null {
    let cjk = 0;
    let latin = 0;
    let hiragana = 0;
    let hangul = 0;

    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      // CJK Unified Ideographs + Extension A-H
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x20000 && code <= 0x2a6df)
      ) {
        cjk++;
      }
      // Hiragana/Katakana — likely Japanese
      if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) {
        hiragana++;
      }
      // Hangul — Korean
      if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) {
        hangul++;
      }
      // Latin
      if ((code >= 0x0041 && code <= 0x007a) || (code >= 0x00c0 && code <= 0x024f)) {
        latin++;
      }
    }

    const total = cjk + latin + hiragana + hangul;
    if (total === 0) return null;

    if (hangul / total > 0.3) return "ko";
    if (hiragana / total > 0.15) return "ja";
    if (cjk / total > 0.2) return "zh-CN";
    // Latin-script languages can't be reliably distinguished by character ranges.
    // Return null — the caller will use recentUserMessages for language matching.
    return null;
  }
}
