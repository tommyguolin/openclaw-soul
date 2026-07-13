import { contentTokens, jaccard } from "../thought-emergence.js";
import type {
  ActivationConfig,
  ActivationContribution,
  ActivationResult,
  CognitiveTrace,
  RandomSource,
  TraceActivationState,
} from "./types.js";
import { DEFAULT_ACTIVATION_CONFIG } from "./types.js";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const decay = (value: number, elapsed: number, halfLife: number) =>
  value <= 0 ? 0 : value * Math.exp(-Math.LN2 * Math.max(0, elapsed) / Math.max(1, halfLife));

export interface ActivationEngineInput {
  traces: CognitiveTrace[];
  states: ReadonlyMap<string, TraceActivationState>;
  stimulusTraceId?: string;
  now: number;
  random?: RandomSource;
  resolvedTraceIds?: ReadonlySet<string>;
  config?: Partial<ActivationConfig>;
}

export function updateActivations(input: ActivationEngineInput): ActivationResult[] {
  const config = { ...DEFAULT_ACTIVATION_CONFIG, ...input.config };
  const random = input.random ?? Math.random;
  const byId = new Map(input.traces.map((trace) => [trace.id, trace]));
  const stimulus = input.stimulusTraceId ? byId.get(input.stimulusTraceId) : undefined;
  const stimulusTokens = stimulus ? contentTokens(stimulus.content) : [];
  const contributions = new Map<string, ActivationContribution[]>();
  const add = (item: ActivationContribution) => {
    const list = contributions.get(item.traceId) ?? [];
    list.push(item);
    contributions.set(item.traceId, list);
  };

  if (stimulus) {
    add({
      traceId: stimulus.id,
      channel: "external-stimulus",
      mechanism: "semantic-similarity",
      sourceTraceId: stimulus.id,
      strength: config.maxPerceptionInput,
      evidenceIds: [stimulus.sourceId],
    });
    for (const trace of input.traces) {
      if (trace.id === stimulus.id) continue;
      const similarity = jaccard(stimulusTokens, contentTokens(trace.content));
      if (similarity <= 0) continue;
      add({
        traceId: trace.id,
        channel: "internal-spread",
        mechanism: "semantic-similarity",
        sourceTraceId: stimulus.id,
        strength: Math.min(config.maxSemanticSpread, similarity * config.maxSemanticSpread),
        evidenceIds: [stimulus.sourceId, trace.sourceId],
      });
    }
    for (const association of stimulus.memory?.associations ?? []) {
      const target = byId.get(`memory:${association.targetId}`);
      if (!target) continue;
      add({
        traceId: target.id,
        channel: "internal-spread",
        mechanism: "explicit-association",
        sourceTraceId: stimulus.id,
        strength: Math.min(config.maxAssociationSpread, clamp01(association.strength) * config.maxAssociationSpread),
        evidenceIds: [stimulus.sourceId, target.sourceId],
      });
    }
  }

  if (random() < config.stochasticRecallProbability) {
    const eligible = input.traces
      .filter((trace) => trace.id !== stimulus?.id && !input.resolvedTraceIds?.has(trace.id))
      .sort((a, b) => {
        const left = input.states.get(a.id)?.consumedCount ?? 0;
        const right = input.states.get(b.id)?.consumedCount ?? 0;
        return left - right || a.timestamp - b.timestamp;
      })
      .slice(0, 10);
    if (eligible.length > 0) {
      const trace = eligible[Math.min(eligible.length - 1, Math.floor(random() * eligible.length))];
      add({
        traceId: trace.id,
        channel: "stochastic",
        mechanism: "random-recall",
        strength: config.stochasticRecallInput,
        evidenceIds: [trace.sourceId],
      });
    }
  }

  return input.traces.map((trace) => {
    const previous = input.states.get(trace.id) ?? {
      traceId: trace.id,
      activation: 0,
      fatigue: 0,
      lastUpdatedAt: input.now,
      activationCount: 0,
      consumedCount: 0,
    };
    const elapsed = Math.max(0, input.now - previous.lastUpdatedAt);
    const retained = decay(previous.activation, elapsed, config.halfLifeMs);
    const fatigue = decay(previous.fatigue, elapsed, config.fatigueHalfLifeMs);
    const items = contributions.get(trace.id) ?? [];
    const positive = items.reduce((sum, item) => sum + item.strength, 0);
    const refractory = (previous.refractoryUntil ?? 0) > input.now ? config.refractoryPenalty : 0;
    const resolvedSuppressed = input.resolvedTraceIds?.has(trace.id) ?? false;
    const activation = clamp01(retained + positive - fatigue - refractory
      - (resolvedSuppressed ? config.resolvedSuppression : 0));
    const activated = positive > 0;
    const state: TraceActivationState = {
      ...previous,
      activation,
      fatigue,
      lastUpdatedAt: input.now,
      ...(activated ? { lastActivatedAt: input.now, activationCount: previous.activationCount + 1 } : {}),
    };
    return { trace, previous, state, contributions: items, resolvedSuppressed };
  });
}
