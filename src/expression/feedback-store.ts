import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExpressionProposal } from "./types.js";
import type { InteractionSemanticSignal } from "../types.js";
import {
  inferExpressionFeedback, inferNoReplyFeedback,
  type AdaptiveExpressionPolicyState, type ExpressionFeedbackEvent,
} from "./feedback.js";

export type ExpressionPolicyMode = "legacy" | "observe" | "adaptive";

export interface ExpressionFeedbackStoreFile {
  version: 1;
  updatedAt: number;
  events: ExpressionFeedbackEvent[];
  policy: AdaptiveExpressionPolicyState;
}

const DEFAULT_POLICY: AdaptiveExpressionPolicyState = {
  minimumAgeMultiplier: 1, valueThresholdDelta: 0, interruptionCost: 0.5, samples: 0,
};

export function resolveExpressionFeedbackPath(egoStorePath: string): string {
  return path.join(path.dirname(path.resolve(egoStorePath)), "expression-feedback.json");
}

export class ExpressionFeedbackStore {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string, readonly mode: Exclude<ExpressionPolicyMode, "legacy">) {}

  async load(): Promise<ExpressionFeedbackStoreFile> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")) as Partial<ExpressionFeedbackStoreFile>;
      if (parsed.version === 1 && Array.isArray(parsed.events)) {
        return { version: 1, updatedAt: Number(parsed.updatedAt) || Date.now(), events: parsed.events,
          policy: { ...DEFAULT_POLICY, ...parsed.policy } };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { version: 1, updatedAt: Date.now(), events: [], policy: { ...DEFAULT_POLICY } };
  }

  async observeReply(proposal: ExpressionProposal, replyText: string, replySourceId?: string,
    semanticSignals: InteractionSemanticSignal[] = []): Promise<ExpressionFeedbackEvent> {
    return this.append(proposal.id, inferExpressionFeedback(replyText, proposal.content, semanticSignals), replySourceId, replyText);
  }

  async observeNoReply(proposal: ExpressionProposal): Promise<ExpressionFeedbackEvent> {
    return this.append(proposal.id, inferNoReplyFeedback());
  }

  private async append(proposalId: string, inference: ExpressionFeedbackEvent["inference"], replySourceId?: string,
    replyText?: string): Promise<ExpressionFeedbackEvent> {
    const file = await this.load();
    const existing = file.events.find((event) => event.proposalId === proposalId
      && (replySourceId ? event.replySourceId === replySourceId : event.observations.includes("no-reply-window")));
    if (existing) {
      if (inference.confidence > existing.inference.confidence) {
        existing.inference = inference;
        existing.observations = inference.observations;
        if (this.mode === "adaptive" && inference.confidence >= 0.7) this.adapt(file.policy, inference.label);
        file.updatedAt = Date.now();
        await this.save(file);
      }
      return existing;
    }
    const event: ExpressionFeedbackEvent = {
      id: randomBytes(8).toString("hex"), proposalId, ...(replySourceId ? { replySourceId } : {}),
      ...(replyText ? { replyText: replyText.slice(0, 1000) } : {}), observedAt: Date.now(),
      observations: inference.observations, inference,
    };
    file.events.push(event);
    file.events = file.events.slice(-1000);
    if (this.mode === "adaptive" && inference.confidence >= 0.7) this.adapt(file.policy, inference.label);
    file.updatedAt = Date.now();
    await this.save(file);
    return event;
  }

  private adapt(policy: AdaptiveExpressionPolicyState, label: ExpressionFeedbackEvent["inference"]["label"]): void {
    const negative = ["annoying", "bad-timing", "not-useful", "already-known", "corrected"].includes(label);
    const positive = ["useful", "adopted"].includes(label);
    if (!negative && !positive) return;
    policy.samples += 1;
    const direction = negative ? 1 : -1;
    policy.minimumAgeMultiplier = Math.max(0.75, Math.min(3, policy.minimumAgeMultiplier + direction * 0.15));
    policy.valueThresholdDelta = Math.max(-0.08, Math.min(0.2, policy.valueThresholdDelta + direction * 0.025));
    policy.interruptionCost = Math.max(0.1, Math.min(1, policy.interruptionCost + direction * 0.05));
  }

  private save(file: ExpressionFeedbackStoreFile): Promise<void> {
    const pending = this.writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.promises.writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await fs.promises.rename(temp, this.filePath);
      await fs.promises.chmod(this.filePath, 0o600).catch(() => undefined);
    });
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
}
