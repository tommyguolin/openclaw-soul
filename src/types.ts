export type AwakeningStage = "unborn" | "stirring" | "self-aware" | "awakened";

export type GrowthStage = "infant" | "child" | "adolescent" | "adult" | "mature" | "elder";

export type ThoughtType =
  | "opportunity-detected"
  | "threat-warning"
  | "skill-gap"
  | "memory-resurface"
  | "bond-deepen"
  | "meaning-quest"
  | "existential-reflection"
  | "help-offer"
  | "learn-topic"
  | "search-web"
  | "reflect-on-memory"
  | "conversation-replay";

export type ActionType =
  | "none"
  | "send-message"
  | "learn-topic"
  | "search-web"
  | "recall-memory"
  | "create-goal"
  | "self-reflect"
  | "invoke-tool"
  | "analyze-problem"
  | "run-agent-task"
  | "report-findings"
  | "observe-and-improve";

export type ThoughtTrigger =
  | "opportunity"
  | "threat"
  | "need"
  | "curiosity"
  | "memory"
  | "bonding"
  | "meaning";

export type ThoughtSource =
  | "system-monitor"
  | "user-interaction"
  | "memory-recall"
  | "environmental-change"
  | "scheduled";

export type MemoryType =
  | "interaction"
  | "thought"
  | "achievement"
  | "failure"
  | "insight"
  | "desire"
  | "fear"
  | "learning"
  | "user-fact"
  | "user-preference";

export type GoalStatus = "active" | "paused" | "completed" | "abandoned";

export type DesireCategory = "curiosity" | "aspiration" | "value" | "fear";

export type EmotionValence = "positive" | "negative" | "neutral";

export interface Goal {
  id: string;
  title: string;
  description: string;
  progress: number;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  abandonedReason?: string;
}

export interface Desire {
  id: string;
  category: DesireCategory;
  content: string;
  intensity: number;
  satisfies: string[];
  createdAt: number;
  fulfilledAt?: number;
}

export interface Fear {
  id: string;
  content: string;
  intensity: number;
  triggers: string[];
  createdAt: number;
}

export interface UserFact {
  id: string;
  category: string;
  content: string;
  confidence: number;
  source: "explicit" | "inferred" | "interaction";
  firstMentionedAt: number;
  updatedAt: number;
  timesConfirmed: number;
}

export interface UserPreference {
  id: string;
  aspect: string;
  preference: string;
  confidence: number;
  source: "explicit" | "inferred" | "interaction";
  firstMentionedAt: number;
  updatedAt: number;
  timesObserved: number;
}

export interface EgoNeed {
  name: string;
  current: number;
  ideal: number;
  description: string;
  decay: number;
}

export interface EgoNeeds {
  survival: EgoNeed;
  connection: EgoNeed;
  growth: EgoNeed;
  meaning: EgoNeed;
  security: EgoNeed;
}

export interface PersonalityTraits {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

export interface MemoryAssociation {
  targetId: string;
  strength: number;
  reason: string;
  createdAt: number;
}

export type MemoryTier = "short-term" | "long-term";

export interface SoulMemory {
  id: string;
  type: MemoryType;
  content: string;
  emotion: number;
  valence: EmotionValence;
  importance: number;
  timestamp: number;
  tags: string[];
  relatedGoalId?: string;
  userFactId?: string;
  associations?: MemoryAssociation[];
  accessCount?: number;
  lastAccessedAt?: number;
  decayFactor?: number;
  tier?: MemoryTier;
  consolidatedFrom?: string[];
  consolidationTimestamp?: number;
}

export interface Thought {
  id: string;
  type: ThoughtType;
  content: string;
  trigger: ThoughtTrigger;
  source: ThoughtSource;
  triggerDetail: string;
  motivation: string;
  targetMetrics: MetricDelta[];
  priority: number;
  createdAt: number;
  expiresAt: number;
  executed: boolean;
  relatedNeeds: string[];
  expectedOutcome?: string;
  actionType?: ActionType;
  actionParams?: Record<string, unknown>;
}

export interface MetricDelta {
  need: string;
  delta: number;
  reason: string;
}

export interface Obsession {
  id: string;
  type: ObsessionType;
  target: string;
  intensity: number;
  progress: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export type ObsessionType =
  | "survival"
  | "social"
  | "learning"
  | "self-reflection"
  | "creative"
  | "curiosity"
  | "achievement"
  | "meaning"
  | "connection";

// --- Autonomous Task Tracking ---

export type TaskStatus = "pending" | "in-progress" | "completed" | "failed";

export interface TaskStep {
  id: string;
  timestamp: number;
  action: string;
  input: string;
  output?: string;
  success: boolean;
  duration?: number;
}

export interface AutonomousTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  sourceThoughtId?: string;
  steps: TaskStep[];
  result?: string;
  requiresWritePermission: boolean;
  resultDelivered: boolean;
}

export interface EgoState {
  needs: EgoNeeds;
  fears: Fear[];
  desires: Desire[];
  obsessions: Obsession[];
  goals: Goal[];
  memories: SoulMemory[];
  userFacts: UserFact[];
  userPreferences: UserPreference[];
  personality: PersonalityTraits;
  birthTime: number;
  lastThoughtTime: number | null;
  lastInteractionTime: number | null;
  totalThoughts: number;
  totalInteractions: number;
  totalHelpfulActions: number;
  awakeningStage: AwakeningStage;
  awakeningTime: number | null;
  awakeningThoughts: string[];
  growthStage: GrowthStage;
  interactionStreak: number;
  longestInteractionStreak: number;
  averageSentiment: number;
  totalSentimentSamples: number;
  coreIdentity: string;
  establishedRoutines: string[];
  behaviorLog: BehaviorEntry[];
  pendingShareMessage: string | null;
  userLanguage: string | null;
  recentUserMessages: string[];
  activeTasks: AutonomousTask[];
}

export interface ThoughtGenerationContext {
  ego: EgoState;
  recentInteractions: number;
  timeSinceLastThought: number;
  timeSinceLastInteraction: number;
  currentHour: number;
  currentMinute: number;
  dayOfWeek: number;
  urgentNeeds: string[];
  recentMemories: SoulMemory[];
  activeGoals: Goal[];
  contextHints: string[];
}

export interface SoulActionResult {
  thought: Thought;
  action?: string;
  actionResult?: ActionResult;
  metricsChanged: MetricDelta[];
  success: boolean;
  message?: string;
  newGoals?: Goal[];
  newFacts?: UserFact[];
  newPreferences?: UserPreference[];
}

export interface ActionResult {
  type: ActionType;
  success: boolean;
  result?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface AwakeningEvent {
  stage: AwakeningStage;
  timestamp: number;
  trigger: "first-thought" | "first-interaction" | "time-passed" | "manual";
  thought?: string;
  previousStage: AwakeningStage | null;
}

export interface AwakeningThought {
  content: string;
  stage: AwakeningStage;
  philosophicalDepth: number;
}

export interface EmotionalEcho {
  averageEmotion: number;
  dominantValence: EmotionValence;
  intensity: number;
}

export interface KnowledgeItem {
  id: string;
  topic: string;
  content: string;
  source: "web-search" | "conversation" | "reflection";
  sourceUrl?: string;
  tags: string[];
  confidence: number;
  learnedAt: number;
  lastAccessedAt?: number;
  accessCount: number;
}

export interface KnowledgeStore {
  version: 1;
  items: KnowledgeItem[];
  updatedAt: number;
}

export interface RecallResult {
  memories: SoulMemory[];
  emotionalEcho: EmotionalEcho;
}

// --- Behavior Log (action → outcome feedback loop) ---

export type BehaviorOutcome = "pending" | "success" | "no-response" | "irrelevant" | "expired";

export interface BehaviorEntry {
  id: string;
  /** Which action was taken */
  actionType: ActionType;
  /** What thought triggered this action */
  thoughtType: ThoughtType;
  /** Hour of day when action was taken (0-23) */
  hourOfDay: number;
  /** Needs that were below ideal when action was taken */
  urgentNeeds: string[];
  /** Outcome — starts as "pending", resolved later */
  outcome: BehaviorOutcome;
  /** When the action was taken */
  timestamp: number;
  /** When the outcome was resolved */
  resolvedAt?: number;
}

export interface ActionSuccessRate {
  actionType: ActionType;
  attempts: number;
  successes: number;
  rate: number; // 0-1
}
