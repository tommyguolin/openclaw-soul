import { randomBytes } from "node:crypto";
import type { EgoState } from "../types.js";
import { contentTokens, jaccard } from "../thought-emergence.js";
import { buildActiveSet } from "./active-set.js";
import { updateActivations } from "./activation-engine.js";
import { ActivationStore } from "./activation-store.js";
import { CognitiveJournal } from "./cognitive-journal.js";
import { buildCognitiveWorkspace, consumeWorkspace } from "./workspace.js";
import type {
  ActivationConfig,
  CognitionCycleRecord,
  CognitionStimulus,
  CognitiveWorkspace,
  RandomSource,
  TraceActivationState,
  EmergenceResult,
} from "./types.js";

export interface CognitionRunnerOptions {
  store: ActivationStore;
  journal: CognitiveJournal;
  config?: Partial<ActivationConfig>;
  now?: () => number;
  random?: RandomSource;
}

export interface CognitionCycleResult {
  workspace: CognitiveWorkspace;
  record: CognitionCycleRecord;
  states: Map<string, TraceActivationState>;
}

export interface CognitionRunContext {
  resolvedTexts?: string[];
  mode?: "observe" | "shadow" | "primary";
  emerge?: (workspace: CognitiveWorkspace) => Promise<EmergenceResult>;
}

export class CognitionRunner {
  private stimuli: CognitionStimulus[] = [];
  private running = false;

  constructor(private readonly options: CognitionRunnerOptions) {}

  enqueueStimulus(stimulus: CognitionStimulus): void {
    if (!this.stimuli.some((item) => item.type === stimulus.type && item.sourceId === stimulus.sourceId)) {
      this.stimuli.push(stimulus);
    }
  }

  async run(ego: EgoState, context: CognitionRunContext = {}): Promise<CognitionCycleResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const now = this.options.now?.() ?? Date.now();
      const stimulus = this.stimuli.shift();
      const file = await this.options.store.load(now);
      const states = new Map(file.states.map((state) => [state.traceId, state]));
      const traces = buildActiveSet(ego, states, stimulus?.sourceId, {
        maxSize: this.options.config?.maxActiveSetSize,
      });
      if (traces.length === 0) return null;
      const resolvedTraceIds = new Set(traces
        .filter((trace) => /(?:fail|failed|failing|unable|cannot|can't|broken|problem|issue|still|不确定|失败|无法|不能|连不上|有问题|仍然|是否)/i.test(trace.content))
        .filter((trace) => context.resolvedTexts?.some((resolution) =>
          jaccard(contentTokens(trace.content), contentTokens(resolution)) >= 0.12))
        .map((trace) => trace.id));
      const stimulusTraceId = stimulus ? `memory:${stimulus.sourceId}` : undefined;
      const results = updateActivations({
        traces,
        states,
        stimulusTraceId,
        now,
        random: this.options.random,
        resolvedTraceIds,
        config: this.options.config,
      });
      const workspace = buildCognitiveWorkspace(results, now, stimulus?.sourceId, this.options.config);
      consumeWorkspace(workspace, results, now, this.options.config);
      for (const result of results) states.set(result.trace.id, result.state);
      await this.options.store.save(states.values(), now);
      let emergence: CognitionCycleRecord["emergence"];
      if (!workspace.allowEmergence) {
        emergence = { called: false, outcome: "pre-generation-silence" };
      } else if ((context.mode !== "shadow" && context.mode !== "primary") || !context.emerge) {
        emergence = { called: false, outcome: "not-configured" };
      } else {
        const result = await context.emerge(workspace);
        emergence = result.outcome === "thought"
          ? { called: true, outcome: "thought", thought: result.content,
            cognitiveMove: result.cognitiveMove, qualityFlags: result.qualityFlags }
          : result.outcome === "silence"
            ? { called: result.reason !== "pre-generation", outcome: result.reason === "pre-generation"
              ? "pre-generation-silence" : "model-no-thought" }
            : { called: true, outcome: "failed", error: result.error.slice(0, 500) };
      }
      const record: CognitionCycleRecord = {
        version: 1,
        cycleId: randomBytes(8).toString("hex"),
        timestamp: now,
        mode: context.mode ?? "observe",
        stimulus,
        activeSetSize: traces.length,
        activations: results
          .filter((result) => result.state.activation > 0 || result.contributions.length > 0)
          .sort((a, b) => b.state.activation - a.state.activation)
          .slice(0, 20)
          .map((result) => ({
            traceId: result.trace.id,
            sourceId: result.trace.sourceId,
            activation: result.state.activation,
            fatigue: result.state.fatigue,
            contributions: result.contributions,
            resolvedSuppressed: result.resolvedSuppressed,
          })),
        workspace: {
          itemIds: workspace.items.map((item) => item.trace.id),
          distribution: workspace.distribution,
          aggregateActivation: workspace.aggregateActivation,
          allowEmergence: workspace.allowEmergence,
          ...(workspace.silenceReason ? { silenceReason: workspace.silenceReason } : {}),
        },
        emergence,
      };
      await this.options.journal.append(record);
      return { workspace, record, states };
    } finally {
      this.running = false;
    }
  }
}
