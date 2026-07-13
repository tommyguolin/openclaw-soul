import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExpressionProposal, ExpressionStoreFile, WithheldReason } from "./types.js";

export function resolveExpressionStorePath(egoStorePath: string): string {
  return path.join(path.dirname(path.resolve(egoStorePath)), "expression-proposals.json");
}

export class ExpressionStore {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string) {}

  async load(): Promise<ExpressionStoreFile> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")) as Partial<ExpressionStoreFile>;
      if (parsed.version === 1 && Array.isArray(parsed.proposals)) {
        return { version: 1, updatedAt: Number(parsed.updatedAt) || Date.now(), proposals: parsed.proposals };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { version: 1, updatedAt: Date.now(), proposals: [] };
  }

  async propose(input: Pick<ExpressionProposal, "sourceType" | "sourceId" | "content" | "reason">): Promise<ExpressionProposal> {
    const file = await this.load();
    const existing = file.proposals.find((item) => item.sourceType === input.sourceType
      && item.sourceId === input.sourceId && item.status === "pending");
    if (existing) return existing;
    const proposal: ExpressionProposal = {
      ...input, id: randomBytes(8).toString("hex"), status: "pending", createdAt: Date.now(),
    };
    file.proposals.push(proposal);
    file.proposals = file.proposals.sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
    file.updatedAt = Date.now();
    await this.save(file);
    return proposal;
  }

  async resolve(id: string, sent: boolean, withheldReason?: WithheldReason): Promise<ExpressionProposal | undefined> {
    const file = await this.load();
    const proposal = file.proposals.find((item) => item.id === id);
    if (!proposal) return undefined;
    proposal.status = sent ? "sent" : "withheld";
    proposal.evaluatedAt = Date.now();
    if (!sent && withheldReason) proposal.withheldReason = withheldReason;
    file.updatedAt = proposal.evaluatedAt;
    await this.save(file);
    return proposal;
  }

  private save(file: ExpressionStoreFile): Promise<void> {
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
