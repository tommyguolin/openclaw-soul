import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkHandoff, WorkHandoffStoreFile } from "./types.js";

export function resolveWorkHandoffStorePath(egoStorePath: string): string {
  return path.join(path.dirname(path.resolve(egoStorePath)), "work-handoffs.json");
}

export class WorkHandoffStore {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string) {}

  async load(): Promise<WorkHandoffStoreFile> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")) as Partial<WorkHandoffStoreFile>;
      if (parsed.version === 1 && Array.isArray(parsed.handoffs)) {
        return { version: 1, updatedAt: Number(parsed.updatedAt) || Date.now(), handoffs: parsed.handoffs };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { version: 1, updatedAt: Date.now(), handoffs: [] };
  }

  async upsert(input: Omit<WorkHandoff, "id" | "createdAt" | "updatedAt">): Promise<WorkHandoff> {
    const file = await this.load();
    const now = Date.now();
    const existing = file.handoffs.find((handoff) =>
      handoff.intentionId === input.intentionId
      && handoff.targetProjectRoot.toLowerCase() === input.targetProjectRoot.toLowerCase());
    const append = (previous: string[], next: string[], limit: number): string[] =>
      [...new Set([...previous, ...next])].slice(-limit);
    const handoff: WorkHandoff = existing ?? {
      ...input,
      id: randomBytes(8).toString("hex"),
      createdAt: now,
      updatedAt: now,
    };
    if (existing) {
      existing.objective = input.objective;
      existing.sessionKey = input.sessionKey ?? existing.sessionKey;
      if (input.phase !== "investigating") existing.phase = input.phase;
      existing.acceptanceCriteria = append(existing.acceptanceCriteria, input.acceptanceCriteria, 10);
      existing.observedFiles = append(existing.observedFiles, input.observedFiles, 50);
      existing.modifiedFiles = append(existing.modifiedFiles, input.modifiedFiles, 50);
      existing.verificationCommands = append(existing.verificationCommands, input.verificationCommands, 20);
      existing.failedTools = append(existing.failedTools, input.failedTools, 20);
      existing.updatedAt = now;
    } else {
      file.handoffs.push(handoff);
    }
    file.handoffs = file.handoffs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
    file.updatedAt = now;
    await this.save(file);
    return handoff;
  }

  async latestForIntention(intentionId: string): Promise<WorkHandoff | undefined> {
    const file = await this.load();
    return file.handoffs
      .filter((handoff) => handoff.intentionId === intentionId && isUsableWorkHandoff(handoff))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  async updateForIntention(
    intentionId: string,
    mutate: (handoff: WorkHandoff) => void,
  ): Promise<WorkHandoff | undefined> {
    const file = await this.load();
    const handoff = file.handoffs
      .filter((item) => item.intentionId === intentionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!handoff) return undefined;
    mutate(handoff);
    handoff.updatedAt = Date.now();
    file.updatedAt = handoff.updatedAt;
    await this.save(file);
    return handoff;
  }

  private save(file: WorkHandoffStoreFile): Promise<void> {
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

export function isUsableWorkHandoff(handoff: WorkHandoff): boolean {
  try {
    return fs.statSync(handoff.targetProjectRoot).isDirectory();
  } catch {
    return false;
  }
}
