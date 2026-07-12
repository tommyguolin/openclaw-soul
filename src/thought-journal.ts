import fs from "node:fs";
import path from "node:path";
import type { ActionType, Thought, ThoughtType } from "./types.js";
import type { DetectedThoughtOpportunity } from "./intelligent-thought.js";

export type ThoughtCycleOutcome = "generated" | "skipped" | "failed";

export interface JournalOpportunity {
  type: ThoughtType;
  trigger: string;
  source: string;
  priority: number;
  suggestedAction?: ActionType;
  triggerDetail: string;
  motivation: string;
}

export interface ThoughtCycleJournalRecord {
  version: 1;
  cycleId: string;
  timestamp: number;
  outcome: ThoughtCycleOutcome;
  reason?: string;
  context: {
    currentHour: number;
    dayOfWeek: number;
    urgentNeeds: string[];
    activeGoalIds: string[];
    recentMemoryIds: string[];
    totalMemories: number;
  };
  opportunities: JournalOpportunity[];
  selectedOpportunity?: JournalOpportunity;
  thought?: {
    id: string;
    type: ThoughtType;
    content: string;
    source: string;
    trigger: string;
    motivation: string;
    actionType?: ActionType;
  };
  recentStateBefore: {
    thoughtTypes: string[];
    topicSignatures: string[];
    actionTypes: string[];
  };
}

export interface RestoredThoughtDiversityState {
  thoughtTypes: string[];
  thoughtContents: string[];
  actionTypes: string[];
}

const MAX_JOURNAL_BYTES = 50 * 1024 * 1024;
const READ_TAIL_BYTES = 2 * 1024 * 1024;

function compactText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function compactJournalOpportunity(
  opportunity: DetectedThoughtOpportunity,
): JournalOpportunity {
  return {
    type: opportunity.type,
    trigger: opportunity.trigger,
    source: opportunity.source,
    priority: Number(opportunity.priority.toFixed(2)),
    ...(opportunity.suggestedAction ? { suggestedAction: opportunity.suggestedAction } : {}),
    triggerDetail: compactText(opportunity.triggerDetail, 300),
    motivation: compactText(opportunity.motivation, 300),
  };
}

export function compactJournalThought(thought: Thought): NonNullable<ThoughtCycleJournalRecord["thought"]> {
  return {
    id: thought.id,
    type: thought.type,
    content: compactText(thought.content, 1000),
    source: thought.source,
    trigger: thought.trigger,
    motivation: compactText(thought.motivation, 300),
    ...(thought.actionType ? { actionType: thought.actionType } : {}),
  };
}

export function resolveThoughtJournalPath(storePath: string): string {
  return path.join(path.dirname(path.resolve(storePath)), "thought-cycles.jsonl");
}

async function secureDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(directory, 0o700).catch(() => undefined);
}

async function rotateIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || stat.size + incomingBytes <= MAX_JOURNAL_BYTES) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath, ".jsonl")}.${stamp}.jsonl`,
  );
  await fs.promises.rename(filePath, archivePath);
  await fs.promises.chmod(archivePath, 0o600).catch(() => undefined);
}

async function readTail(filePath: string, maxBytes = READ_TAIL_BYTES): Promise<string> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    let text = buffer.toString("utf8");
    if (stat.size > length) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

export class ThoughtCycleJournal {
  readonly filePath: string;
  private appendChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  append(record: ThoughtCycleJournalRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const write = async () => {
      await secureDirectory(path.dirname(this.filePath));
      await rotateIfNeeded(this.filePath, Buffer.byteLength(line));
      await fs.promises.appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
      await fs.promises.chmod(this.filePath, 0o600).catch(() => undefined);
    };
    const pending = this.appendChain.then(write, write);
    this.appendChain = pending.catch(() => undefined);
    return pending;
  }

  async loadRecent(limit = 20): Promise<ThoughtCycleJournalRecord[]> {
    const directory = path.dirname(this.filePath);
    const basename = path.basename(this.filePath, ".jsonl");
    const entries = await fs.promises.readdir(directory).catch(() => [] as string[]);
    const currentName = path.basename(this.filePath);
    const archives = entries
      .filter((name) => name !== currentName && name.startsWith(`${basename}.`) && name.endsWith(".jsonl"))
      .sort()
      .slice(-2)
      .map((name) => path.join(directory, name));
    const files = [...archives, this.filePath];
    const records: ThoughtCycleJournalRecord[] = [];
    for (const file of files) {
      const text = await readTail(file).catch(() => "");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as ThoughtCycleJournalRecord;
          if (parsed.version === 1 && typeof parsed.timestamp === "number") records.push(parsed);
        } catch {
          // A crash can leave one partial trailing line. Ignore it and preserve prior records.
        }
      }
    }
    return records.sort((a, b) => a.timestamp - b.timestamp).slice(-Math.max(1, limit));
  }

  async restoreDiversityState(): Promise<RestoredThoughtDiversityState> {
    const generated = (await this.loadRecent(50)).filter((record) => record.outcome === "generated" && record.thought);
    return {
      thoughtTypes: generated.map((record) => record.thought!.type).slice(-3),
      thoughtContents: generated.map((record) => record.thought!.content).slice(-10),
      actionTypes: generated
        .map((record) => record.thought!.actionType)
        .filter((value): value is ActionType => Boolean(value && value !== "none"))
        .slice(-5),
    };
  }
}
