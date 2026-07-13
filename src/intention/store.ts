import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Intention, IntentionStoreFile } from "./types.js";

export function resolveIntentionStorePath(egoStorePath: string): string {
  return path.join(path.dirname(path.resolve(egoStorePath)), "intentions.json");
}

export class IntentionStore {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string) {}

  async load(): Promise<IntentionStoreFile> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")) as Partial<IntentionStoreFile>;
      if (parsed.version === 1 && Array.isArray(parsed.intentions)) {
        return { version: 1, updatedAt: Number(parsed.updatedAt) || Date.now(), intentions: parsed.intentions };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { version: 1, updatedAt: Date.now(), intentions: [] };
  }

  async add(input: Omit<Intention, "id" | "createdAt" | "updatedAt">): Promise<{ intention: Intention; created: boolean }> {
    const file = await this.load();
    const existing = input.originId ? file.intentions.find((item) =>
      item.origin === input.origin && item.originId === input.originId && item.status !== "abandoned") : undefined;
    if (existing) return { intention: existing, created: false };
    const now = Date.now();
    const intention: Intention = { ...input, id: randomBytes(8).toString("hex"), createdAt: now, updatedAt: now };
    file.intentions.push(intention);
    file.intentions = file.intentions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500);
    file.updatedAt = now;
    await this.save(file);
    return { intention, created: true };
  }

  async update(id: string, mutate: (intention: Intention) => void): Promise<Intention | undefined> {
    const file = await this.load();
    const intention = file.intentions.find((item) => item.id === id);
    if (!intention) return undefined;
    mutate(intention);
    intention.updatedAt = Date.now();
    file.updatedAt = intention.updatedAt;
    await this.save(file);
    return intention;
  }

  private save(file: IntentionStoreFile): Promise<void> {
    const pending = this.writeChain.then(async () => {
      const directory = path.dirname(this.filePath);
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.promises.writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await fs.promises.rename(temp, this.filePath);
      await fs.promises.chmod(this.filePath, 0o600).catch(() => undefined);
    });
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
}
