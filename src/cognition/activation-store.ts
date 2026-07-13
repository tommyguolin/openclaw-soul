import fs from "node:fs";
import path from "node:path";
import type { ActivationStateFile, TraceActivationState } from "./types.js";

const EMPTY_STATE: ActivationStateFile = { version: 1, updatedAt: 0, states: [] };

export function resolveActivationStatePath(egoStorePath: string): string {
  return path.join(path.dirname(path.resolve(egoStorePath)), "activation-state.json");
}

export class ActivationStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async load(now = Date.now()): Promise<ActivationStateFile> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")) as Partial<ActivationStateFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.states)) return { ...EMPTY_STATE };
      const cutoff = now - 7 * 24 * 60 * 60 * 1000;
      const states = parsed.states.filter((state) =>
        state && typeof state.traceId === "string"
        && Number.isFinite(state.activation)
        && Number.isFinite(state.fatigue)
        && !((state.activation < 0.01 && state.fatigue < 0.01) && state.lastUpdatedAt < cutoff));
      return { version: 1, updatedAt: Number(parsed.updatedAt) || 0, states };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE };
      const corrupt = `${this.filePath}.corrupt-${now}`;
      await fs.promises.rename(this.filePath, corrupt).catch(() => undefined);
      return { ...EMPTY_STATE };
    }
  }

  save(states: Iterable<TraceActivationState>, now = Date.now()): Promise<void> {
    const snapshot: ActivationStateFile = {
      version: 1,
      updatedAt: now,
      states: [...states].filter((state) => state.activation >= 0.01 || state.fatigue >= 0.01),
    };
    this.writeChain = this.writeChain.then(async () => {
      const directory = path.dirname(this.filePath);
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await fs.promises.rename(temp, this.filePath);
      await fs.promises.chmod(this.filePath, 0o600).catch(() => undefined);
    });
    return this.writeChain;
  }
}
