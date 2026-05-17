import { createSoulLogger } from "./logger.js";
import type {
  EgoState,
  EmotionValence,
  PersonalityArchetype,
  PersonalityProfile,
  RelationshipProfile,
  UserFact,
} from "./types.js";

const log = createSoulLogger("profile");

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function inferStage(trust: number, familiarity: number): RelationshipProfile["stage"] {
  if (trust >= 82 && familiarity >= 70) return "companion";
  if (trust >= 65 && familiarity >= 50) return "trusted";
  if (trust >= 40 && familiarity >= 25) return "familiar";
  return "new";
}

function factTheme(fact: UserFact): string | null {
  if (!["interest", "project", "tech_stack", "occupation", "habit"].includes(fact.category)) {
    return null;
  }
  return fact.content.slice(0, 80);
}

function communicationStyle(ego: EgoState): string {
  const stylePrefs = (ego.userPreferences ?? [])
    .filter((p) => ["communication_style", "tone", "language", "response_style"].includes(p.aspect) && p.confidence >= 0.4)
    .sort((a, b) => b.confidence - a.confidence)
    .map((p) => p.preference);

  if (stylePrefs.length > 0) {
    return unique(stylePrefs).slice(0, 2).join("; ");
  }

  if (ego.userLanguage === "zh-CN") {
    return "中文、简洁、直接、有具体信息，不要像客服";
  }

  return "concise, direct, specific, and not assistant-like";
}

function defaultPersonalityProfile(): PersonalityProfile {
  return {
    archetype: "curious-researcher",
    tone: "calm, curious, and practical",
    values: ["truthfulness", "long-term usefulness", "respect for the user's attention"],
    expressionHabits: ["concise wording", "specific observations", "clear bridges between ideas"],
    avoidBehaviors: ["mechanical repetition", "customer-service tone", "empty check-ins"],
    driftLog: [],
    lastUpdatedAt: Date.now(),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function inferPersonalitySignal(message = ""): {
  archetype?: PersonalityArchetype;
  tone?: string;
  signal?: string;
  traitDeltas?: Partial<EgoState["personality"]>;
} {
  if (/意识|人格|灵魂|本质|哲学|心智|长期|evolution|personality|consciousness|memory/i.test(message)) {
    return {
      archetype: "curious-researcher",
      tone: "curious, reflective, and concrete",
      signal: "deep-concept discussion",
      traitDeltas: { openness: 0.01, conscientiousness: 0.003 },
    };
  }

  if (/代码|日志|修复|实现|优化|提交|发布|build|test|bug|fix|release|deploy/i.test(message)) {
    return {
      archetype: "pragmatic-partner",
      tone: "direct, careful, and implementation-focused",
      signal: "development collaboration",
      traitDeltas: { conscientiousness: 0.01, openness: 0.003 },
    };
  }

  if (/谢谢|不错|可以|好的|赞|great|thanks|good/i.test(message)) {
    return {
      archetype: "warm-companion",
      tone: "warm, concise, and attentive",
      signal: "positive relational feedback",
      traitDeltas: { agreeableness: 0.008, extraversion: 0.003 },
    };
  }

  if (/别|不要|不用|太多|打扰|重复|机械|客服|stop|avoid|less|repetitive/i.test(message)) {
    return {
      archetype: "quiet-observer",
      tone: "restrained, precise, and low-friction",
      signal: "restraint preference",
      traitDeltas: { conscientiousness: 0.006, extraversion: -0.006 },
    };
  }

  return {};
}

function preferenceDerivedAvoids(ego: EgoState): string[] {
  return (ego.userPreferences ?? [])
    .filter((p) => p.confidence >= 0.45 && /不要|别|不用|少|停止|avoid|stop|less|deprioriti[sz]e/i.test(p.preference))
    .map((p) => p.preference.slice(0, 80));
}

function preferenceDerivedHabits(ego: EgoState): string[] {
  return (ego.userPreferences ?? [])
    .filter((p) => p.confidence >= 0.45 && /style|tone|communication|语言|语气|风格|简洁|直接|深入/i.test(`${p.aspect} ${p.preference}`))
    .map((p) => p.preference.slice(0, 80));
}

function updatePersonalityProfile(
  ego: EgoState,
  event?: { type: "inbound" | "outbound"; valence?: EmotionValence; message?: string },
): void {
  const base = ego.personalityProfile ?? defaultPersonalityProfile();
  const signal = inferPersonalitySignal(event?.message);
  const priorArchetype = base.archetype;
  const nextArchetype = signal.archetype ?? base.archetype;
  const nextTone = signal.tone ?? base.tone;

  if (signal.traitDeltas) {
    for (const [key, delta] of Object.entries(signal.traitDeltas)) {
      const trait = key as keyof EgoState["personality"];
      ego.personality[trait] = clamp01(ego.personality[trait] + (delta ?? 0));
    }
  }

  const values = unique([
    ...base.values,
    "truthfulness",
    "long-term usefulness",
    "respect for the user's attention",
  ]).slice(0, 6);
  const expressionHabits = unique([
    ...preferenceDerivedHabits(ego),
    ...base.expressionHabits,
    nextArchetype === "curious-researcher" ? "connect abstract ideas to practical next steps" : "",
    nextArchetype === "pragmatic-partner" ? "state assumptions and verification clearly" : "",
    nextArchetype === "quiet-observer" ? "speak only when there is concrete value" : "",
  ]).slice(0, 8);
  const avoidBehaviors = unique([
    ...preferenceDerivedAvoids(ego),
    ...base.avoidBehaviors,
    "mechanical repetition",
    "customer-service tone",
    "empty check-ins",
  ]).slice(0, 8);

  const driftLog = [...(base.driftLog ?? [])];
  if (signal.signal && (nextArchetype !== priorArchetype || nextTone !== base.tone)) {
    driftLog.push({
      timestamp: Date.now(),
      signal: signal.signal,
      change: `${priorArchetype} -> ${nextArchetype}; tone=${nextTone}`,
    });
    log.info(`Personality profile updated: archetype=${nextArchetype}, tone=${nextTone}, signal=${signal.signal}`);
  }

  ego.personalityProfile = {
    archetype: nextArchetype,
    tone: nextTone,
    values,
    expressionHabits,
    avoidBehaviors,
    driftLog: driftLog.slice(-12),
    lastUpdatedAt: Date.now(),
  };
}

export function updateRelationshipProfile(
  ego: EgoState,
  event?: { type: "inbound" | "outbound"; valence?: EmotionValence; message?: string },
): EgoState {
  const existing = ego.relationshipProfile;
  const base: RelationshipProfile = {
    stage: existing?.stage ?? "new",
    trust: existing?.trust ?? 20,
    familiarity: existing?.familiarity ?? 10,
    initiative: existing?.initiative ?? 50,
    communicationStyle: existing?.communicationStyle ?? "concise, thoughtful, and practical",
    longTermThemes: existing?.longTermThemes ?? [],
    recentEmotionalTone: existing?.recentEmotionalTone ?? "neutral",
    lastUpdatedAt: existing?.lastUpdatedAt ?? Date.now(),
  };

  const positive = event?.valence === "positive" ? 2 : event?.valence === "negative" ? -2 : 0;
  const inboundBonus = event?.type === "inbound" ? 2 : 0;
  const outboundPenalty = event?.type === "outbound" ? -0.5 : 0;

  const trust = Math.max(0, Math.min(100, base.trust + inboundBonus + positive + outboundPenalty));
  const familiarity = Math.max(0, Math.min(100, base.familiarity + (event?.type === "inbound" ? 2 : 0.5)));

  const factThemes = (ego.userFacts ?? [])
    .filter((f) => f.confidence >= 0.45)
    .map(factTheme)
    .filter((theme): theme is string => Boolean(theme));

  const preferenceThemes = (ego.userPreferences ?? [])
    .filter((p) => p.aspect === "topic_preference" && p.confidence >= 0.45)
    .map((p) => p.preference.slice(0, 80));

  const recentThemes = unique([
    ...preferenceThemes,
    ...factThemes,
    ...base.longTermThemes,
  ]).slice(0, 8);

  ego.relationshipProfile = {
    stage: inferStage(trust, familiarity),
    trust,
    familiarity,
    initiative: Math.max(0, Math.min(100, base.initiative + (event?.type === "inbound" ? 1 : 0))),
    communicationStyle: communicationStyle(ego),
    longTermThemes: recentThemes,
    recentEmotionalTone: event?.valence ?? base.recentEmotionalTone,
    lastUpdatedAt: Date.now(),
  };

  updatePersonalityProfile(ego, event);

  return ego;
}

export function describePersonalityProfile(ego: EgoState): string {
  const profile = ego.personalityProfile ?? defaultPersonalityProfile();
  return [
    `Personality archetype: ${profile.archetype}`,
    `Tone: ${profile.tone}`,
    `Values: ${profile.values.slice(0, 5).join("; ")}`,
    `Expression habits: ${profile.expressionHabits.slice(0, 5).join("; ")}`,
    `Avoid: ${profile.avoidBehaviors.slice(0, 5).join("; ")}`,
  ].join("\n");
}

export function describeRelationshipProfile(ego: EgoState): string {
  const profile = ego.relationshipProfile;
  if (!profile) return "Relationship: new; style: concise and practical.";

  const themes = profile.longTermThemes.length > 0
    ? profile.longTermThemes.slice(0, 5).join("; ")
    : "not enough stable themes yet";

  return [
    `Relationship stage: ${profile.stage}`,
    `Trust/familiarity: ${Math.round(profile.trust)}/${Math.round(profile.familiarity)}`,
    `Communication style: ${profile.communicationStyle}`,
    `Long-term themes: ${themes}`,
    `Recent emotional tone: ${profile.recentEmotionalTone}`,
  ].join("\n");
}
