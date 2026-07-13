import fs from "node:fs";
import path from "node:path";
import type { CognitionCycleRecord } from "./types.js";

const MAX_BYTES = 10 * 1024 * 1024;

export function resolveCognitiveJournalPath(egoStorePath: string): string {
  return path.join(path.dirname(path.resolve(egoStorePath)), "cognitive-cycles.jsonl");
}

export class CognitiveJournal {
  private appendChain: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  append(record: CognitionCycleRecord): Promise<void> {
    this.appendChain = this.appendChain.then(async () => {
      const directory = path.dirname(this.filePath);
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify(record)}\n`;
      const stat = await fs.promises.stat(this.filePath).catch(() => null);
      if (stat && stat.size + Buffer.byteLength(line) > MAX_BYTES) {
        const archive = `${this.filePath}.${new Date(record.timestamp).toISOString().replace(/[:.]/g, "-")}`;
        await fs.promises.rename(this.filePath, archive);
        await fs.promises.chmod(archive, 0o600).catch(() => undefined);
      }
      await fs.promises.appendFile(this.filePath, line, { mode: 0o600 });
      await fs.promises.chmod(this.filePath, 0o600).catch(() => undefined);
    });
    return this.appendChain;
  }
}
