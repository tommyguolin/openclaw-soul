import path from "node:path";
import type { EgoState } from "../types.js";
import { ActivationStore } from "./activation-store.js";
import { CognitiveJournal } from "./cognitive-journal.js";
import { CognitionRunner } from "./runner.js";
import { contentTokens, jaccard } from "../thought-emergence.js";
import type {
  ActivationConfig,
  CognitionCycleRecord,
  CognitiveWorkspace,
  EmergenceResult,
  RandomSource,
} from "./types.js";

export interface CognitionLabOptions {
  outputDirectory: string;
  stimulusIds: string[];
  startTime?: number;
  intervalMs?: number;
  random?: RandomSource;
  config?: Partial<ActivationConfig>;
  /** Optional private emergence callback for output-quality experiments. */
  emerge?: (workspace: CognitiveWorkspace) => Promise<EmergenceResult>;
}

export interface CognitionLabMetrics {
  cycles: number;
  preGenerationSilenceRate: number;
  averageActiveSetSize: number;
  averageWorkspaceSize: number;
  uniqueTraceRatio: number;
  resolvedSuppressionCount: number;
  associativeExpansionRate: number;
  averageAssociativeItems: number;
  associationMechanismDistribution: Record<string, number>;
  generatedThoughts: number;
  modelSilenceRate: number;
  thoughtLexicalDiversity: number;
  cognitiveMoveDistribution: Record<string, number>;
  associativeThoughtRate: number;
  usefulAssociativeThoughtRate: number;
  unverifiedAssociativeAssertionRate: number;
  thoughtWorkspaceLexicalContinuityRate: number;
  endogenousWorkspaceRate: number;
}

/** Read-only with respect to Ego: production and lab share CognitionRunner. */
export async function runCognitionLab(
  ego: EgoState,
  options: CognitionLabOptions,
): Promise<{ records: CognitionCycleRecord[]; metrics: CognitionLabMetrics }> {
  let now = options.startTime ?? Date.now();
  const interval = options.intervalMs ?? 60_000;
  const journalPath = path.join(options.outputDirectory, "cognitive-lab.jsonl");
  const runner = new CognitionRunner({
    store: new ActivationStore(path.join(options.outputDirectory, "activation-lab-state.json")),
    journal: new CognitiveJournal(journalPath),
    now: () => now,
    random: options.random,
    config: options.config,
  });
  const records: CognitionCycleRecord[] = [];
  const workspaces = new Map<string, CognitiveWorkspace>();
  for (const sourceId of options.stimulusIds) {
    runner.enqueueStimulus({ type: "manual-test", sourceId, timestamp: now });
    const result = await runner.run(ego, options.emerge
      ? { mode: "shadow", emerge: options.emerge }
      : {});
    if (result) {
      records.push(result.record);
      workspaces.set(result.record.cycleId, result.workspace);
    }
    now += interval;
  }
  const traceIds = new Set(records.flatMap((record) => record.activations.map((item) => item.traceId)));
  const activationCount = records.reduce((sum, record) => sum + record.activations.length, 0);
  const average = (values: number[]) => values.length === 0 ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  const expanded = records.filter((record) => (record.workspace.expansion?.added ?? 0) > 0);
  const mechanismDistribution: Record<string, number> = {};
  for (const record of records) {
    for (const [mechanism, count] of Object.entries(record.workspace.expansion?.mechanisms ?? {})) {
      mechanismDistribution[mechanism] = (mechanismDistribution[mechanism] ?? 0) + count;
    }
  }
  const generated = records.filter((record) => record.emergence.outcome === "thought" && record.emergence.thought);
  const modelCalls = records.filter((record) => record.emergence.called);
  const moveDistribution: Record<string, number> = {};
  for (const record of generated) {
    const move = record.emergence.cognitiveMove ?? "unknown";
    moveDistribution[move] = (moveDistribution[move] ?? 0) + 1;
  }
  const thoughtDistances: number[] = [];
  for (let left = 0; left < generated.length; left += 1) {
    for (let right = left + 1; right < generated.length; right += 1) {
      thoughtDistances.push(1 - jaccard(
        contentTokens(generated[left].emergence.thought ?? ""),
        contentTokens(generated[right].emergence.thought ?? ""),
      ));
    }
  }
  const continuity = generated.filter((record) => {
    const thoughtTokens = contentTokens(record.emergence.thought ?? "");
    return (workspaces.get(record.cycleId)?.items ?? []).some((item) =>
      jaccard(thoughtTokens, contentTokens(item.trace.content)) >= 0.04);
  });
  const associativeThoughts = generated.filter((record) => (record.workspace.expansion?.added ?? 0) > 0);
  const unverifiedAssociative = associativeThoughts.filter((record) =>
    record.emergence.qualityFlags?.includes("association-unverified"));
  const usefulAssociative = associativeThoughts.filter((record) => {
    const move = record.emergence.cognitiveMove ?? "";
    const blockingFlags = (record.emergence.qualityFlags ?? []).filter((flag) => flag !== "association-unverified");
    return ["question", "analogy", "speculation", "confusion", "reflection"].includes(move)
      && blockingFlags.length === 0
      && continuity.includes(record);
  });
  const generatedRate = (count: number) => generated.length === 0 ? 0 : count / generated.length;
  return {
    records,
    metrics: {
      cycles: records.length,
      preGenerationSilenceRate: records.length === 0 ? 0
        : records.filter((record) => !record.workspace.allowEmergence).length / records.length,
      averageActiveSetSize: average(records.map((record) => record.activeSetSize)),
      averageWorkspaceSize: average(records.map((record) => record.workspace.itemIds.length)),
      uniqueTraceRatio: activationCount === 0 ? 0 : traceIds.size / activationCount,
      resolvedSuppressionCount: records.reduce((sum, record) =>
        sum + record.activations.filter((item) => item.resolvedSuppressed).length, 0),
      associativeExpansionRate: records.length === 0 ? 0 : expanded.length / records.length,
      averageAssociativeItems: average(records.map((record) => record.workspace.expansion?.added ?? 0)),
      associationMechanismDistribution: mechanismDistribution,
      generatedThoughts: generated.length,
      modelSilenceRate: modelCalls.length === 0 ? 0
        : modelCalls.filter((record) => record.emergence.outcome === "model-no-thought").length / modelCalls.length,
      thoughtLexicalDiversity: average(thoughtDistances),
      cognitiveMoveDistribution: moveDistribution,
      associativeThoughtRate: generatedRate(associativeThoughts.length),
      usefulAssociativeThoughtRate: generatedRate(usefulAssociative.length),
      unverifiedAssociativeAssertionRate: generatedRate(unverifiedAssociative.length),
      thoughtWorkspaceLexicalContinuityRate: generatedRate(continuity.length),
      endogenousWorkspaceRate: records.length === 0 ? 0
        : records.filter((record) => record.workspace.origin === "endogenous").length / records.length,
    },
  };
}
