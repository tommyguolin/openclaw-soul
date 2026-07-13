import { randomBytes } from "node:crypto";
import { contentTokens, jaccard } from "../thought-emergence.js";
import type { ActivationConfig, ActivationResult, CognitiveWorkspace } from "./types.js";
import { DEFAULT_ACTIVATION_CONFIG } from "./types.js";

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values: number[], average: number): number {
  return values.length < 2 ? 0 : Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

export function buildCognitiveWorkspace(
  results: ActivationResult[],
  now: number,
  stimulusId?: string,
  partialConfig: Partial<ActivationConfig> = {},
): CognitiveWorkspace {
  const config = { ...DEFAULT_ACTIVATION_CONFIG, ...partialConfig };
  const values = results.map((result) => result.state.activation).filter((value) => value > 0);
  const average = mean(values);
  const threshold = Math.max(
    config.baseWorkspaceThreshold,
    average + config.workspaceDeviationFactor * deviation(values, average),
  );
  const ranked = results
    .filter((result) => !result.resolvedSuppressed && result.state.activation >= threshold)
    .sort((a, b) => b.state.activation - a.state.activation || b.trace.timestamp - a.trace.timestamp);
  const dominant = results
    .filter((result) => !result.resolvedSuppressed)
    .sort((a, b) => b.state.activation - a.state.activation)[0];

  let selected: ActivationResult[] = [];
  if (dominant && dominant.state.activation >= config.hardDominantThreshold) {
    selected = [dominant, ...ranked.filter((result) => result.trace.id !== dominant.trace.id)]
      .slice(0, config.maxWorkspaceItems);
  } else if (ranked.length >= 2) {
    const seed = ranked[0];
    const seedTokens = contentTokens(seed.trace.content);
    selected = [seed, ...ranked.slice(1).filter((result) =>
      jaccard(seedTokens, contentTokens(result.trace.content)) >= 0.08)]
      .slice(0, config.maxWorkspaceItems);
    if (selected.length < 2) selected = [];
  }

  const aggregateActivation = selected.length === 0
    ? 0
    : mean(selected.map((result) => result.state.activation));
  let distribution: CognitiveWorkspace["distribution"] = "diffuse";
  if (selected.length === 1) distribution = "single-dominant";
  if (selected.length > 1) distribution = "clustered";

  return {
    id: randomBytes(8).toString("hex"),
    createdAt: now,
    stimulusId,
    items: selected.map((result) => ({
      trace: result.trace,
      activation: result.state.activation,
      fatigue: result.state.fatigue,
      contributions: result.contributions,
      selectionReason: result.trace.id === dominant?.trace.id
        ? "highest activation"
        : "above dynamic threshold and coherent with dominant trace",
    })),
    distribution,
    relations: selected.length > 1 ? ["association"] : [],
    aggregateActivation,
    allowEmergence: selected.length > 0,
    ...(selected.length === 0 ? { silenceReason: "insufficient-activation-structure" } : {}),
  };
}

export function consumeWorkspace(
  workspace: CognitiveWorkspace,
  results: ActivationResult[],
  now: number,
  partialConfig: Partial<ActivationConfig> = {},
): void {
  const config = { ...DEFAULT_ACTIVATION_CONFIG, ...partialConfig };
  const selected = new Set(workspace.items.map((item) => item.trace.id));
  for (const result of results) {
    if (!selected.has(result.trace.id)) continue;
    result.state.fatigue = Math.min(1, result.state.fatigue + config.fatigueIncrement);
    result.state.consumedCount += 1;
    result.state.lastConsumedAt = now;
    result.state.refractoryUntil = now + config.refractoryMs;
  }
}
