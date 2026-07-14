import { contentTokens, jaccard } from "../thought-emergence.js";
import type {
  ActivationConfig,
  ActivationResult,
  AssociativeExpansionSummary,
  CognitiveTrace,
  CognitiveWorkspace,
  WorkspaceItem,
  CognitiveTemperament,
} from "./types.js";
import { DEFAULT_ACTIVATION_CONFIG } from "./types.js";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function temperamentActivationConfig(temperament: CognitiveTemperament): Partial<ActivationConfig> {
  if (temperament === "focused") return { associativeBreadth: 0.25, noveltySeeking: 0.35, inhibition: 0.75,
    persistence: 0.45, incubationDepth: 0.3, convergencePressure: 0.85, maxAssociativeItems: 1 };
  if (temperament === "expansive") return { associativeBreadth: 0.78, noveltySeeking: 0.8, inhibition: 0.4,
    persistence: 0.7, incubationDepth: 0.7, convergencePressure: 0.55, maxAssociativeItems: 3 };
  return { associativeBreadth: 0.5, noveltySeeking: 0.55, inhibition: 0.6,
    persistence: 0.5, incubationDepth: 0.45, convergencePressure: 0.65, maxAssociativeItems: 3 };
}

const TASK_PRESSURE = /\b(?:bug|error|fail(?:ed|ure|ing)?|timeout|exception|debug|fix|incident|broken|stack trace|log)\b|错误|失败|超时|异常|修复|排查|日志|故障/i;

const STRUCTURAL_PATTERNS: Array<[string, RegExp]> = [
  ["hidden-state", /\b(?:hidden|stale|cached|invisible|implicit|state)\b|隐藏|陈旧|缓存|不可见|状态/i],
  ["boundary-limit", /\b(?:boundary|limit|quota|threshold|capacity|overflow|too (?:long|large|many))\b|边界|限制|配额|阈值|容量|过长|过大/i],
  ["repetition", /\b(?:repeat|again|recurr|loop|retry|periodic|stuck)\b|重复|再次|反复|循环|重试|周期|卡住/i],
  ["identity-routing", /\b(?:identity|session|route|channel|account|scope|context)\b|身份|会话|路由|渠道|账号|作用域|上下文/i],
  ["lifecycle-order", /\b(?:lifecycle|reload|restart|startup|shutdown|before|after|order|race)\b|生命周期|热加载|重启|启动|关闭|先后|顺序|竞态/i],
  ["feedback-observation", /\b(?:feedback|observe|metric|signal|evidence|measurement)\b|反馈|观察|指标|信号|证据|测量/i],
];

function patterns(trace: CognitiveTrace): string[] {
  const lexical = STRUCTURAL_PATTERNS.filter(([, pattern]) => pattern.test(trace.content)).map(([name]) => name);
  // topic:* clusters are stable concepts supplied by the multilingual LLM
  // classifier. They provide the normal cross-language association path;
  // lexical patterns remain an offline fallback for old memories.
  const semantic = trace.topicClusters.filter((cluster) => cluster.startsWith("topic:"));
  return [...new Set([...semantic, ...lexical])];
}

function hasTaskPressure(trace: CognitiveTrace): boolean {
  const signals = trace.memory?.semanticSignals;
  if (signals && signals.length > 0) {
    return signals.includes("problem") || signals.includes("execution-directive");
  }
  return TASK_PRESSURE.test(trace.content);
}

function explicitStrength(core: CognitiveTrace, candidate: CognitiveTrace): number {
  const direct = core.memory?.associations?.find((item) => item.targetId === candidate.sourceId)?.strength ?? 0;
  const reverse = candidate.memory?.associations?.find((item) => item.targetId === core.sourceId)?.strength ?? 0;
  return Math.max(direct, reverse);
}

interface RankedAssociation {
  result: ActivationResult;
  source: WorkspaceItem;
  mechanism: "explicit-association" | "shared-pattern" | "semantic-bridge";
  bridgeLabels: string[];
  semanticDistance: number;
  relevance: number;
  confidence: number;
  score: number;
}

/**
 * Adds a small number of traceable, hypothesis-only associations to an already
 * formed workspace. It can enrich attention, but can never create attention or
 * an action by itself.
 */
export function expandCognitiveWorkspace(
  workspace: CognitiveWorkspace,
  results: ActivationResult[],
  partialConfig: Partial<ActivationConfig> = {},
): CognitiveWorkspace {
  const config = { ...DEFAULT_ACTIVATION_CONFIG, ...partialConfig };
  const coreItems = workspace.items.map((item) => ({ ...item, role: "core" as const }));
  if (!workspace.allowEmergence || coreItems.length === 0 || config.maxAssociativeItems <= 0) {
    return { ...workspace, items: coreItems };
  }

  const taskPressure = coreItems.some((item) => hasTaskPressure(item.trace));
  const stagnation = clamp01(coreItems.reduce((sum, item) => {
    const result = results.find((entry) => entry.trace.id === item.trace.id);
    return sum + Math.max(item.fatigue, Math.min(1, (result?.state.consumedCount ?? 0) / 4));
  }, 0) / coreItems.length);
  const contextualBreadth = clamp01(
    config.associativeBreadth
    + stagnation * (0.25 + config.persistence * 0.2)
    - (taskPressure ? 0.3 + config.convergencePressure * 0.2 : 0)
    - config.inhibition * 0.08,
  );
  // Active troubleshooting is a convergence context even when the same fault
  // has repeated; one strong analogy can help, a brainstorm fan-out usually cannot.
  const effectiveBreadth = taskPressure ? Math.min(0.29, contextualBreadth) : contextualBreadth;
  const mode: AssociativeExpansionSummary["mode"] = effectiveBreadth < 0.3
    ? "narrow" : effectiveBreadth >= 0.68 ? "broad" : "balanced";
  const limit = Math.min(config.maxAssociativeItems, mode === "narrow" ? 1 : mode === "balanced" ? 2 : 3);
  const selectedIds = new Set(coreItems.map((item) => item.trace.id));
  const ranked: RankedAssociation[] = [];

  for (const result of results) {
    if (selectedIds.has(result.trace.id) || result.resolvedSuppressed) continue;
    // Replaying Soul's own previous reply looks like "more material" but is
    // usually self-echo, not a new association. Non-interaction insights remain eligible.
    if (result.trace.sourceType === "interaction" && result.trace.provenance === "system") continue;
    let best: RankedAssociation | undefined;
    for (const source of coreItems) {
      const similarity = jaccard(contentTokens(source.trace.content), contentTokens(result.trace.content));
      const sharedPatterns = patterns(source.trace).filter((label) => patterns(result.trace).includes(label));
      const explicit = explicitStrength(source.trace, result.trace);
      let mechanism: RankedAssociation["mechanism"] | undefined;
      let relevance = 0;
      let confidence = 0;
      let bridgeLabels: string[] = [];
      if (explicit > 0) {
        mechanism = "explicit-association";
        relevance = Math.max(similarity, explicit);
        confidence = 0.55 + explicit * 0.4;
        bridgeLabels = ["stored-association"];
      } else if (sharedPatterns.length > 0) {
        // Structural analogy should be remote enough to add a new route. Near
        // paraphrases belong to core semantic activation, not expansion.
        if (similarity > 0.12) continue;
        mechanism = "shared-pattern";
        relevance = Math.min(1, 0.45 + sharedPatterns.length * 0.15 + similarity * 0.3);
        confidence = Math.min(0.85, 0.5 + sharedPatterns.length * 0.12);
        bridgeLabels = sharedPatterns;
      } else if (similarity >= 0.06 && similarity <= 0.12) {
        mechanism = "semantic-bridge";
        relevance = Math.min(1, 0.3 + similarity * 1.4);
        confidence = Math.min(0.75, 0.35 + similarity);
        bridgeLabels = ["shared-language"];
      }
      if (!mechanism) continue;
      if (taskPressure && mechanism === "semantic-bridge" && similarity < 0.12) continue;
      const distance = clamp01(1 - similarity);
      const novelty = distance * config.noveltySeeking;
      const ageDays = Math.max(0, (workspace.createdAt - result.trace.timestamp) / 86_400_000);
      const incubation = Math.min(0.12, Math.log1p(ageDays) / 40 * config.incubationDepth);
      const score = relevance * 0.48 + confidence * 0.22 + novelty * 0.2
        + result.trace.importance * 0.1 + incubation - config.inhibition * 0.12;
      const candidate = { result, source, mechanism, bridgeLabels, semanticDistance: distance,
        relevance, confidence, score };
      if (!best || candidate.score > best.score) best = candidate;
    }
    const minimum = taskPressure ? 0.48 : 0.36 + config.inhibition * 0.08 - effectiveBreadth * 0.1;
    if (best && best.score >= minimum) ranked.push(best);
  }

  ranked.sort((a, b) => b.score - a.score || b.result.trace.timestamp - a.result.trace.timestamp);
  const additions: WorkspaceItem[] = ranked.slice(0, limit).map((entry) => ({
    trace: entry.result.trace,
    activation: Math.min(0.55, 0.25 + entry.score * 0.35),
    fatigue: entry.result.state.fatigue,
    contributions: entry.result.contributions,
    selectionReason: `exploratory ${entry.mechanism} from ${entry.source.trace.id}`,
    role: "associative",
    association: {
      sourceTraceId: entry.source.trace.id,
      mechanism: entry.mechanism,
      bridgeLabels: entry.bridgeLabels,
      semanticDistance: entry.semanticDistance,
      relevance: entry.relevance,
      confidence: entry.confidence,
      exploratory: true,
    },
  }));
  const expansion: AssociativeExpansionSummary = {
    mode,
    attempted: ranked.length,
    added: additions.length,
    effectiveBreadth,
    stagnation,
    taskPressure,
    reason: taskPressure ? "task-pressure-convergence" : stagnation >= 0.5 ? "stagnation-broadening" : "temperament-baseline",
    mechanisms: additions.reduce<Record<string, number>>((counts, item) => {
      const mechanism = item.association?.mechanism ?? "unknown";
      counts[mechanism] = (counts[mechanism] ?? 0) + 1;
      return counts;
    }, {}),
  };
  return {
    ...workspace,
    items: [...coreItems, ...additions],
    relations: additions.length > 0 ? [...new Set([...workspace.relations, "association" as const])] : workspace.relations,
    expansion,
  };
}
