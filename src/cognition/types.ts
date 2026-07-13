import type { SoulMemory } from "../types.js";

export type CognitionMode = "legacy" | "observe" | "shadow" | "primary";

export type CognitiveTraceType =
  | "memory"
  | "interaction"
  | "intention"
  | "tension"
  | "environment";

export type CognitiveProvenance = "user" | "tool" | "web" | "model" | "system";

export interface CognitiveTrace {
  id: string;
  sourceType: CognitiveTraceType;
  sourceId: string;
  content: string;
  provenance: CognitiveProvenance;
  topicClusters: string[];
  timestamp: number;
  importance: number;
  memory?: SoulMemory;
}

export interface TraceActivationState {
  traceId: string;
  activation: number;
  fatigue: number;
  lastUpdatedAt: number;
  lastActivatedAt?: number;
  lastConsumedAt?: number;
  refractoryUntil?: number;
  activationCount: number;
  consumedCount: number;
}

export type ActivationChannel =
  | "external-stimulus"
  | "internal-spread"
  | "persistent-state"
  | "temporal"
  | "stochastic";

export type ActivationMechanism =
  | "semantic-similarity"
  | "explicit-association"
  | "shared-entity"
  | "unresolved-state"
  | "contradiction"
  | "recurrence"
  | "random-recall";

export interface ActivationContribution {
  traceId: string;
  channel: ActivationChannel;
  mechanism: ActivationMechanism;
  sourceTraceId?: string;
  strength: number;
  evidenceIds: string[];
}

export interface ActivationConfig {
  halfLifeMs: number;
  maxPerceptionInput: number;
  maxSemanticSpread: number;
  maxAssociationSpread: number;
  maxUnresolvedInput: number;
  maxContradictionInput: number;
  maxTemporalInput: number;
  stochasticRecallProbability: number;
  stochasticRecallInput: number;
  fatigueIncrement: number;
  fatigueHalfLifeMs: number;
  refractoryMs: number;
  refractoryPenalty: number;
  resolvedSuppression: number;
  baseWorkspaceThreshold: number;
  workspaceDeviationFactor: number;
  hardDominantThreshold: number;
  maxWorkspaceItems: number;
  maxActiveSetSize: number;
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  halfLifeMs: 30 * 60 * 1000,
  maxPerceptionInput: 0.72,
  maxSemanticSpread: 0.20,
  maxAssociationSpread: 0.15,
  maxUnresolvedInput: 0.15,
  maxContradictionInput: 0.25,
  maxTemporalInput: 0.05,
  stochasticRecallProbability: 0.02,
  stochasticRecallInput: 0.08,
  fatigueIncrement: 0.15,
  fatigueHalfLifeMs: 2 * 60 * 60 * 1000,
  refractoryMs: 15 * 60 * 1000,
  refractoryPenalty: 0.30,
  resolvedSuppression: 0.80,
  baseWorkspaceThreshold: 0.45,
  workspaceDeviationFactor: 0.8,
  hardDominantThreshold: 0.68,
  maxWorkspaceItems: 4,
  maxActiveSetSize: 120,
};

export interface CognitionStimulus {
  type: "interaction" | "manual-test";
  sourceId: string;
  timestamp: number;
}

export interface ActivationResult {
  trace: CognitiveTrace;
  previous: TraceActivationState;
  state: TraceActivationState;
  contributions: ActivationContribution[];
  resolvedSuppressed: boolean;
}

export interface WorkspaceItem {
  trace: CognitiveTrace;
  activation: number;
  fatigue: number;
  contributions: ActivationContribution[];
  selectionReason: string;
}

export interface CognitiveWorkspace {
  id: string;
  createdAt: number;
  stimulusId?: string;
  items: WorkspaceItem[];
  distribution: "single-dominant" | "clustered" | "diffuse";
  relations: Array<"support" | "tension" | "contradiction" | "association">;
  aggregateActivation: number;
  allowEmergence: boolean;
  silenceReason?: string;
}

export interface ActivationStateFile {
  version: 1;
  updatedAt: number;
  states: TraceActivationState[];
}

export interface CognitionCycleRecord {
  version: 1;
  cycleId: string;
  timestamp: number;
  mode: "observe" | "shadow" | "primary";
  stimulus?: CognitionStimulus;
  activeSetSize: number;
  activations: Array<{
    traceId: string;
    sourceId: string;
    activation: number;
    fatigue: number;
    contributions: ActivationContribution[];
    resolvedSuppressed: boolean;
  }>;
  workspace: {
    itemIds: string[];
    distribution: CognitiveWorkspace["distribution"];
    aggregateActivation: number;
    allowEmergence: boolean;
    silenceReason?: string;
  };
  emergence: {
    called: boolean;
    outcome: "thought" | "pre-generation-silence" | "model-no-thought" | "failed" | "not-configured";
    thought?: string;
    cognitiveMove?: string;
    qualityFlags?: string[];
    error?: string;
  };
}

export type EmergenceResult =
  | { outcome: "thought"; content: string; cognitiveMove: string; qualityFlags: string[] }
  | { outcome: "silence"; reason: "pre-generation" | "model-no-thought" }
  | { outcome: "failed"; error: string };

export type RandomSource = () => number;
