import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_KNOWLEDGE_STORE_PATH, resolveDefaultKnowledgeStorePath } from "./paths.js";
import { createSoulLogger } from "./logger.js";
import type { KnowledgeItem, KnowledgeStore } from "./types.js";

const log = createSoulLogger("knowledge");

export { DEFAULT_KNOWLEDGE_STORE_PATH };

const MAX_KNOWLEDGE_ITEMS = 200;
const DEDUP_OVERLAP_THRESHOLD = 0.7;

const serializedCache = new Map<string, string>();

export function resolveKnowledgeStorePath(p?: string): string {
  if (p?.trim()) {
    const raw = p.trim();
    if (raw.startsWith("~")) {
      return path.resolve(process.env.HOME || "/", raw.slice(1));
    }
    return path.resolve(raw);
  }
  return resolveDefaultKnowledgeStorePath();
}

function createEmptyStore(): KnowledgeStore {
  return { version: 1, items: [], updatedAt: Date.now() };
}

function toBigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const bigrams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    bigrams.add(normalized.slice(i, i + 2));
  }
  return bigrams;
}

function bigramOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const g of a) {
    if (b.has(g)) overlap++;
  }
  return overlap / Math.max(a.size, b.size);
}

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
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

export async function loadKnowledgeStore(storePath?: string): Promise<KnowledgeStore> {
  const resolved = resolveKnowledgeStorePath(storePath);
  try {
    const raw = await fs.promises.readFile(resolved, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      return { ...createEmptyStore(), ...parsed };
    }
  } catch (err) {
    if ((err as { code?: string })?.code !== "ENOENT") {
      throw err;
    }
  }
  return createEmptyStore();
}

export async function saveKnowledgeStore(
  storePath: string,
  store: KnowledgeStore,
): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700).catch(() => undefined);

  const json = JSON.stringify(store, null, 2);
  const cached = serializedCache.get(storePath);
  if (cached === json) return;

  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await setSecureFileMode(tmp);

  const backupPath = `${storePath}.bak`;
  await fs.promises.copyFile(storePath, backupPath).catch(() => undefined);
  await setSecureFileMode(backupPath).catch(() => undefined);

  await renameWithRetry(tmp, storePath);
  await setSecureFileMode(storePath);
  serializedCache.set(storePath, json);
}

export async function updateKnowledgeStore(
  storePath: string | undefined,
  mutator: (store: KnowledgeStore) => KnowledgeStore | Promise<KnowledgeStore>,
): Promise<KnowledgeStore> {
  const resolved = resolveKnowledgeStorePath(storePath);
  const store = await loadKnowledgeStore(resolved);
  const updated = await mutator(store);
  updated.updatedAt = Date.now();
  await saveKnowledgeStore(resolved, updated);
  return updated;
}

function isDuplicate(items: KnowledgeItem[], newItem: { topic: string; content: string }): boolean {
  const newBigrams = toBigrams(`${newItem.topic} ${newItem.content}`);
  for (const item of items) {
    const existingBigrams = toBigrams(`${item.topic} ${item.content}`);
    if (bigramOverlap(newBigrams, existingBigrams) >= DEDUP_OVERLAP_THRESHOLD) {
      return true;
    }
  }
  return false;
}

export async function addKnowledgeItem(
  storePath: string | undefined,
  item: Omit<KnowledgeItem, "id" | "learnedAt" | "accessCount">,
): Promise<KnowledgeItem | null> {
  const newItem: KnowledgeItem = {
    ...item,
    id: randomBytes(8).toString("hex"),
    learnedAt: Date.now(),
    accessCount: 0,
  };

  const updated = await updateKnowledgeStore(storePath, (store) => {
    if (isDuplicate(store.items, newItem)) {
      return store;
    }

    store.items.push(newItem);

    if (store.items.length > MAX_KNOWLEDGE_ITEMS) {
      store.items.sort((a, b) => {
        const scoreA =
          a.accessCount * 0.3 +
          (1 - (Date.now() - a.learnedAt) / (30 * 24 * 60 * 60 * 1000)) * 0.7;
        const scoreB =
          b.accessCount * 0.3 +
          (1 - (Date.now() - b.learnedAt) / (30 * 24 * 60 * 60 * 1000)) * 0.7;
        return scoreA - scoreB;
      });
      store.items = store.items.slice(store.items.length - MAX_KNOWLEDGE_ITEMS);
    }

    return store;
  });

  return updated.items.find((i) => i.id === newItem.id) ?? null;
}

export function searchKnowledge(
  query: string,
  items: KnowledgeItem[],
  limit = 5,
): (KnowledgeItem & { score: number })[] {
  if (items.length === 0 || !query) return [];

  const queryBigrams = toBigrams(query);
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);

  const scored = items.map((item) => {
    const contentBigrams = toBigrams(item.content);
    const contentScore = bigramOverlap(queryBigrams, contentBigrams);

    const tagScore =
      item.tags.length > 0
        ? queryTerms.reduce(
            (acc, term) =>
              acc + (item.tags.some((t) => t.toLowerCase().includes(term)) ? 1 : 0),
            0,
          ) / Math.max(queryTerms.length, 1)
        : 0;

    const topicBigrams = toBigrams(item.topic);
    const topicScore = bigramOverlap(queryBigrams, topicBigrams);

    const ageDays = (Date.now() - item.learnedAt) / (24 * 60 * 60 * 1000);
    const recencyBoost = Math.max(0, 1 - ageDays / 30) * 0.1;

    const score = contentScore * 0.4 + tagScore * 0.3 + topicScore * 0.2 + recencyBoost;
    return { ...item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).filter((s) => s.score > 0.1);
}
