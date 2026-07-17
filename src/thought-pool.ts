import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyThoughtQualityFlags, contentTokens, jaccard } from "./thought-emergence.js";

export type ThoughtCandidateState = "new" | "incubating" | "attended" | "faded";
export type EpistemicNature =
  | "claim"
  | "question"
  | "association"
  | "tension"
  | "observation"
  | "reframing"
  | "uncertain";

export interface ThoughtCandidateScores {
  novelty: number;
  coherence: number;
  resonance: number;
  userRelevance: number;
}

export interface ThoughtCandidate {
  id: string;
  content: string;
  sourceMemoryIds: string[];
  sourceClusters: string[];
  sourceMemoryTimestamps: number[];
  stimulusKeys: string[];
  activationHistory: Array<{
    fingerprint: string;
    sourceMemoryIds: string[];
    sourceClusters: string[];
    activatedAt: number;
  }>;
  distinctActivationCount: number;
  cognitiveMove: string;
  qualityFlags: string[];
  cleanActivationStreak: number;
  scores: ThoughtCandidateScores;
  attentionScore: number;
  maturity: number;
  activations: number;
  state: ThoughtCandidateState;
  createdAt: number;
  updatedAt: number;
  lastActivatedAt: number;
  attendedAt?: number;
  expressionEvaluatedAt?: number;
  expressedAt?: number;
  resolvedAt?: number;
  contradictedPremise?: boolean;
  /** Shadow candidates are private and can never directly execute an action. */
  shadow: true;
  /** v3.1 fields: causal origin and cognition-specific attention policy. */
  epistemicNature?: EpistemicNature;
  originWorkspaceId?: string;
  causalTraceIds?: string[];
  groundedEvidenceIds?: string[];
  stimulusIds?: string[];
  thoughtEpisodeId?: string;
}

export interface ResolutionRecord {
  id: string;
  topicKey: string;
  resolutionText: string;
  topicTokens: string[];
  resolvedAt: number;
  evidenceMemoryIds: string[];
  status: "resolved" | "reopened";
  reopenedAt?: number;
}

export interface ThoughtPoolFile {
  version: 3;
  candidateSchemaVersion: "3.1";
  candidates: ThoughtCandidate[];
  resolutions: ResolutionRecord[];
  observationCycles: number;
  silenceCycles: number;
  updatedAt: number;
  metrics: ThoughtPoolMetrics;
}

export interface ThoughtPoolMetrics {
  calculatedAt: number;
  candidates: number;
  totalActivations: number;
  stateCounts: Record<ThoughtCandidateState, number>;
  cognitiveMoveDistribution: Record<string, number>;
  repeatedActivationRate: number;
  maturityRate: number;
  attendedRate: number;
  crossTopicAssociationRate: number;
  sourceMemoryDiversityRate: number;
  usefulSurpriseRate: number;
  nonsenseRate: number;
  lowCoherenceRate: number;
  metaFramingRate: number;
  taskPressureRate: number;
  contradictedPremiseRate: number;
  resolvedTopicRecurrenceRate: number;
  naturalSilenceRate: number;
  unsupportedUncertaintyRate: number;
  unverifiedAssociationRate: number;
  contextContinuityRate: number;
  thoughtSpecificityRate: number;
  meanSourceMemoryAgeDays: number;
  sourceMemoryAgeBuckets: { lt1d: number; oneTo7d: number; sevenTo30d: number; gte30d: number };
  activationsPerDay: number;
}

export interface NewThoughtCandidate {
  content: string;
  sourceMemoryIds: string[];
  sourceClusters: string[];
  sourceMemoryTimestamps?: number[];
  stimulusKey?: string;
  cognitiveMove: string;
  qualityFlags: string[];
  scores: ThoughtCandidateScores;
  /** Only independently grounded evidence may mature a candidate. */
  evidenceMemoryIds?: string[];
  evidenceTimestamps?: number[];
  epistemicNature?: EpistemicNature;
  originWorkspaceId?: string;
  causalTraceIds?: string[];
  stimulusId?: string;
  thoughtEpisodeId?: string;
}

const MAX_CANDIDATES = 500;

function activationFingerprint(input: Pick<NewThoughtCandidate, "sourceMemoryIds" | "sourceClusters" | "evidenceMemoryIds">): string {
  const evidence = input.evidenceMemoryIds === undefined ? input.sourceMemoryIds : input.evidenceMemoryIds;
  return evidence.length > 0 ? `evidence:${[...new Set(evidence)].sort().join(",")}` : "ungrounded";
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function inferEpistemicNature(content: string, cognitiveMove: string): EpistemicNature {
  if (cognitiveMove === "question" || /[?？]\s*$/.test(content.trim())) return "question";
  if (cognitiveMove === "analogy") return "association";
  if (cognitiveMove === "confusion" || /矛盾|张力|冲突|tension|conflict|doesn't fit/i.test(content)) return "tension";
  if (/重新理解|换个角度|并不是.*而是|reframe|rather than|not .* but/i.test(content)) return "reframing";
  if (cognitiveMove === "reflection") return "observation";
  if (/[.!。！]\s*$/.test(content.trim())) return "claim";
  return "uncertain";
}

export function isAttentionEligibleV31(
  candidate: ThoughtCandidate,
  minScore = 0.65,
): boolean {
  if (!(["new", "incubating"] as ThoughtCandidateState[]).includes(candidate.state) || candidate.qualityFlags.length > 0
    || candidate.contradictedPremise || candidate.scores.coherence < 0.65) return false;
  const nature = candidate.epistemicNature ?? "uncertain";
  if (nature === "claim" || nature === "uncertain") {
    return candidate.state === "incubating"
      && candidate.distinctActivationCount >= 3
      && candidate.maturity >= 0.4
      && (candidate.groundedEvidenceIds?.length ?? 0) >= 1
      && candidate.attentionScore >= minScore;
  }
  if (!candidate.originWorkspaceId || candidate.scores.userRelevance < 0.6) return false;
  const specificObservation = ["observation", "reframing"].includes(nature)
    && contentTokens(candidate.content).length >= 6
    && candidate.scores.coherence >= 0.75;
  return (candidate.activations >= 2 && (candidate.stimulusIds?.length ?? 0) >= 2) || specificObservation;
}

export function calculateAttentionScore(
  scores: ThoughtCandidateScores,
  maturity: number,
  qualityFlags: string[],
): number {
  const qualityPenalty = (qualityFlags.includes("meta-framing") ? 0.25 : 0)
    + (qualityFlags.includes("forced-association") ? 0.2 : 0)
    + (qualityFlags.includes("task-pressure") ? 0.15 : 0)
    // Epistemic hold, not a nonsense penalty: it may remain a useful private hypothesis.
    + (qualityFlags.includes("association-unverified") ? 0.05 : 0)
    + (qualityFlags.includes("truncated") ? 0.2 : 0);
  return clamp01(
    scores.novelty * 0.3
    + scores.coherence * 0.25
    + scores.resonance * 0.2
    + scores.userRelevance * 0.15
    + clamp01(maturity) * 0.1
    - qualityPenalty,
  );
}

export function resolveThoughtPoolPath(storePath: string): string {
  return path.join(path.dirname(path.resolve(storePath)), "thought-pool.json");
}

export function resolveThoughtPoolV31ShadowPath(storePath: string): string {
  return path.join(path.dirname(path.resolve(storePath)), "thought-pool-v31-shadow.json");
}

export function calculateThoughtPoolMetrics(candidates: ThoughtCandidate[], now = Date.now()): ThoughtPoolMetrics {
  const total = candidates.length;
  const rate = (count: number) => total > 0 ? count / total : 0;
  const stateCounts: Record<ThoughtCandidateState, number> = { new: 0, incubating: 0, attended: 0, faded: 0 };
  const cognitiveMoveDistribution: Record<string, number> = {};
  const ages: number[] = [];
  for (const candidate of candidates) {
    stateCounts[candidate.state] += 1;
    cognitiveMoveDistribution[candidate.cognitiveMove] = (cognitiveMoveDistribution[candidate.cognitiveMove] ?? 0) + 1;
    for (const timestamp of candidate.sourceMemoryTimestamps ?? []) {
      if (Number.isFinite(timestamp) && timestamp > 0) ages.push(Math.max(0, (now - timestamp) / 86_400_000));
    }
  }
  return {
    calculatedAt: now,
    candidates: total,
    totalActivations: candidates.reduce((sum, candidate) => sum + candidate.activations, 0),
    stateCounts,
    cognitiveMoveDistribution,
    repeatedActivationRate: rate(candidates.filter((candidate) => candidate.activations > 1).length),
    maturityRate: rate(candidates.filter((candidate) => candidate.maturity >= 0.4 && candidate.distinctActivationCount >= 3).length),
    attendedRate: rate(stateCounts.attended),
    crossTopicAssociationRate: rate(candidates.filter((candidate) => {
      const grounded = candidate.activationHistory.filter((activation) => activation.fingerprint !== "ungrounded");
      return grounded.some((left, index) => grounded.slice(index + 1).some((right) =>
        jaccard(new Set(left.sourceClusters), new Set(right.sourceClusters)) < 0.2));
    }).length),
    sourceMemoryDiversityRate: rate(candidates.filter((candidate) => candidate.sourceMemoryIds.length >= 2).length),
    usefulSurpriseRate: rate(candidates.filter((candidate) =>
      candidate.scores.novelty >= 0.7
      && candidate.scores.coherence >= 0.65
      && Math.max(candidate.scores.resonance, candidate.scores.userRelevance) >= 0.6
      && candidate.distinctActivationCount >= 2
      && candidate.qualityFlags.length === 0).length),
    nonsenseRate: rate(candidates.filter((candidate) => candidate.scores.coherence < 0.4).length),
    lowCoherenceRate: rate(candidates.filter((candidate) => candidate.scores.coherence < 0.4).length),
    metaFramingRate: rate(candidates.filter((candidate) => candidate.qualityFlags.includes("meta-framing")).length),
    taskPressureRate: rate(candidates.filter((candidate) => candidate.qualityFlags.includes("task-pressure")).length),
    contradictedPremiseRate: rate(candidates.filter((candidate) => candidate.contradictedPremise).length),
    resolvedTopicRecurrenceRate: rate(candidates.filter((candidate) => candidate.qualityFlags.includes("resolved-topic-recurrence")).length),
    naturalSilenceRate: 0,
    unsupportedUncertaintyRate: rate(candidates.filter((candidate) =>
      /(?:maybe|perhaps|could|might|不确定|也许|或许|可能)/i.test(candidate.content)
      && candidate.activationHistory.every((activation) => activation.fingerprint === "ungrounded")).length),
    unverifiedAssociationRate: rate(candidates.filter((candidate) =>
      candidate.qualityFlags.includes("association-unverified")).length),
    contextContinuityRate: rate(candidates.filter((candidate) =>
      candidate.sourceMemoryTimestamps.some((timestamp) => now - timestamp < 24 * 60 * 60 * 1000)).length),
    thoughtSpecificityRate: rate(candidates.filter((candidate) =>
      contentTokens(candidate.content).length >= 6
      && /(?:\d+(?:\.\d+)?%?|[A-Za-z]+\d+|[\w.-]+\.(?:log|json|csv|ts|js|py)|(?:[A-Za-z]:)?[\\/][\w./-]+)/i.test(candidate.content)).length),
    meanSourceMemoryAgeDays: ages.length > 0 ? ages.reduce((sum, age) => sum + age, 0) / ages.length : 0,
    sourceMemoryAgeBuckets: {
      lt1d: ages.filter((age) => age < 1).length,
      oneTo7d: ages.filter((age) => age >= 1 && age < 7).length,
      sevenTo30d: ages.filter((age) => age >= 7 && age < 30).length,
      gte30d: ages.filter((age) => age >= 30).length,
    },
    activationsPerDay: (() => {
      const times = candidates.flatMap((candidate) => candidate.activationHistory.map((activation) => activation.activatedAt));
      if (times.length === 0) return 0;
      const spanDays = Math.max(1, (now - Math.min(...times)) / 86_400_000);
      return candidates.reduce((sum, candidate) => sum + candidate.activations, 0) / spanDays;
    })(),
  };
}

export class ThoughtPool {
  readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async load(): Promise<ThoughtPoolFile> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")) as {
        version?: number;
        candidates?: ThoughtCandidate[];
        resolutions?: ResolutionRecord[];
        observationCycles?: number;
        silenceCycles?: number;
        updatedAt?: number;
      };
      if ([1, 2, 3].includes(parsed.version ?? 0) && Array.isArray(parsed.candidates)) {
        const candidates = parsed.candidates.map((candidate) => this.normalizeCandidate(candidate));
        const observationCycles = parsed.observationCycles ?? 0;
        const silenceCycles = parsed.silenceCycles ?? 0;
        const metrics = calculateThoughtPoolMetrics(candidates);
        metrics.naturalSilenceRate = observationCycles > 0 ? silenceCycles / observationCycles : 0;
        return {
          version: 3,
          candidateSchemaVersion: "3.1",
          candidates,
          resolutions: Array.isArray(parsed.resolutions) ? parsed.resolutions : [],
          observationCycles,
          silenceCycles,
          updatedAt: parsed.updatedAt ?? Date.now(),
          metrics,
        };
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    return { version: 3, candidateSchemaVersion: "3.1", candidates: [], resolutions: [], observationCycles: 0, silenceCycles: 0, updatedAt: Date.now(), metrics: calculateThoughtPoolMetrics([]) };
  }

  async initialize(): Promise<ThoughtPoolFile> {
    const store = await this.load();
    await this.save(store);
    return store;
  }

  private normalizeCandidate(candidate: ThoughtCandidate): ThoughtCandidate {
    const fingerprint = activationFingerprint(candidate);
    const qualityFlags = [...new Set([
      ...(Array.isArray(candidate.qualityFlags) ? candidate.qualityFlags : []),
      ...classifyThoughtQualityFlags(candidate.content),
    ])];
    const activationHistory = Array.isArray(candidate.activationHistory) && candidate.activationHistory.length > 0
      ? candidate.activationHistory
      : [{
        fingerprint,
        sourceMemoryIds: [...(candidate.sourceMemoryIds ?? [])],
        sourceClusters: [...(candidate.sourceClusters ?? [])],
        activatedAt: candidate.lastActivatedAt ?? candidate.createdAt ?? Date.now(),
      }];
    return {
      ...candidate,
      qualityFlags,
      sourceMemoryTimestamps: Array.isArray(candidate.sourceMemoryTimestamps) ? candidate.sourceMemoryTimestamps : [],
      stimulusKeys: Array.isArray(candidate.stimulusKeys) ? candidate.stimulusKeys : [],
      activationHistory,
      distinctActivationCount: new Set(activationHistory.map((activation) => activation.fingerprint)).size,
      cleanActivationStreak: Number.isFinite(candidate.cleanActivationStreak)
        ? candidate.cleanActivationStreak
        : qualityFlags.length === 0 ? 1 : 0,
      attentionScore: calculateAttentionScore(candidate.scores, candidate.maturity, qualityFlags),
      epistemicNature: candidate.epistemicNature ?? "uncertain",
      causalTraceIds: Array.isArray(candidate.causalTraceIds) ? candidate.causalTraceIds : [],
      groundedEvidenceIds: Array.isArray(candidate.groundedEvidenceIds) ? candidate.groundedEvidenceIds : [],
      stimulusIds: Array.isArray(candidate.stimulusIds) ? candidate.stimulusIds : [],
    };
  }

  private save(store: ThoughtPoolFile): Promise<void> {
    const write = async () => {
      store.version = 3;
      store.candidateSchemaVersion = "3.1";
      store.metrics = calculateThoughtPoolMetrics(store.candidates);
      store.metrics.naturalSilenceRate = store.observationCycles > 0 ? store.silenceCycles / store.observationCycles : 0;
      const directory = path.dirname(this.filePath);
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
      await fs.promises.rename(tmp, this.filePath).catch(async (err) => {
        if ((err as { code?: string }).code !== "EPERM" && (err as { code?: string }).code !== "EEXIST") throw err;
        await fs.promises.copyFile(tmp, this.filePath);
        await fs.promises.unlink(tmp).catch(() => undefined);
      });
      await fs.promises.chmod(this.filePath, 0o600).catch(() => undefined);
    };
    const pending = this.writeChain.then(write, write);
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  async addCandidate(input: NewThoughtCandidate): Promise<{ candidate: ThoughtCandidate; merged: boolean }> {
    const store = await this.load();
    const now = Date.now();
    this.applyDecay(store.candidates, now);
    const incomingTokens = contentTokens(input.content);
    const normalizedStimulusKey = input.stimulusKey?.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const existing = [...store.candidates]
      .filter((candidate) => candidate.state === "new" || candidate.state === "incubating")
      .map((candidate) => ({
        candidate,
        similarity: jaccard(incomingTokens, contentTokens(candidate.content)),
        sameStimulus: Boolean(normalizedStimulusKey && candidate.stimulusKeys.includes(normalizedStimulusKey)),
        sameMoveAndClusters: candidate.cognitiveMove === input.cognitiveMove
          && jaccard(candidate.sourceClusters, input.sourceClusters) >= 0.5,
      }))
      .filter((entry) => entry.similarity >= 0.55
        || (entry.sameStimulus && (entry.similarity >= 0.08 || entry.sameMoveAndClusters)))
      .sort((a, b) => Number(b.sameStimulus) - Number(a.sameStimulus) || b.similarity - a.similarity)[0];

    if (existing) {
      const candidate = existing.candidate;
      candidate.activations += 1;
      const fingerprint = activationFingerprint(input);
      const distinct = fingerprint !== "ungrounded"
        && !candidate.activationHistory.some((activation) => activation.fingerprint === fingerprint);
      candidate.activationHistory.push({
        fingerprint,
        sourceMemoryIds: [...new Set(input.sourceMemoryIds)],
        sourceClusters: [...new Set(input.sourceClusters)],
        activatedAt: now,
      });
      candidate.activationHistory = candidate.activationHistory.slice(-20);
      candidate.distinctActivationCount = new Set(candidate.activationHistory.map((activation) => activation.fingerprint)).size;
      if (distinct) candidate.maturity = clamp01(candidate.maturity + 0.15);
      if (candidate.distinctActivationCount >= 2) candidate.state = "incubating";
      candidate.updatedAt = now;
      candidate.lastActivatedAt = now;
      candidate.sourceMemoryIds = [...new Set([...candidate.sourceMemoryIds, ...input.sourceMemoryIds])];
      candidate.sourceClusters = [...new Set([...candidate.sourceClusters, ...input.sourceClusters])];
      candidate.sourceMemoryTimestamps = [...new Set([
        ...candidate.sourceMemoryTimestamps,
        ...(input.sourceMemoryTimestamps ?? []),
      ])];
      if (normalizedStimulusKey) {
        candidate.stimulusKeys = [...new Set([...candidate.stimulusKeys, normalizedStimulusKey])].slice(-20);
      }
      candidate.epistemicNature = candidate.epistemicNature === "uncertain"
        ? (input.epistemicNature ?? inferEpistemicNature(input.content, input.cognitiveMove))
        : candidate.epistemicNature;
      candidate.originWorkspaceId ??= input.originWorkspaceId;
      candidate.thoughtEpisodeId ??= input.thoughtEpisodeId;
      candidate.causalTraceIds = [...new Set([...(candidate.causalTraceIds ?? []), ...(input.causalTraceIds ?? [])])];
      candidate.groundedEvidenceIds = [...new Set([...(candidate.groundedEvidenceIds ?? []), ...(input.evidenceMemoryIds ?? [])])];
      if (input.stimulusId) candidate.stimulusIds = [...new Set([...(candidate.stimulusIds ?? []), input.stimulusId])];
      const nature = candidate.epistemicNature ?? "uncertain";
      if (!["claim", "uncertain"].includes(nature)
        && candidate.originWorkspaceId
        && (candidate.stimulusIds?.length ?? 0) >= 2) {
        candidate.state = "incubating";
      }
      if (input.qualityFlags.length === 0) {
        candidate.cleanActivationStreak += 1;
        if (candidate.cleanActivationStreak >= 2) {
          candidate.qualityFlags = candidate.qualityFlags.filter((flag) => flag !== "task-pressure" && flag !== "truncated");
        }
        if (candidate.cleanActivationStreak >= 3) {
          candidate.qualityFlags = candidate.qualityFlags.filter((flag) =>
            flag !== "meta-framing" && flag !== "forced-association");
        }
      } else {
        candidate.cleanActivationStreak = 0;
        candidate.qualityFlags = [...new Set([...candidate.qualityFlags, ...input.qualityFlags])];
      }
      // Rewording an existing candidate is unsurprising, but it should not
      // erase the novelty of the underlying connection that created it.
      candidate.scores.novelty = clamp01(Math.max(candidate.scores.novelty, input.scores.novelty));
      candidate.scores.coherence = clamp01(input.qualityFlags.length === 0
        ? (candidate.scores.coherence + input.scores.coherence) / 2
        : Math.min(candidate.scores.coherence, input.scores.coherence));
      candidate.scores.resonance = clamp01(Math.max(candidate.scores.resonance, input.scores.resonance));
      candidate.scores.userRelevance = clamp01(Math.max(candidate.scores.userRelevance, input.scores.userRelevance));
      candidate.attentionScore = calculateAttentionScore(candidate.scores, candidate.maturity, candidate.qualityFlags);
      store.updatedAt = now;
      await this.save(store);
      return { candidate, merged: true };
    }

    const maturity = 0.1;
    const fingerprint = activationFingerprint(input);
    const candidate: ThoughtCandidate = {
      id: randomBytes(8).toString("hex"),
      content: input.content,
      sourceMemoryIds: [...new Set(input.sourceMemoryIds)],
      sourceClusters: [...new Set(input.sourceClusters)],
      sourceMemoryTimestamps: [...new Set(input.sourceMemoryTimestamps ?? [])],
      stimulusKeys: normalizedStimulusKey ? [normalizedStimulusKey] : [],
      activationHistory: [{
        fingerprint,
        sourceMemoryIds: [...new Set(input.sourceMemoryIds)],
        sourceClusters: [...new Set(input.sourceClusters)],
        activatedAt: now,
      }],
      distinctActivationCount: 1,
      cognitiveMove: input.cognitiveMove,
      qualityFlags: [...new Set(input.qualityFlags)],
      cleanActivationStreak: input.qualityFlags.length === 0 ? 1 : 0,
      scores: {
        novelty: clamp01(input.scores.novelty),
        coherence: clamp01(input.scores.coherence),
        resonance: clamp01(input.scores.resonance),
        userRelevance: clamp01(input.scores.userRelevance),
      },
      attentionScore: 0,
      maturity,
      activations: 1,
      state: "new",
      createdAt: now,
      updatedAt: now,
      lastActivatedAt: now,
      shadow: true,
      epistemicNature: input.epistemicNature ?? inferEpistemicNature(input.content, input.cognitiveMove),
      ...(input.originWorkspaceId ? { originWorkspaceId: input.originWorkspaceId } : {}),
      ...(input.thoughtEpisodeId ? { thoughtEpisodeId: input.thoughtEpisodeId } : {}),
      causalTraceIds: [...new Set(input.causalTraceIds ?? [])],
      groundedEvidenceIds: [...new Set(input.evidenceMemoryIds ?? [])],
      stimulusIds: input.stimulusId ? [input.stimulusId] : [],
    };
    candidate.attentionScore = calculateAttentionScore(candidate.scores, maturity, candidate.qualityFlags);
    store.candidates.push(candidate);
    store.candidates = store.candidates
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CANDIDATES);
    store.updatedAt = now;
    await this.save(store);
    return { candidate, merged: false };
  }

  async recordObservation(silence: boolean): Promise<void> {
    const store = await this.load();
    store.observationCycles += 1;
    if (silence) store.silenceCycles += 1;
    store.updatedAt = Date.now();
    await this.save(store);
  }

  /** Recompute legacy maturity using only semantically related grounded memories. */
  async revalidateEvidence(groundedMemories: ReadonlyMap<string, string>): Promise<number> {
    const store = await this.load();
    let changed = 0;
    for (const candidate of store.candidates) {
      if (candidate.state === "faded") continue;
      const candidateTokens = new Set(contentTokens(candidate.content));
      const groundedFingerprints = new Set<string>();
      for (const activation of candidate.activationHistory) {
        const evidenceIds = activation.sourceMemoryIds.filter((id) => {
          const content = groundedMemories.get(id);
          return content !== undefined && jaccard(candidateTokens, new Set(contentTokens(content))) >= 0.08;
        });
        if (evidenceIds.length > 0) groundedFingerprints.add(`evidence:${evidenceIds.sort().join(",")}`);
        activation.fingerprint = evidenceIds.length > 0
          ? `evidence:${evidenceIds.sort().join(",")}`
          : "ungrounded";
      }
      const distinct = groundedFingerprints.size;
      const nextCount = Math.max(1, distinct);
      const nextMaturity = clamp01(0.1 + Math.max(0, distinct - 1) * 0.15);
      const nextState: ThoughtCandidateState = distinct >= 2 ? "incubating" : "new";
      if (candidate.distinctActivationCount !== nextCount
        || candidate.maturity !== nextMaturity
        || candidate.state !== nextState) {
        candidate.distinctActivationCount = nextCount;
        candidate.maturity = nextMaturity;
        candidate.state = nextState;
        delete candidate.attendedAt;
        delete candidate.expressionEvaluatedAt;
        delete candidate.expressedAt;
        candidate.attentionScore = calculateAttentionScore(candidate.scores, nextMaturity, candidate.qualityFlags);
        candidate.updatedAt = Date.now();
        changed += 1;
      }
    }
    if (changed > 0) {
      store.updatedAt = Date.now();
      await this.save(store);
    }
    return changed;
  }

  async registerResolution(input: {
    topicKey: string;
    resolutionText: string;
    evidenceMemoryIds?: string[];
    resolvedAt?: number;
  }): Promise<ResolutionRecord> {
    const store = await this.load();
    const now = input.resolvedAt ?? Date.now();
    const topicTokens = [...new Set(contentTokens(`${input.topicKey} ${input.resolutionText}`))];
    const existing = store.resolutions.find((item) => item.topicKey === input.topicKey);
    const record: ResolutionRecord = existing ?? {
      id: randomBytes(8).toString("hex"),
      topicKey: input.topicKey,
      resolutionText: input.resolutionText,
      topicTokens,
      resolvedAt: now,
      evidenceMemoryIds: [],
      status: "resolved",
    };
    record.resolutionText = input.resolutionText;
    record.topicTokens = topicTokens;
    record.resolvedAt = now;
    record.evidenceMemoryIds = [...new Set([...(record.evidenceMemoryIds ?? []), ...(input.evidenceMemoryIds ?? [])])];
    record.status = "resolved";
    delete record.reopenedAt;
    if (!existing) store.resolutions.push(record);
    store.updatedAt = now;
    await this.save(store);
    return record;
  }

  async reopenRelatedResolution(evidenceText: string, evidenceAt = Date.now()): Promise<ResolutionRecord[]> {
    const store = await this.load();
    const tokens = new Set(contentTokens(evidenceText));
    const reopened = store.resolutions.filter((record) => record.status === "resolved"
      && jaccard(tokens, new Set(record.topicTokens)) >= 0.12);
    for (const record of reopened) {
      record.status = "reopened";
      record.reopenedAt = evidenceAt;
    }
    if (reopened.length > 0) {
      store.updatedAt = evidenceAt;
      await this.save(store);
    }
    return reopened;
  }

  async findContradictingResolution(content: string, cognitiveMove?: string): Promise<ResolutionRecord | undefined> {
    const store = await this.load();
    const tokens = new Set(contentTokens(content));
    const sshSetupRecheck =
      /(?:192\.168\.1\.206|\/diskb\/btc_1|\bssh\b|sshd|authorized_keys|PermitRootLogin|PubkeyAuthentication|\broot\b)/i.test(content) &&
      /(?:confirm|verify|whether|allowed|login|publickey|\u786e\u8ba4|\u6838\u5b9e|\u662f\u5426|\u5141\u8bb8|\u767b\u5f55|\u767b\u5165|\u516c\u94a5|\u514d\u5bc6|\u91cd\u542f)/i.test(content);
    if (sshSetupRecheck) {
      const resolvedSsh = store.resolutions.find((record) =>
        record.status === "resolved" && record.topicKey === "ssh-access:192.168.1.206");
      if (resolvedSsh) return resolvedSsh;
    }
    const expressesProblem = ["question", "confusion", "speculation"].includes(cognitiveMove ?? "")
      || /(?:fail|failed|failing|unable|cannot|can't|broken|problem|issue|still|不确定|失败|无法|不能|连不上|有问题|仍然|是否)/i.test(content);
    if (!expressesProblem) return undefined;
    return store.resolutions
      .filter((record) => record.status === "resolved")
      .map((record) => ({ record, overlap: jaccard(tokens, new Set(record.topicTokens)) }))
      .filter((entry) => entry.overlap >= 0.12)
      .sort((a, b) => b.overlap - a.overlap)[0]?.record;
  }

  async getAttentionCandidates(minScore = 0.65, limit = 20): Promise<ThoughtCandidate[]> {
    const store = await this.load();
    const changed = this.applyDecay(store.candidates, Date.now());
    if (changed) {
      store.updatedAt = Date.now();
      await this.save(store);
    }
    return store.candidates
      .filter((candidate) => candidate.state === "incubating"
        && candidate.distinctActivationCount >= 3
        && candidate.maturity >= 0.4
        && candidate.scores.coherence >= 0.65
        && candidate.qualityFlags.length === 0
        && candidate.attentionScore >= minScore)
      .sort((a, b) => b.attentionScore - a.attentionScore)
      .slice(0, limit);
  }

  async getAttentionCandidatesV31(minScore = 0.65, limit = 20): Promise<ThoughtCandidate[]> {
    const store = await this.load();
    const changed = this.applyDecay(store.candidates, Date.now());
    if (changed) {
      store.updatedAt = Date.now();
      await this.save(store);
    }
    return store.candidates
      .filter((candidate) => isAttentionEligibleV31(candidate, minScore))
      .sort((a, b) => b.attentionScore - a.attentionScore)
      .slice(0, limit);
  }

  async markAttended(candidateId: string): Promise<ThoughtCandidate | undefined> {
    const store = await this.load();
    const candidate = store.candidates.find((item) => item.id === candidateId);
    if (!candidate || candidate.state !== "incubating") return undefined;
    candidate.state = "attended";
    candidate.attendedAt = Date.now();
    candidate.updatedAt = candidate.attendedAt;
    store.updatedAt = Date.now();
    await this.save(store);
    return candidate;
  }

  async getExpressionCandidates(minAgeMs = 5 * 60 * 1000, limit = 5): Promise<ThoughtCandidate[]> {
    const now = Date.now();
    const store = await this.load();
    return store.candidates
      .filter((candidate) => candidate.state === "attended"
        && !candidate.expressionEvaluatedAt
        && !candidate.expressedAt
        && now - (candidate.attendedAt ?? candidate.updatedAt) >= minAgeMs
        && candidate.distinctActivationCount >= 3
        && candidate.scores.coherence >= 0.7
        && candidate.scores.userRelevance >= 0.6
        && candidate.qualityFlags.length === 0
        && ["question", "analogy", "speculation", "confusion", "reflection"].includes(candidate.cognitiveMove))
      .sort((a, b) => b.attentionScore - a.attentionScore)
      .slice(0, limit);
  }

  async getExpressionCandidatesV31(minAgeMs = 5 * 60 * 1000, limit = 5): Promise<ThoughtCandidate[]> {
    const now = Date.now();
    const store = await this.load();
    return store.candidates
      .filter((candidate) => candidate.state === "attended"
        && candidate.originWorkspaceId
        && !candidate.expressionEvaluatedAt
        && !candidate.expressedAt
        && now - (candidate.attendedAt ?? candidate.updatedAt) >= minAgeMs
        && candidate.scores.coherence >= 0.7
        && candidate.scores.userRelevance >= 0.6
        && candidate.qualityFlags.length === 0)
      .sort((a, b) => b.attentionScore - a.attentionScore)
      .slice(0, limit);
  }

  async markExpressionEvaluated(candidateId: string, expressed: boolean): Promise<ThoughtCandidate | undefined> {
    const store = await this.load();
    const candidate = store.candidates.find((item) => item.id === candidateId);
    if (!candidate || candidate.state !== "attended") return undefined;
    const now = Date.now();
    candidate.expressionEvaluatedAt = now;
    if (expressed) candidate.expressedAt = now;
    candidate.updatedAt = now;
    store.updatedAt = now;
    await this.save(store);
    return candidate;
  }

  /** Fade private ideas whose premise has been explicitly corrected or resolved. */
  async fadeRelatedCandidates(resolutionText: string): Promise<ThoughtCandidate[]> {
    const store = await this.load();
    const resolutionTokens = new Set(contentTokens(resolutionText));
    if (resolutionTokens.size === 0) return [];
    const now = Date.now();
    const faded: ThoughtCandidate[] = [];
    for (const candidate of store.candidates) {
      if (candidate.state === "faded") continue;
      const candidateTokens = new Set(contentTokens([
        candidate.content,
        ...candidate.stimulusKeys,
        ...candidate.sourceClusters,
      ].join(" ")));
      const overlap = [...candidateTokens].filter((token) => resolutionTokens.has(token));
      const distinctiveOverlap = overlap.filter((token) => token.length >= 3 || /\d/.test(token));
      if (distinctiveOverlap.length < 2 && jaccard(candidateTokens, resolutionTokens) < 0.12) continue;
      candidate.state = "faded";
      candidate.resolvedAt = now;
      candidate.updatedAt = now;
      faded.push(candidate);
    }
    if (faded.length > 0) {
      store.updatedAt = now;
      await this.save(store);
    }
    return faded;
  }

  /** Fade private ideas matching a deterministic pattern. */
  async fadeMatchingCandidates(pattern: RegExp): Promise<ThoughtCandidate[]> {
    const store = await this.load();
    const now = Date.now();
    const faded: ThoughtCandidate[] = [];
    for (const candidate of store.candidates) {
      if (candidate.state === "faded") continue;
      const haystack = [
        candidate.content,
        ...candidate.stimulusKeys,
        ...candidate.sourceClusters,
      ].join(" ");
      if (!pattern.test(haystack)) continue;
      candidate.state = "faded";
      candidate.resolvedAt = now;
      candidate.updatedAt = now;
      faded.push(candidate);
    }
    if (faded.length > 0) {
      store.updatedAt = now;
      await this.save(store);
    }
    return faded;
  }

  async fadeLowQualitySingletons(
    flags = ["meta-framing", "forced-association"],
    maxMaturity = 0.2,
  ): Promise<ThoughtCandidate[]> {
    const store = await this.load();
    const now = Date.now();
    const flagSet = new Set(flags);
    const faded: ThoughtCandidate[] = [];
    for (const candidate of store.candidates) {
      if (candidate.state === "faded") continue;
      if (candidate.distinctActivationCount > 1 || candidate.maturity > maxMaturity) continue;
      if (!candidate.qualityFlags.some((flag) => flagSet.has(flag))) continue;
      candidate.state = "faded";
      candidate.updatedAt = now;
      faded.push(candidate);
    }
    if (faded.length > 0) {
      store.updatedAt = now;
      await this.save(store);
    }
    return faded;
  }

  private applyDecay(candidates: ThoughtCandidate[], now: number): boolean {
    let changed = false;
    for (const candidate of candidates) {
      if (candidate.state === "attended") continue;
      const ageDays = (now - candidate.lastActivatedAt) / 86_400_000;
      if (ageDays >= 7 && candidate.maturity < 0.5 && candidate.state !== "faded") {
        candidate.state = "faded";
        candidate.updatedAt = now;
        changed = true;
      } else if (ageDays >= 1 && candidate.state !== "faded") {
        const nextMaturity = clamp01(candidate.maturity - Math.min(0.2, ageDays * 0.02));
        if (nextMaturity !== candidate.maturity) {
          candidate.maturity = nextMaturity;
          candidate.attentionScore = calculateAttentionScore(candidate.scores, nextMaturity, candidate.qualityFlags);
          changed = true;
        }
      }
    }
    return changed;
  }
}
