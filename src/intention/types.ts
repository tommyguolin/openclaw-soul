export type IntentionOrigin = "user-directive" | "thought" | "obligation" | "maintenance";
export type IntentionStatus = "latent" | "active" | "blocked" | "fulfilled" | "abandoned";

export interface Intention {
  id: string;
  desiredState: string;
  origin: IntentionOrigin;
  originId?: string;
  conversationId?: string;
  commitment: number;
  urgency: number;
  confidence: number;
  evidenceNeeded: string[];
  constraints: string[];
  status: IntentionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface IntentionStoreFile {
  version: 1;
  updatedAt: number;
  intentions: Intention[];
}
