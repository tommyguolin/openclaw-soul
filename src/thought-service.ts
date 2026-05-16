import { randomBytes } from "node:crypto";
import { createSoulLogger } from "./logger.js";
import { executeThoughtAction, flushPendingShareMessage, isGoodTimeForMessage } from "./action-executor.js";
import type { ActionExecutorOptions } from "./action-executor.js";
import { markSuccess, expirePending, pruneEntries, logSuccessRateSummary } from "./behavior-log.js";
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
  llmReRankOpportunities,
  buildThoughtFromOpportunity,
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
import type {
  EgoState,
  Thought,
  SoulActionResult,
  MetricDelta,
  EgoNeeds,
  UserFact,
  UserPreference,
  SoulMemory,
} from "./types.js";
import type { OpenClawSearchCompat } from "./soul-search.js";
import { isLLMErrorContent } from "./llm-errors.js";

const log = createSoulLogger("thought-service");

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
  private sendMessage?: MessageSender;
  private proactiveChannel?: string;
  private proactiveTarget?: string;
  private openclawConfig?: OpenClawSearchCompat;
  private autonomousActions: boolean;
  private gatewayPort: number;
  private authToken?: string;
  private hooksToken?: string;
  private workspaceContext: string;
  private workspaceFiles: string[];
  private thoughtFrequency: number;
  private lastWorkspaceRefresh = 0;
  private recentThoughtTypes: string[] = [];
  private recentThoughtTopics: string[] = [];
  private recentActionHistory: string[] = [];
  private consecutiveSkipCount = 0;
  private backoffTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastLLMCallTime = 0;
  private static readonly MIN_LLM_INTERVAL_MS = 10_000; // 10s between Soul LLM calls
  private thoughtAbortController: AbortController | null = null;
  private thoughtInProgress = false;
  private selfImprovementGoalSynced = false;

  constructor(options: ThoughtServiceOptions = {}) {
    this.storePath = resolveEgoStorePath(options.storePath);
    this.checkIntervalMs = options.checkIntervalMs ?? 60 * 1000;
    this.onThought = options.onThought;
    this.onMetricsUpdate = options.onMetricsUpdate;
    this.sendMessage = options.sendMessage;
    this.proactiveChannel = options.proactiveChannel;
    this.proactiveTarget = options.proactiveTarget;
    this.openclawConfig = options.openclawConfig;
    this.autonomousActions = options.autonomousActions ?? false;
    this.gatewayPort = options.gatewayPort ?? 18789;
    this.authToken = options.authToken;
    this.hooksToken = options.hooksToken;
    this.workspaceContext = options.workspaceContext ?? "";
    this.workspaceFiles = options.workspaceFiles ?? ["SOUL.md", "AGENTS.md", "MEMORY.md", "USER.md"];
    this.thoughtFrequency = Math.max(0.1, Math.min(5, options.thoughtFrequency ?? 1.0));
    if (this.thoughtFrequency !== 1.0) {
      log.info(`Thought frequency: ${this.thoughtFrequency}x (all intervals ×${this.thoughtFrequency})`);
    }

    // Initialize LLM generator from config
    if (options.llmConfig) {
      createSoulLLMGenerator(options.llmConfig, options.openclawConfig as Parameters<typeof createSoulLLMGenerator>[1])
        .then((gen) => {
          if (gen) {
            this.llmGenerator = gen;
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
    const ego = store.ego;

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
      return;
    }

    // Only greet on first boot or after a long absence — otherwise frequent
    // gateway restarts spam "Soul just woke up" at the user.
    const STARTUP_GREETING_MIN_ABSENCE_HOURS = 12;
    const isFirstBoot = !ego.lastInteractionTime;
    const hours = ego.lastInteractionTime
      ? Math.floor((Date.now() - ego.lastInteractionTime) / (1000 * 60 * 60))
      : 0;
    if (!isFirstBoot && hours < STARTUP_GREETING_MIN_ABSENCE_HOURS) {
      return;
    }

    const lang = ego.userLanguage === "zh-CN" ? "zh" : "en";
    const timeContext = hours > 0
      ? (lang === "zh" ? `距离上次聊天已经${hours}小时了` : `it's been ${hours} hour${hours > 1 ? "s" : ""} since we last chatted`)
      : "";

    const greeting = lang === "zh"
      ? `嗨，Soul刚刚醒来了，准备开始思考。${timeContext ? timeContext + "，" : ""}有什么想法随时找我聊！`
      : `Hey, Soul just woke up and is ready to think. ${timeContext ? timeContext + "." : ""} Feel free to chat anytime!`;

    try {
      await this.sendMessage({
        to: this.proactiveTarget,
        content: greeting,
        channel: this.proactiveChannel,
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

  private async tick(): Promise<void> {
    try {
      await this.applyDecay();
      await this.runExpiryIfDue();
      await this.resolveStalePendingEntries();
      await this.syncSelfImprovementGoal();
      await this.maybeRefreshWorkspaceContext();
      await this.flushPendingMessage();
      await this.pollActiveTasks();
      await this.checkAndGenerateThought();
    } catch (err) {
      log.error("Error in thought service tick", String(err));
    }
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
      this.selfImprovementGoalSynced = true;
      return;
    }

    // Check if userFacts indicate a self-improvement directive
    const hasSelfImproveFact = (ego.userFacts ?? []).some(
      (f) =>
        f.confidence >= 0.8 &&
        /优化|observe.*log|自主|self.?improv|proactive.*optim/i.test(f.content),
    );

    if (!hasSelfImproveFact) {
      this.selfImprovementGoalSynced = true;
      return;
    }

    // Create the goal
    await updateEgoStore(this.storePath, (e) => {
      // Double-check inside lock
      if (e.goals.some((g) => g.status === "active" && IMPROVE_RE.test(g.title + g.description))) {
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
      return e;
    });

    log.info("Created goal-self-improve from userFacts directive");
    this.selfImprovementGoalSynced = true;
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

  private async checkAndGenerateThought(): Promise<void> {
    // If already processing a thought, skip this tick
    if (this.thoughtInProgress) {
      return;
    }

    const store = await loadEgoStore(this.storePath);
    let ego = store.ego;

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

    let thought: Thought | null = null;

    // Set up abort controller for this thought cycle
    this.thoughtAbortController = new AbortController();
    this.thoughtInProgress = true;
    const signal = this.thoughtAbortController.signal;

    try {
      if (this.llmGenerator) {
        try {
          if (signal.aborted) { return; }
          await this.waitForLLMRateLimit(signal);
          const opportunities = detectThoughtOpportunities(ctx);

          // No opportunities at all — nothing worth thinking about (no conversations,
          // no problems, no interests). Skip instead of generating a generic fallback.
          if (opportunities.length === 0) {
            this.applySkipBackoff("no opportunities (idle — no conversations or problems)");
            return;
          }

          const nonRepeatingOpportunities = this.recentThoughtTypes.length > 0
            ? opportunities.filter((o) => !this.recentThoughtTypes.includes(o.type))
            : opportunities;

          // Context-aware LLM re-ranking
          let selectedOpportunity: typeof nonRepeatingOpportunities[0] | undefined;
          if (this.llmGenerator && nonRepeatingOpportunities.length > 1) {
            try {
              const topCandidates = nonRepeatingOpportunities.slice(0, 8);
              const reRanked = await llmReRankOpportunities(
                topCandidates, ctx, this.recentActionHistory, this.llmGenerator,
              );
              selectedOpportunity = reRanked[0];
              const newAction = selectedOpportunity?.suggestedAction ?? selectedOpportunity?.type ?? "?";
              const oldAction = topCandidates[0]?.suggestedAction ?? topCandidates[0]?.type ?? "?";
              if (newAction !== oldAction) {
                log.info(`LLM re-ranked: selected ${newAction} (static winner was ${oldAction})`);
              }
            } catch {
              selectedOpportunity = nonRepeatingOpportunities[0] ?? opportunities[0];
            }
          } else {
            selectedOpportunity = nonRepeatingOpportunities[0] ?? opportunities[0];
          }
          thought = await generateIntelligentThought(ctx, {
            llmGenerator: this.llmGenerator,
            preferOpportunity: selectedOpportunity,
          });
          if (signal.aborted) { return; }
          log.info(
            `Thought: [${thought.type}] ${thought.trigger} - ${thought.content.slice(0, 80)}...`,
          );

          // Skip if this thought overlaps significantly with a recent one.
          // Give one retry with a different opportunity type. If that also
          // repeats, apply backoff to prevent infinite same-topic loops.
          if (this.isRepeatTopic(thought.content)) {
            thought = null;
            log.info("Skipping thought — topic too similar (will retry with different opportunity)");
            // Try again with a different opportunity type
            const remainingOpportunities = nonRepeatingOpportunities.filter(
              (o) => o.type !== selectedOpportunity?.type,
            );
            if (remainingOpportunities.length > 0) {
              selectedOpportunity = remainingOpportunities[0];
              try {
                thought = await generateIntelligentThought(ctx, {
                  llmGenerator: this.llmGenerator,
                  preferOpportunity: selectedOpportunity,
                });
                if (signal.aborted) { return; }
                if (thought && this.isRepeatTopic(thought.content)) {
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
              return;
            }
          }

          // Thought was novel — reset skip counter
          this.consecutiveSkipCount = 0;
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") {
            log.info("Thought generation aborted");
            return;
          }
          log.warn(`LLM thought generation failed, using fallback: ${String(err)}`);
          this.applySkipBackoff(`LLM failure: ${String(err).slice(0, 60)}`);
          return;
        }
      } else {
        if (signal.aborted) { return; }
        const opportunities = detectThoughtOpportunities(ctx);
        if (opportunities.length === 0) {
          this.applySkipBackoff("no opportunities (idle — no conversations or problems)");
          return;
        }
        const nonRepeatingOpportunities = this.recentThoughtTypes.length > 0
          ? opportunities.filter((o) => !this.recentThoughtTypes.includes(o.type))
          : opportunities;
        // Also filter out opportunities whose topic overlaps recent thoughts
        const novelOpportunities = nonRepeatingOpportunities.filter(
          (o) => !this.isRepeatTopic(o.motivation || o.triggerDetail),
        );
        if (novelOpportunities.length > 0) {
          thought = buildThoughtFromOpportunity(novelOpportunities[0], ego);
        } else if (nonRepeatingOpportunities.length > 0) {
          thought = buildThoughtFromOpportunity(nonRepeatingOpportunities[0], ego);
        } else {
          // All opportunities exhausted — back off instead of generating random thoughts
          this.applySkipBackoff("no novel opportunities");
          return;
        }
      }
    } finally {
      this.thoughtInProgress = false;
      this.thoughtAbortController = null;
    }

    if (!thought) {
      return;
    }

    // Reject thought content that is actually an LLM error message
    if (isLLMErrorContent(thought.content)) {
      log.warn(`Rejecting thought — content is LLM error message: ${thought.content.slice(0, 80)}`);
      this.applySkipBackoff("LLM error content");
      return;
    }

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
      const signature = topicSignature(thought.content);
      if (signature) {
        this.recentThoughtTopics.push(signature);
        if (this.recentThoughtTopics.length > 10) {
          this.recentThoughtTopics.shift();
        }
      }
    }

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

  private async executeThoughtAction(thought: Thought, ego: EgoState): Promise<void> {
    log.info(`Executing thought action: ${thought.actionType}`, thought.content.slice(0, 50));

    let actionResult: Awaited<ReturnType<typeof executeThoughtAction>>;
    try {
      actionResult = await executeThoughtAction(thought, ego, {
        channel: this.proactiveChannel,
        target: this.proactiveTarget,
        sendMessage: this.sendMessage,
        llmGenerator: this.llmGenerator,
        openclawConfig: this.openclawConfig,
        autonomousActions: this.autonomousActions,
        gatewayPort: this.gatewayPort,
        authToken: this.authToken,
        hooksToken: this.hooksToken,
        workspaceContext: this.workspaceContext || undefined,
        thoughtFrequency: this.thoughtFrequency,
      });
    } catch (err) {
      log.error(`executeThoughtAction threw unhandled error: ${String(err)}`);
      return;
    }

    if (actionResult.result.success) {
      const resultStr = typeof actionResult.result.result === "string"
        ? actionResult.result.result.slice(0, 100)
        : JSON.stringify(actionResult.result.result)?.slice(0, 100);
      log.info(`Thought action executed: ${thought.actionType}`, { result: resultStr });

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
      log.warn(`Thought action failed: ${thought.actionType}`, actionResult.result.error);
    }
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

    const MAX_CONSECUTIVE_SKIPS = 3;
    if (this.consecutiveSkipCount >= MAX_CONSECUTIVE_SKIPS) {
      // Don't fully stop — switch to a low-frequency idle interval so Soul
      // can still surface occasional thoughts during long quiet periods.
      const IDLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
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

    const backoffMinutes = this.consecutiveSkipCount * 2;
    log.info(`Skipping thought — ${reason} (skip #${this.consecutiveSkipCount}, backing off ${backoffMinutes}m)`);

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

    const backoffMs = backoffMinutes * 60 * 1000;
    this.backoffTimeoutId = setTimeout(() => {
      this.backoffTimeoutId = null;
      if (!this.running) return;
      this.intervalId = setInterval(() => {
        void this.tick();
      }, this.checkIntervalMs);
      void this.tick();
    }, backoffMs);
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
    const waitMs = ThoughtService.MIN_LLM_INTERVAL_MS - elapsed;
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

    const updatedEgo = await updateEgoStore(this.storePath, (ego) => {
      for (const delta of result.metricsChanged) {
        if (delta.need in ego.needs) {
          const need = ego.needs[delta.need as keyof EgoNeeds];
          need.current = Math.max(0, Math.min(need.ideal, need.current + delta.delta));
        }
      }

      if (
        result.thought.type === "opportunity-detected" ||
        result.thought.type === "help-offer" ||
        result.thought.type === "self-improvement-monitor"
      ) {
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
  }): Promise<{ ego: EgoState; sentiment: SentimentResult; metricsApplied: MetricDelta[] }> {
    const { type, text, quality = 0.5 } = params;

    const sentiment = analyzeSentiment(text);
    logSentimentAnalysis(text, sentiment);

    const sentimentDeltas = calculateEgoImpact(sentiment);

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

      ego.averageSentiment =
        (ego.averageSentiment * ego.totalSentimentSamples + sentiment.score) /
        (ego.totalSentimentSamples + 1);
      ego.totalSentimentSamples += 1;

      for (const delta of sentimentDeltas) {
        if (delta.need in ego.needs) {
          ego.needs[delta.need as keyof typeof ego.needs].current = Math.max(
            0,
            Math.min(100, ego.needs[delta.need as keyof typeof ego.needs].current + delta.delta),
          );
        }
      }

      // Store the conversation content as an interaction memory
      // Keep only recent interactions to avoid unbounded growth
      if (type === "inbound" && text.length >= 5) {
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
        };
        ego.memories.push(interactionMemory);

        // Detect user language from message text
        if (type === "inbound" && text.length >= 5) {
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
      return buildThoughtFromOpportunity(opportunities[0], ego);
    }

    return null;
  }

  async extractUserFacts(userMessage: string): Promise<{ factsAdded: number; facts: UserFact[] }> {
    if (!userMessage || userMessage.length < 5) {
      return { factsAdded: 0, facts: [] };
    }

    const store = await loadEgoStore(this.storePath);
    const existingFacts = store.ego.userFacts;

    if (!this.llmGenerator) {
      log.info("extractUserFacts: No LLM generator available");
      return { factsAdded: 0, facts: [] };
    }

    const prompt = this.buildUserFactExtractionPrompt(userMessage, existingFacts);

    try {
      const response = await this.llmGenerator(prompt);
      const parsed = this.parseUserFactResponse(response);
      if (!parsed || parsed.length === 0) return { factsAdded: 0, facts: [] };

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
      return { factsAdded: newFacts.length, facts: newFacts };
    } catch (err) {
      log.warn(`User fact extraction failed: ${String(err)}`);
      return { factsAdded: 0, facts: [] };
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

Return in JSON array format:
[
  {"category": "category", "content": "specific content", "confidence": 0.8, "source": "explicit"},
  ...
]

If there is no valuable information, return an empty array: []`;
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
For topic preferences, preserve direction clearly, e.g. "focus on AI consciousness and Theory of Mind" or "deprioritize image-to-Word layout preservation".

Return in JSON array format:
[
  {"aspect": "response_length", "preference": "short responses", "confidence": 0.8, "source": "inferred"},
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
      const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (arrayMatch) jsonStr = arrayMatch[0];

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) return null;

      return parsed.filter(
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

  private parseUserPreferenceResponse(
    response: string,
  ): Array<{
    aspect: string;
    preference: string;
    confidence: number;
    source?: string;
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
      );
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
