import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildThoughtFromOpportunity,
  detectThoughtOpportunities,
  isExecutionFocusedOpportunity,
} from "./intelligent-thought.js";
import type { DetectedThoughtOpportunity, LLMThoughtGenerator } from "./intelligent-thought.js";
import { loadEgoStore, resolveEgoStorePath } from "./ego-store.js";
import { createSoulLLMGenerator } from "./soul-llm.js";
import type { SoulLLMConfig } from "./soul-llm.js";
import {
  buildSpontaneousPrompt,
  parseSpontaneousResponse,
  classifyCognitiveMove,
  classifyThoughtQualityFlags,
  contentTokens,
  jaccard,
  memoryTopicClusters,
  selectRemoteMemoryPair,
  type RandomSource,
} from "./thought-emergence.js";
export {
  classifyCognitiveMove,
  classifyThoughtQualityFlags,
  contentTokens,
  memoryTopicClusters,
  selectRemoteMemoryPair,
  parseSpontaneousResponse,
} from "./thought-emergence.js";
import type {
  ActionType,
  EgoState,
  SoulMemory,
  Thought,
  ThoughtGenerationContext,
} from "./types.js";

export type ThoughtLabMode = "baseline" | "experiment";
export type ThoughtLabPath = "current" | "spontaneous";

export interface ThoughtLabOptions {
  storePath?: string;
  runs?: number;
  mode?: ThoughtLabMode;
  spontaneousRate?: number;
  seed?: number;
  outputPath?: string;
  llmGenerator?: LLMThoughtGenerator;
}

export interface ThoughtLabRecord {
  run: number;
  path: ThoughtLabPath;
  context: {
    currentHour: number;
    dayOfWeek: number;
    urgentNeeds: string[];
    activeGoals: string[];
    recentMemoryIds: string[];
  };
  opportunities: DetectedThoughtOpportunity[];
  selectedOpportunity: DetectedThoughtOpportunity | null;
  thought: Pick<Thought, "type" | "content" | "source" | "trigger" | "motivation" | "actionType"> | null;
  actionType: ActionType | null;
  sourceMemories: Array<{
    id: string;
    ageDays: number;
    type: SoulMemory["type"];
    tags: string[];
    topicClusters: string[];
    content: string;
  }>;
  sourceMemoryResolution: "explicit" | "lexical-inference" | "none";
  thoughtType: Thought["type"] | null;
  cognitiveMove: string;
  qualityFlags: string[];
  topicKey: string;
  recentStateBefore: {
    thoughtTypes: string[];
    topicKeys: string[];
    actionTypes: string[];
  };
  skippedReason?: string;
}

export interface ThoughtLabMetrics {
  runs: number;
  generated: number;
  skipped: number;
  distributions: {
    path: Record<string, number>;
    opportunitySource: Record<string, number>;
    selectedOpportunitySource: Record<string, number>;
    thoughtType: Record<string, number>;
    actionType: Record<string, number>;
    cognitiveMove: Record<string, number>;
    qualityFlag: Record<string, number>;
    sourceMemoryAge: Record<string, number>;
  };
  noOpRate: number;
  sameTopicRepetitionRate: number;
  semanticDiversity: number;
  cognitiveMoveDiversity: number;
  repeatedCognitiveMoveRate: number;
  sourceMemoryDiversity: number;
  crossTopicAssociationRate: number;
  spontaneousMetaLeakageRate: number;
  spontaneousTaskPressureRate: number;
  truncatedThoughtRate: number;
  reviewNeeded: string[];
}

type Random = RandomSource;

function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function topicKey(content: string): string {
  return contentTokens(content).slice(0, 5).sort().join("|");
}

function buildContext(ego: EgoState, now: number): ThoughtGenerationContext {
  return {
    ego,
    recentInteractions: ego.totalInteractions,
    timeSinceLastThought: ego.lastThoughtTime ? now - ego.lastThoughtTime : Infinity,
    timeSinceLastInteraction: ego.lastInteractionTime ? now - ego.lastInteractionTime : Infinity,
    currentHour: new Date(now).getHours(),
    currentMinute: new Date(now).getMinutes(),
    dayOfWeek: new Date(now).getDay(),
    urgentNeeds: Object.entries(ego.needs)
      .filter(([, need]) => need.current < need.ideal * 0.6)
      .map(([key]) => key),
    recentMemories: [...ego.memories].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5),
    activeGoals: ego.goals.filter((goal) => goal.status === "active"),
    contextHints: [],
  };
}

function compactOpportunity(opportunity: DetectedThoughtOpportunity): DetectedThoughtOpportunity {
  return { ...opportunity, actionParams: opportunity.actionParams ? { ...opportunity.actionParams } : undefined };
}

function inferSourceMemories(opportunity: DetectedThoughtOpportunity, ego: EgoState): SoulMemory[] {
  const needle = contentTokens(`${opportunity.triggerDetail} ${opportunity.motivation}`);
  if (needle.length === 0) return [];
  return ego.memories
    .map((memory) => ({ memory, score: jaccard(needle, contentTokens(`${memory.content} ${memory.tags.join(" ")}`)) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ memory }) => memory);
}

function currentThoughtPrompt(opportunity: DetectedThoughtOpportunity, ctx: ThoughtGenerationContext): string {
  const recent = ctx.recentMemories.map((memory) => `- ${memory.content.slice(0, 160)}`).join("\n") || "- none";
  return `Generate one private thought for an AI companion from the selected opportunity.

Opportunity: ${opportunity.triggerDetail}
Motivation: ${opportunity.motivation}
Recent memory snapshot:
${recent}

Write 1-2 specific sentences. Preserve the intent of the opportunity. Do not explain your answer.`;
}

async function generateCurrent(
  ctx: ThoughtGenerationContext,
  recentTypes: string[],
  recentContents: string[],
  llmGenerator?: LLMThoughtGenerator,
): Promise<{ opportunities: DetectedThoughtOpportunity[]; selected: DetectedThoughtOpportunity | null; thought: Thought | null }> {
  const opportunities = detectThoughtOpportunities(ctx);
  const nonRepeating = opportunities.filter((opportunity) =>
    isExecutionFocusedOpportunity(opportunity) || !recentTypes.includes(opportunity.type),
  );
  let selected = nonRepeating[0] ?? opportunities[0] ?? null;
  if (!selected) return { opportunities, selected: null, thought: null };

  const build = async (opportunity: DetectedThoughtOpportunity): Promise<Thought> => {
    const thought = buildThoughtFromOpportunity(opportunity, ctx.ego);
    if (llmGenerator && opportunity.priority > 30 && !isExecutionFocusedOpportunity(opportunity)) {
      const generated = (await llmGenerator(currentThoughtPrompt(opportunity, ctx)))
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .trim();
      if (generated) thought.content = generated.slice(0, 500);
    }
    return thought;
  };

  let thought = await build(selected);
  const repeatsRecentTopic = (content: string) => recentContents.some((recent) =>
    jaccard(contentTokens(recent), contentTokens(content)) >= 0.55,
  );
  if (!isExecutionFocusedOpportunity(selected) && repeatsRecentTopic(thought.content)) {
    const retry = nonRepeating.find((opportunity) => opportunity.type !== selected?.type);
    if (retry) {
      selected = retry;
      thought = await build(retry);
      if (!isExecutionFocusedOpportunity(retry) && repeatsRecentTopic(thought.content)) {
        return { opportunities, selected, thought: null };
      }
    } else {
      return { opportunities, selected, thought: null };
    }
  }
  return { opportunities, selected, thought };
}

async function generateSpontaneous(
  ctx: ThoughtGenerationContext,
  random: Random,
  llmGenerator: LLMThoughtGenerator,
  usageCounts?: Map<string, number>,
): Promise<{ selected: DetectedThoughtOpportunity; thought: Thought; memories: SoulMemory[] }> {
  const memories = selectRemoteMemoryPair(ctx.ego.memories, random, Date.now(), usageCounts);
  if (memories.length < 2) {
    throw new Error("Spontaneous path needs at least two usable memories in the snapshot");
  }
  const content = parseSpontaneousResponse(
    await llmGenerator(buildSpontaneousPrompt(memories, ctx.ego, random)),
  ).content;
  if (!content) throw new Error("Spontaneous path returned empty content");
  for (const memory of memories) {
    usageCounts?.set(memory.id, (usageCounts.get(memory.id) ?? 0) + 1);
  }
  const selected: DetectedThoughtOpportunity = {
    type: "reflect-on-memory",
    trigger: "memory",
    triggerDetail: `Remote memory collision: ${memories.map((memory) => memory.id).join(", ")}`,
    priority: 10,
    source: "memory-recall",
    relatedNeeds: [],
    motivation: "Observe what arises without requiring immediate utility",
    suggestedAction: "none",
  };
  const thought = buildThoughtFromOpportunity(selected, ctx.ego);
  thought.content = content;
  thought.actionType = "none";
  thought.actionParams = undefined;
  return { selected, thought, memories };
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function ageBucket(ageDays: number): string {
  if (ageDays < 1) return "<1d";
  if (ageDays < 7) return "1-7d";
  if (ageDays < 30) return "7-30d";
  if (ageDays < 90) return "30-90d";
  return ">=90d";
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function entropyDiversity(distribution: Record<string, number>): number {
  const counts = Object.values(distribution);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (counts.length <= 1 || total === 0) return 0;
  const entropy = counts.reduce((sum, count) => {
    const probability = count / total;
    return sum - probability * Math.log(probability);
  }, 0);
  return Number((entropy / Math.log(counts.length)).toFixed(4));
}

export function calculateThoughtLabMetrics(records: ThoughtLabRecord[]): ThoughtLabMetrics {
  const distributions = {
    path: {} as Record<string, number>,
    opportunitySource: {} as Record<string, number>,
    selectedOpportunitySource: {} as Record<string, number>,
    thoughtType: {} as Record<string, number>,
    actionType: {} as Record<string, number>,
    cognitiveMove: {} as Record<string, number>,
    qualityFlag: {} as Record<string, number>,
    sourceMemoryAge: {} as Record<string, number>,
  };
  const generated = records.filter((record) => record.thought);
  const sourceIds = new Set<string>();
  let sourceCount = 0;
  let sameTopic = 0;
  let repeatedMove = 0;
  let crossTopicAssociations = 0;
  let associationRecords = 0;
  let pairDistanceTotal = 0;
  let pairCount = 0;

  records.forEach((record) => {
    increment(distributions.path, record.path);
    if (record.opportunities.length > 0) {
      for (const opportunity of record.opportunities) increment(distributions.opportunitySource, opportunity.source);
    } else if (record.selectedOpportunity) {
      increment(distributions.opportunitySource, record.selectedOpportunity.source);
    } else {
      increment(distributions.opportunitySource, "none");
    }
    increment(distributions.selectedOpportunitySource, record.selectedOpportunity?.source ?? "none");
    increment(distributions.thoughtType, record.thoughtType ?? "none");
    increment(distributions.actionType, record.actionType ?? "none");
    if (record.thought) {
      increment(distributions.cognitiveMove, record.cognitiveMove);
      const qualityFlags = classifyThoughtQualityFlags(record.thought.content);
      for (const flag of qualityFlags) increment(distributions.qualityFlag, flag);
      for (const memory of record.sourceMemories) {
        sourceIds.add(memory.id);
        sourceCount += 1;
        increment(distributions.sourceMemoryAge, ageBucket(memory.ageDays));
      }
      if (record.sourceMemories.length >= 2) {
        associationRecords += 1;
        const leftClusters = record.sourceMemories[0].topicClusters
          ?? memoryTopicClusters(record.sourceMemories[0]);
        const rightClusters = record.sourceMemories[1].topicClusters
          ?? memoryTopicClusters(record.sourceMemories[1]);
        if (leftClusters.length > 0 && rightClusters.length > 0 && jaccard(leftClusters, rightClusters) === 0) {
          crossTopicAssociations += 1;
        }
      }
    }
  });

  generated.forEach((record, index) => {
    const previous = generated[index - 1];
    if (!previous?.thought || !record.thought) return;
    if (jaccard(contentTokens(previous.thought.content), contentTokens(record.thought.content)) >= 0.55) sameTopic += 1;
    if (previous.cognitiveMove === record.cognitiveMove) repeatedMove += 1;
  });

  const semanticSample = generated.slice(0, 100);
  for (let left = 0; left < semanticSample.length; left += 1) {
    for (let right = left + 1; right < semanticSample.length; right += 1) {
      pairDistanceTotal += 1 - jaccard(
        contentTokens(semanticSample[left].thought?.content ?? ""),
        contentTokens(semanticSample[right].thought?.content ?? ""),
      );
      pairCount += 1;
    }
  }

  const transitions = Math.max(0, generated.length - 1);
  const spontaneous = generated.filter((record) => record.path === "spontaneous");
  return {
    runs: records.length,
    generated: generated.length,
    skipped: records.length - generated.length,
    distributions,
    noOpRate: rate(generated.filter((record) => !record.actionType || record.actionType === "none").length, generated.length),
    sameTopicRepetitionRate: rate(sameTopic, transitions),
    semanticDiversity: pairCount === 0 ? 0 : Number((pairDistanceTotal / pairCount).toFixed(4)),
    cognitiveMoveDiversity: entropyDiversity(distributions.cognitiveMove),
    repeatedCognitiveMoveRate: rate(repeatedMove, transitions),
    sourceMemoryDiversity: rate(sourceIds.size, sourceCount),
    crossTopicAssociationRate: rate(crossTopicAssociations, associationRecords),
    spontaneousMetaLeakageRate: rate(
      spontaneous.filter((record) => classifyThoughtQualityFlags(record.thought?.content ?? "").includes("meta-framing")).length,
      spontaneous.length,
    ),
    spontaneousTaskPressureRate: rate(
      spontaneous.filter((record) => classifyThoughtQualityFlags(record.thought?.content ?? "").includes("task-pressure")).length,
      spontaneous.length,
    ),
    truncatedThoughtRate: rate(
      generated.filter((record) => classifyThoughtQualityFlags(record.thought?.content ?? "").includes("truncated")).length,
      generated.length,
    ),
    reviewNeeded: [
      "useful surprise rate requires blind human review",
      "nonsense rate requires blind human review",
      "cognitiveMove is a heuristic label; validate a sample before treating it as ground truth",
    ],
  };
}

function cloneEgo(ego: EgoState): EgoState {
  return structuredClone(ego);
}

export async function runThoughtLab(options: ThoughtLabOptions = {}): Promise<{
  records: ThoughtLabRecord[];
  metrics: ThoughtLabMetrics;
}> {
  const runs = Math.max(1, Math.floor(options.runs ?? 200));
  const mode = options.mode ?? "baseline";
  const spontaneousRate = mode === "experiment"
    ? Math.max(0, Math.min(1, options.spontaneousRate ?? 0.2))
    : 0;
  if (spontaneousRate > 0 && !options.llmGenerator) {
    throw new Error("Experiment mode requires an LLM (--provider and --model) for the spontaneous path");
  }

  const storePath = resolveEgoStorePath(options.storePath);
  const store = await loadEgoStore(storePath);
  const ego = cloneEgo(store.ego);
  const random = mulberry32(options.seed ?? 20260710);
  const recentTypes: string[] = [];
  const recentTopics: string[] = [];
  const recentContents: string[] = [];
  const recentActions: string[] = [];
  const spontaneousMemoryUse = new Map<string, number>();
  const records: ThoughtLabRecord[] = [];
  const now = Date.now();
  const ctx = buildContext(ego, now);

  for (let index = 0; index < runs; index += 1) {
    const pathChoice: ThoughtLabPath = random() < spontaneousRate ? "spontaneous" : "current";
    const before = {
      thoughtTypes: [...recentTypes],
      topicKeys: [...recentTopics],
      actionTypes: [...recentActions],
    };
    let opportunities: DetectedThoughtOpportunity[] = [];
    let selected: DetectedThoughtOpportunity | null = null;
    let thought: Thought | null = null;
    let sourceMemories: SoulMemory[] = [];
    let skippedReason: string | undefined;

    try {
      if (pathChoice === "spontaneous") {
        const result = await generateSpontaneous(ctx, random, options.llmGenerator!, spontaneousMemoryUse);
        selected = result.selected;
        thought = result.thought;
        sourceMemories = result.memories;
      } else {
        const result = await generateCurrent(ctx, recentTypes, recentContents, options.llmGenerator);
        opportunities = result.opportunities;
        selected = result.selected;
        thought = result.thought;
        sourceMemories = selected ? inferSourceMemories(selected, ego) : [];
        if (!thought) skippedReason = "no opportunities";
      }
    } catch (error) {
      skippedReason = error instanceof Error ? error.message : String(error);
    }

    const key = thought ? topicKey(thought.content) : "";
    const move = thought ? classifyCognitiveMove(thought.content) : "none";
    const qualityFlags = thought ? classifyThoughtQualityFlags(thought.content) : [];
    const action = thought?.actionType ?? null;
    records.push({
      run: index + 1,
      path: pathChoice,
      context: {
        currentHour: ctx.currentHour,
        dayOfWeek: ctx.dayOfWeek,
        urgentNeeds: [...ctx.urgentNeeds],
        activeGoals: ctx.activeGoals.map((goal) => goal.title),
        recentMemoryIds: ctx.recentMemories.map((memory) => memory.id),
      },
      opportunities: opportunities.map(compactOpportunity),
      selectedOpportunity: selected ? compactOpportunity(selected) : null,
      thought: thought ? {
        type: thought.type,
        content: thought.content,
        source: thought.source,
        trigger: thought.trigger,
        motivation: thought.motivation,
        actionType: thought.actionType,
      } : null,
      actionType: action,
      sourceMemories: sourceMemories.map((memory) => ({
        id: memory.id,
        ageDays: Number(((now - memory.timestamp) / 86400000).toFixed(2)),
        type: memory.type,
        tags: [...memory.tags],
        topicClusters: memoryTopicClusters(memory),
        content: memory.content.slice(0, 300),
      })),
      sourceMemoryResolution: sourceMemories.length === 0
        ? "none"
        : pathChoice === "spontaneous" ? "explicit" : "lexical-inference",
      thoughtType: thought?.type ?? null,
      cognitiveMove: move,
      qualityFlags,
      topicKey: key,
      recentStateBefore: before,
      ...(skippedReason ? { skippedReason } : {}),
    });

    if (thought) {
      recentTypes.push(thought.type);
      recentTopics.push(key);
      recentContents.push(thought.content);
      recentActions.push(action ?? "none");
      if (recentTypes.length > 3) recentTypes.shift();
      if (recentTopics.length > 10) recentTopics.shift();
      if (recentContents.length > 10) recentContents.shift();
      if (recentActions.length > 10) recentActions.shift();
    }
  }

  return { records, metrics: calculateThoughtLabMetrics(records) };
}

type CliOptions = ThoughtLabOptions & { llmConfig?: SoulLLMConfig; inputPath?: string };

function parseCliArgs(args: string[]): CliOptions {
  const parsed: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key.startsWith("--") || value === undefined) throw new Error(`Expected --key value, got ${key}`);
    index += 1;
    if (key === "--store") parsed.storePath = value;
    else if (key === "--input") parsed.inputPath = value;
    else if (key === "--runs") parsed.runs = Number(value);
    else if (key === "--mode" && (value === "baseline" || value === "experiment")) parsed.mode = value;
    else if (key === "--spontaneous-rate") parsed.spontaneousRate = Number(value);
    else if (key === "--seed") parsed.seed = Number(value);
    else if (key === "--output") parsed.outputPath = value;
    else if (key === "--provider") parsed.llmConfig = { ...parsed.llmConfig, provider: value };
    else if (key === "--model") parsed.llmConfig = { ...parsed.llmConfig, model: value };
    else if (key === "--api-key-env") parsed.llmConfig = { ...parsed.llmConfig, apiKeyEnv: value };
    else if (key === "--base-url") parsed.llmConfig = { ...parsed.llmConfig, baseUrl: value };
    else if (key === "--max-tokens") parsed.llmConfig = { ...parsed.llmConfig, maxTokens: Number(value) };
    else throw new Error(`Unknown or invalid argument: ${key} ${value}`);
  }
  if (parsed.runs !== undefined && (!Number.isFinite(parsed.runs) || parsed.runs < 1)) throw new Error("--runs must be >= 1");
  if (parsed.seed !== undefined && !Number.isFinite(parsed.seed)) throw new Error("--seed must be a number");
  return parsed;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.inputPath) {
    const inputPath = path.resolve(options.inputPath);
    const records = (await fs.promises.readFile(inputPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ThoughtLabRecord);
    const metrics = calculateThoughtLabMetrics(records);
    const summaryPath = inputPath.replace(/\.jsonl$/i, "") + ".summary.json";
    await fs.promises.writeFile(summaryPath, JSON.stringify(metrics, null, 2) + "\n", "utf8");
    process.stdout.write(`${JSON.stringify({ inputPath, summaryPath, metrics }, null, 2)}\n`);
    return;
  }
  if (options.llmConfig?.provider || options.llmConfig?.model) {
    if (!options.llmConfig.provider || !options.llmConfig.model) {
      throw new Error("Both --provider and --model are required when enabling LLM generation");
    }
    options.llmConfig.maxTokens ??= 192;
    options.llmGenerator = await createSoulLLMGenerator(options.llmConfig) ?? undefined;
    if (!options.llmGenerator) throw new Error("Could not create LLM generator; check API key configuration");
  }
  const result = await runThoughtLab(options);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.resolve(options.outputPath ?? `thought-lab-${options.mode ?? "baseline"}-${stamp}.jsonl`);
  const summaryPath = outputPath.replace(/\.jsonl$/i, "") + ".summary.json";
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, result.records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  await fs.promises.writeFile(summaryPath, JSON.stringify(result.metrics, null, 2) + "\n", "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, summaryPath, metrics: result.metrics }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`Thought Laboratory failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
