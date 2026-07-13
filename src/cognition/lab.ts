import path from "node:path";
import type { EgoState } from "../types.js";
import { ActivationStore } from "./activation-store.js";
import { CognitiveJournal } from "./cognitive-journal.js";
import { CognitionRunner } from "./runner.js";
import type { ActivationConfig, CognitionCycleRecord, RandomSource } from "./types.js";

export interface CognitionLabOptions {
  outputDirectory: string;
  stimulusIds: string[];
  startTime?: number;
  intervalMs?: number;
  random?: RandomSource;
  config?: Partial<ActivationConfig>;
}

export interface CognitionLabMetrics {
  cycles: number;
  preGenerationSilenceRate: number;
  averageActiveSetSize: number;
  averageWorkspaceSize: number;
  uniqueTraceRatio: number;
  resolvedSuppressionCount: number;
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
  for (const sourceId of options.stimulusIds) {
    runner.enqueueStimulus({ type: "manual-test", sourceId, timestamp: now });
    const result = await runner.run(ego);
    if (result) records.push(result.record);
    now += interval;
  }
  const traceIds = new Set(records.flatMap((record) => record.activations.map((item) => item.traceId)));
  const activationCount = records.reduce((sum, record) => sum + record.activations.length, 0);
  const average = (values: number[]) => values.length === 0 ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
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
    },
  };
}
