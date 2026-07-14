export type WorkHandoffPhase = "investigating" | "implementing" | "verified" | "blocked";

export interface WorkHandoff {
  id: string;
  intentionId: string;
  objective: string;
  targetProjectRoot: string;
  sessionKey?: string;
  phase: WorkHandoffPhase;
  acceptanceCriteria: string[];
  observedFiles: string[];
  modifiedFiles: string[];
  verificationCommands: string[];
  failedTools: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkHandoffStoreFile {
  version: 1;
  updatedAt: number;
  handoffs: WorkHandoff[];
}
