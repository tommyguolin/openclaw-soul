export type ExpressionSourceType = "thought" | "intention" | "task-result" | "obligation";
export type ExpressionStatus = "pending" | "sent" | "withheld";
export type WithheldReason =
  | "bad-timing" | "low-value" | "insufficient-evidence" | "unsafe"
  | "duplicate" | "not-user-relevant" | "channel-unavailable";

export interface ExpressionProposal {
  id: string;
  sourceType: ExpressionSourceType;
  sourceId: string;
  content: string;
  reason: string;
  status: ExpressionStatus;
  withheldReason?: WithheldReason;
  createdAt: number;
  evaluatedAt?: number;
}

export interface ExpressionStoreFile {
  version: 1;
  updatedAt: number;
  proposals: ExpressionProposal[];
}
