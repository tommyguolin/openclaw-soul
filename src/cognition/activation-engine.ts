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

const UNRESOLVED = /\b(?:fail(?:ed|ure|ing)?|unable|cannot|can't|broken|problem|issue|blocked|stuck|uncertain|unresolved|timeout|error)\b|失败|无法|不能|问题|阻塞|卡住|不确定|未解决|超时|错误|故障/i;
const TASK_DIRECTIVE = /(?:请|你|自己).{0,24}(?:修改|重启|测试|执行|实现|优化|分析代码|配置|设置)|\b(?:please|you should|restart|edit|test|implement|optimi[sz](?:e|ed|ing)|improv(?:e|ed|ing)|fix(?:ed|ing)?|configur(?:e|ed|ing)|set|apply|run|execute)\b/i;

function isSelfEcho(trace: CognitiveTrace): boolean {
  return trace.id.startsWith("context:echo:")
    || (trace.sourceType === "interaction" && trace.provenance === "system")
    || trace.provenance === "model"
    || /^Search topic \(LLM\):/i.test(trace.content);
}

function isTaskDirective(trace: CognitiveTrace): boolean {
  const signals = trace.memory?.semanticSignals;
  if (signals && signals.length > 0) return signals.includes("execution-directive");
  // Offline fallback only. Normal inbound memories are classified by the LLM
  // into language-independent semantic signals before they incubate.
  return TASK_DIRECTIVE.test(trace.content);
}

function isUnresolved(trace: CognitiveTrace): boolean {
  if (trace.id.startsWith("context:residue:")) return true;
  const signals = trace.memory?.semanticSignals;
  if (signals && signals.length > 0) return signals.includes("problem");
  const tags = trace.memory?.tags ?? [];
  // Offline fallback for legacy memories without model-produced semantics.
  return tags.some((tag) => /problem|unresolved|failure|blocked/i.test(tag))
    || UNRESOLVED.test(trace.content);
}

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

  const latestConsumption = Math.max(0, ...[...input.states.values()].map((state) => state.lastConsumedAt ?? 0));
  const endogenousReady = latestConsumption === 0
    || input.now - latestConsumption >= config.endogenousGlobalCooldownMs;
  if (!stimulus && endogenousReady) {
    const eligible = input.traces.filter((trace) =>
      !input.resolvedTraceIds?.has(trace.id) && !isSelfEcho(trace) && !isTaskDirective(trace));
    eligible
      .filter(isUnresolved)
      .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
      .slice(0, config.maxEndogenousUnresolved)
      .forEach((trace) => add({
        traceId: trace.id,
        channel: "persistent-state",
        mechanism: "unresolved-state",
        strength: config.maxUnresolvedInput * (0.45 + trace.importance * 0.4),
        evidenceIds: [trace.sourceId],
      }));

    const recurrence = eligible.map((trace) => {
      const tokens = contentTokens(trace.content);
      let count = 0;
      let strongest = 0;
      const evidenceIds = [trace.sourceId];
      for (const other of eligible) {
        if (other.id === trace.id) continue;
        const similarity = jaccard(tokens, contentTokens(other.content));
        const clusterSimilarity = jaccard(trace.topicClusters, other.topicClusters);
        if (similarity < 0.14 && !(similarity >= 0.03 && clusterSimilarity >= 0.5)) continue;
        count += 1;
        strongest = Math.max(strongest, similarity, clusterSimilarity * 0.5);
        if (evidenceIds.length < 4) evidenceIds.push(other.sourceId);
      }
      return { trace, count, strongest, evidenceIds };
    }).filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count || b.strongest - a.strongest || b.trace.importance - a.trace.importance)
      .slice(0, config.maxEndogenousRecurring);
    for (const item of recurrence) add({
      traceId: item.trace.id,
      channel: "persistent-state",
      mechanism: "recurrence",
      strength: Math.min(config.maxRecurrenceInput,
        config.maxRecurrenceInput * (0.45 + Math.min(3, item.count) * 0.15 + item.strongest * 0.2)),
      evidenceIds: item.evidenceIds,
    });

    eligible
      .filter((trace) => input.now - trace.timestamp >= config.minTemporalAgeMs)
      .filter((trace) => trace.importance >= 0.6)
      .filter((trace) => trace.provenance === "user" || trace.provenance === "tool" || trace.provenance === "web"
        || trace.id.startsWith("context:background:"))
      .filter((trace) => {
        const state = input.states.get(trace.id);
        return !state?.lastConsumedAt || input.now - state.lastConsumedAt >= config.endogenousRefractoryMs;
      })
      .sort((a, b) => {
        const left = input.states.get(a.id)?.consumedCount ?? 0;
        const right = input.states.get(b.id)?.consumedCount ?? 0;
        return left - right || b.importance - a.importance || a.timestamp - b.timestamp;
      })
      .slice(0, config.maxEndogenousTemporal)
      .forEach((trace) => add({
        traceId: trace.id,
        channel: "temporal",
        mechanism: "incubation",
        strength: config.maxTemporalInput * (0.4 + trace.importance * 0.4),
        evidenceIds: [trace.sourceId],
      }));
  }

  if (random() < config.stochasticRecallProbability) {
    const eligible = input.traces
      .filter((trace) => trace.id !== stimulus?.id
        && !input.resolvedTraceIds?.has(trace.id)
        && !isSelfEcho(trace)
        && !isTaskDirective(trace))
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
