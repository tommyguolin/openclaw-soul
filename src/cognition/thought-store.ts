import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { contentTokens, jaccard } from "../thought-emergence.js";
import type { EpistemicNature } from "../thought-pool.js";
import type { ThoughtEpisode, ThoughtEpisodeStoreFile, ThoughtEvidence } from "./thought-episode.js";

export function resolveThoughtEpisodeStorePath(egoStorePath: string): string {
  return path.join(path.dirname(path.resolve(egoStorePath)), "thought-episodes.json");
}

export interface ThoughtEpisodeInput {
  workspaceId: string;
  content: string;
  epistemicNature: EpistemicNature;
  causalTraceIds: string[];
  stimulusId?: string;
  evidence: ThoughtEvidence[];
}

export type ThoughtIntegrationOperation = "created" | "supported" | "revised" | "contradicted";

function contradictsPrior(content: string): boolean {
  return /(?:并不是|不是.*而是|与之前.*相反|推翻|不再认为|rather than|not .* but|contradict|opposite|earlier .* wrong)/i.test(content);
}

export class ThoughtEpisodeStore {
  private writeChain: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string) {}

  async load(): Promise<ThoughtEpisodeStoreFile> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")) as Partial<ThoughtEpisodeStoreFile>;
      if (parsed.version === 1 && Array.isArray(parsed.episodes)) {
        return { version: 1, updatedAt: Number(parsed.updatedAt) || Date.now(), episodes: parsed.episodes };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { version: 1, updatedAt: Date.now(), episodes: [] };
  }

  async integrate(input: ThoughtEpisodeInput): Promise<{ episode: ThoughtEpisode; operation: ThoughtIntegrationOperation }> {
    const file = await this.load();
    const incomingTokens = contentTokens(input.content);
    const active = file.episodes
      .filter((episode) => !["dissolved", "superseded"].includes(episode.state))
      .map((episode) => ({
        episode,
        similarity: jaccard(incomingTokens, contentTokens(episode.content)),
        causalOverlap: jaccard(input.causalTraceIds, episode.causalTraceIds),
      }))
      .filter((entry) => entry.similarity >= 0.45 || entry.causalOverlap >= 0.5)
      .sort((a, b) => b.similarity - a.similarity || b.causalOverlap - a.causalOverlap)[0];
    const now = Date.now();
    if (!active) {
      const episode: ThoughtEpisode = {
        id: randomBytes(8).toString("hex"), workspaceId: input.workspaceId,
        content: input.content, epistemicNature: input.epistemicNature,
        state: "forming", causalTraceIds: [...new Set(input.causalTraceIds)], evidence: input.evidence,
        revisions: [], activationCount: 1, distinctStimulusIds: input.stimulusId ? [input.stimulusId] : [],
        createdAt: now, updatedAt: now,
      };
      file.episodes.push(episode);
      file.updatedAt = now;
      await this.save(file);
      return { episode, operation: "created" };
    }

    const episode = active.episode;
    episode.activationCount += 1;
    episode.updatedAt = now;
    episode.causalTraceIds = [...new Set([...episode.causalTraceIds, ...input.causalTraceIds])];
    episode.evidence.push(...input.evidence);
    episode.evidence = episode.evidence.slice(-50);
    if (input.stimulusId) episode.distinctStimulusIds = [...new Set([...episode.distinctStimulusIds, input.stimulusId])];
    let operation: ThoughtIntegrationOperation = "supported";
    if (contradictsPrior(input.content)) {
      episode.evidence.push(...input.evidence.map((item) => ({ ...item, relation: "contradicts" as const })));
      episode.revisions.push({ previousContent: episode.content, content: input.content,
        reason: "new workspace content contradicted the prior interpretation", revisedAt: now });
      episode.content = input.content;
      episode.epistemicNature = input.epistemicNature;
      episode.state = "revised";
      operation = "contradicted";
    } else if (active.similarity < 0.9 && input.content.trim() !== episode.content.trim()) {
      episode.revisions.push({ previousContent: episode.content, content: input.content,
        reason: "new activation refined the same developing thought", revisedAt: now });
      episode.content = input.content;
      episode.epistemicNature = input.epistemicNature;
      episode.state = "revised";
      operation = "revised";
    } else if (episode.distinctStimulusIds.length >= 2) {
      episode.state = "stable";
    }
    file.updatedAt = now;
    await this.save(file);
    return { episode, operation };
  }

  async supersedeRelated(resolutionText: string, evidenceId?: string): Promise<ThoughtEpisode[]> {
    const file = await this.load();
    const tokens = contentTokens(resolutionText);
    const now = Date.now();
    const changed = file.episodes.filter((episode) => !["dissolved", "superseded"].includes(episode.state)
      && jaccard(tokens, contentTokens(episode.content)) >= 0.12);
    for (const episode of changed) {
      episode.state = "superseded";
      episode.updatedAt = now;
      episode.evidence.push({ sourceId: evidenceId ?? "resolution", relation: "contradicts",
        grounded: true, strength: 1, observedAt: now });
    }
    if (changed.length > 0) {
      file.updatedAt = now;
      await this.save(file);
    }
    return changed;
  }

  private save(file: ThoughtEpisodeStoreFile): Promise<void> {
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
