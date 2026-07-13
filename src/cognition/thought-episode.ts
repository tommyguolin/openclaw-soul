import type { EpistemicNature } from "../thought-pool.js";

export interface ThoughtEvidence {
  sourceId: string;
  relation: "supports" | "contradicts" | "refines" | "context";
  grounded: boolean;
  strength: number;
  observedAt: number;
}

export interface ThoughtRevision {
  previousContent: string;
  content: string;
  reason: string;
  revisedAt: number;
}

export interface ThoughtEpisode {
  id: string;
  workspaceId: string;
  content: string;
  epistemicNature: EpistemicNature;
  state: "forming" | "stable" | "revised" | "dissolved" | "superseded";
  causalTraceIds: string[];
  evidence: ThoughtEvidence[];
  revisions: ThoughtRevision[];
  activationCount: number;
  distinctStimulusIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ThoughtEpisodeStoreFile {
  version: 1;
  updatedAt: number;
  episodes: ThoughtEpisode[];
}
