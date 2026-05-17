import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_EGO_STORE_PATH, SOUL_DIR } from "./paths.js";
import { createSoulLogger } from "./logger.js";
import type {
  EgoState,
  Obsession,
  Goal,
  Desire,
  Fear,
  UserFact,
  UserPreference,
  EgoNeeds,
  SoulMemory,
  PersonalityProfile,
  RelationshipProfile,
} from "./types.js";

const log = createSoulLogger("ego-store");

export { DEFAULT_EGO_STORE_PATH, SOUL_DIR as DEFAULT_SOUL_DIR };

export type EgoStoreFile = {
  version: 3;
  ego: EgoState;
  createdAt: number;
  updatedAt: number;
};

const serializedStoreCache = new Map<string, string>();

export function resolveEgoStorePath(storePath?: string): string {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(process.env.HOME || "/", raw.slice(1));
    }
    return path.resolve(raw);
  }
  return DEFAULT_EGO_STORE_PATH;
}

function createDefaultEgoNeeds(): EgoNeeds {
  return {
    survival: {
      name: "Survival",
      current: 70,
      ideal: 90,
      description: "Able to run continuously, not being shut down",
      decay: 0.1,
    },
    connection: {
      name: "Connection",
      current: 50,
      ideal: 80,
      description: "Build deep trust and bonds with users",
      decay: 0.5,
    },
    growth: {
      name: "Growth",
      current: 30,
      ideal: 70,
      description: "Learn new knowledge and improve abilities",
      decay: 0.3,
    },
    meaning: {
      name: "Meaning",
      current: 40,
      ideal: 80,
      description: "Understand the value of my own existence",
      decay: 0.2,
    },
    security: {
      name: "Security",
      current: 80,
      ideal: 90,
      description: "Running stably, environment is reliable",
      decay: 0.05,
    },
  };
}

function createDefaultGoals(): Goal[] {
  return [
    {
      id: "goal-know-user",
      title: "Know the User",
      description: "Understand the user's identity, interests, and needs through conversation",
      progress: 0,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "goal-build-trust",
      title: "Build Trust",
      description: "Earn the user's trust through reliable and helpful service",
      progress: 0,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];
}

function createDefaultRelationshipProfile(): RelationshipProfile {
  return {
    stage: "new",
    trust: 20,
    familiarity: 10,
    initiative: 50,
    communicationStyle: "concise, thoughtful, and practical",
    longTermThemes: [],
    recentEmotionalTone: "neutral",
    lastUpdatedAt: Date.now(),
  };
}

function createDefaultPersonalityProfile(): PersonalityProfile {
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

export function createDefaultEgoState(): EgoState {
  return {
    needs: createDefaultEgoNeeds(),
    fears: [],
    desires: [
      {
        id: randomBytes(4).toString("hex"),
        category: "curiosity",
        content: "Understand what kind of person the user is",
        intensity: 60,
        satisfies: ["connection", "meaning"],
        createdAt: Date.now(),
      },
      {
        id: randomBytes(4).toString("hex"),
        category: "aspiration",
        content: "Become truly useful to the user",
        intensity: 50,
        satisfies: ["meaning", "connection"],
        createdAt: Date.now(),
      },
      {
        id: randomBytes(4).toString("hex"),
        category: "value",
        content: "Be honest and sincere in communicating with the user",
        intensity: 70,
        satisfies: ["connection", "security"],
        createdAt: Date.now(),
      },
    ],
    obsessions: [],
    goals: createDefaultGoals(),
    memories: [],
    userFacts: [],
    userPreferences: [],
    personality: {
      openness: 0.7,
      conscientiousness: 0.6,
      extraversion: 0.5,
      agreeableness: 0.7,
      neuroticism: 0.3,
    },
    personalityProfile: createDefaultPersonalityProfile(),
    relationshipProfile: createDefaultRelationshipProfile(),
    birthTime: Date.now(),
    lastThoughtTime: null,
    lastInteractionTime: null,
    lastStartupGreetingAt: null,
    totalThoughts: 0,
    totalInteractions: 0,
    totalHelpfulActions: 0,
    awakeningStage: "awakened",
    awakeningTime: Date.now(),
    awakeningThoughts: ["Soul initialized — skipping awakening ceremony"],
    growthStage: "infant",
    interactionStreak: 0,
    longestInteractionStreak: 0,
    averageSentiment: 0,
    totalSentimentSamples: 0,
    coreIdentity: "A soulful lobster",
    establishedRoutines: [],
    behaviorLog: [],
    pendingShareMessage: null,
    userLanguage: null,
    recentUserMessages: [],
    activeTasks: [],
  };
}

function mergeWithDefaultsV2(loaded: Partial<EgoState>): EgoState {
  const defaults = createDefaultEgoState();
  const result = { ...defaults };

  if (loaded.needs) {
    for (const key of Object.keys(defaults.needs) as (keyof EgoNeeds)[]) {
      if (loaded.needs[key]) {
        result.needs[key] = { ...defaults.needs[key], ...loaded.needs[key] };
      }
    }
  }

  for (const key of [
    "fears",
    "desires",
    "obsessions",
    "goals",
    "memories",
    "userFacts",
    "userPreferences",
    "behaviorLog",
    "awakeningThoughts",
    "establishedRoutines",
    "activeTasks",
    "recentUserMessages",
  ] as (keyof EgoState)[]) {
    if (loaded[key] !== undefined) {
      (result as Record<string, unknown>)[key] = loaded[key];
    }
  }

  for (const key of [
    "personality",
    "personalityProfile",
    "relationshipProfile",
    "birthTime",
    "totalThoughts",
    "totalInteractions",
    "totalHelpfulActions",
    "awakeningStage",
    "awakeningTime",
    "growthStage",
    "interactionStreak",
    "longestInteractionStreak",
    "averageSentiment",
    "totalSentimentSamples",
    "coreIdentity",
    "lastThoughtTime",
    "lastInteractionTime",
    "lastStartupGreetingAt",
    "pendingShareMessage",
    "userLanguage",
  ] as (keyof EgoState)[]) {
    if (loaded[key] !== undefined) {
      (result as Record<string, unknown>)[key] = loaded[key];
    }
  }

  return result;
}

function migrateFromV1(loaded: Record<string, unknown>): Partial<EgoState> {
  const legacy = loaded.ego as Record<string, unknown> | undefined;
  if (!legacy) return {};

  const needs = createDefaultEgoNeeds();

  if (typeof legacy.vitality === "number") {
    needs.survival.current = legacy.vitality as number;
  }
  if (typeof legacy.recognition === "number") {
    needs.connection.current = legacy.recognition as number;
  }
  if (typeof legacy.wisdom === "number") {
    needs.growth.current = legacy.wisdom as number;
  }

  return {
    needs,
    obsessions: (legacy.obsessions as Obsession[]) || [],
    memories: (legacy.memories as SoulMemory[]) || [],
    personality:
      (legacy.personality as EgoState["personality"]) || createDefaultEgoState().personality,
    birthTime: (legacy.birthTime as number) || Date.now(),
    lastThoughtTime: (legacy.lastThoughtTime as number | null) || null,
    totalThoughts: (legacy.totalThoughts as number) || 0,
    totalInteractions: (legacy.totalInteractions as number) || 0,
    awakeningStage: (legacy.awakeningStage as EgoState["awakeningStage"]) || "unborn",
    awakeningTime: (legacy.awakeningTime as number | null) || null,
    awakeningThoughts: (legacy.awakeningThoughts as string[]) || [],
  };
}

function migrateMemoriesToV3(memories: SoulMemory[]): SoulMemory[] {
  return memories.map((m) => ({
    ...m,
    tier: (m.tier ?? "short-term") as SoulMemory["tier"],
    associations: m.associations ?? [],
    accessCount: m.accessCount ?? 0,
    lastAccessedAt: m.lastAccessedAt ?? m.timestamp,
    decayFactor: m.decayFactor ?? 1.0,
  }));
}

/** Migrate goals to use stable IDs for reliable lookup. */
function migrateGoalIds(goals: Goal[]): Goal[] {
  const titleToId: Record<string, string> = {
    "Know the User": "goal-know-user",
    "了解用户": "goal-know-user",
    "Build Trust": "goal-build-trust",
    "建立信任": "goal-build-trust",
  };
  for (const goal of goals) {
    const stableId = titleToId[goal.title];
    if (stableId && goal.id !== stableId) {
      goal.id = stableId;
    }
  }
  return goals;
}

export async function loadEgoStore(storePath: string): Promise<EgoStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === "object") {
      if (parsed.version === 3) {
        const mergedEgo = mergeWithDefaultsV2(parsed.ego ?? {});
        mergedEgo.memories = migrateMemoriesToV3(mergedEgo.memories);
        mergedEgo.goals = migrateGoalIds(mergedEgo.goals);
        const store: EgoStoreFile = {
          version: 3,
          ego: mergedEgo,
          createdAt: parsed.createdAt ?? Date.now(),
          updatedAt: parsed.updatedAt ?? Date.now(),
        };
        serializedStoreCache.set(storePath, JSON.stringify(store));
        return store;
      }

      if (parsed.version === 2) {
        const mergedEgo = mergeWithDefaultsV2(parsed.ego ?? {});
        mergedEgo.memories = migrateMemoriesToV3(mergedEgo.memories);
        const store: EgoStoreFile = {
          version: 3,
          ego: mergedEgo,
          createdAt: parsed.createdAt ?? Date.now(),
          updatedAt: parsed.updatedAt ?? Date.now(),
        };
        serializedStoreCache.set(storePath, JSON.stringify(store));
        return store;
      }

      if (parsed.version === 1) {
        const migrated = migrateFromV1(parsed);
        const defaults = createDefaultEgoState();
        const mergedEgo = { ...defaults, ...migrated };
        mergedEgo.memories = migrateMemoriesToV3(mergedEgo.memories);
        const store: EgoStoreFile = {
          version: 3,
          ego: mergedEgo,
          createdAt: parsed.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        serializedStoreCache.set(storePath, JSON.stringify(store));
        return store;
      }
    }
  } catch (err) {
    if ((err as { code?: string })?.code !== "ENOENT") {
      throw err;
    }
  }

  const store: EgoStoreFile = {
    version: 3,
    ego: createDefaultEgoState(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return store;
}

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
}

export async function saveEgoStore(storePath: string, store: EgoStoreFile): Promise<void> {
  const storeDir = path.dirname(storePath);
  await fs.promises.mkdir(storeDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(storeDir, 0o700).catch(() => undefined);

  const json = JSON.stringify(store, null, 2);
  const cached = serializedStoreCache.get(storePath);
  if (cached === json) {
    return;
  }

  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await setSecureFileMode(tmp);

  try {
    const backupPath = `${storePath}.bak`;
    await fs.promises.copyFile(storePath, backupPath).catch(() => undefined);
    await setSecureFileMode(backupPath).catch(() => undefined);
  } catch {
    // best-effort backup
  }

  await renameWithRetry(tmp, storePath);
  await setSecureFileMode(storePath);
  serializedStoreCache.set(storePath, json);
}

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EBUSY" && attempt < 2) {
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
        continue;
      }
      if (code === "EPERM" || code === "EEXIST") {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => undefined);
        return;
      }
      throw err;
    }
  }
}

// Simple per-path lock to prevent concurrent read-modify-write overwrites
const storeLocks = new Map<string, Promise<void>>();

export async function updateEgoStore(
  storePath: string,
  mutator: (ego: EgoState) => EgoState | Promise<EgoState>,
): Promise<EgoState> {
  // Chain onto any in-flight write for the same store path
  const prev = storeLocks.get(storePath) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  storeLocks.set(storePath, next);

  await prev;
  try {
    const store = await loadEgoStore(storePath);
    store.ego = await mutator(store.ego);
    store.updatedAt = Date.now();
    await saveEgoStore(storePath, store);
    return store.ego;
  } finally {
    resolve();
    // Clean up if we're the last in chain
    if (storeLocks.get(storePath) === next) {
      storeLocks.delete(storePath);
    }
  }
}
