import { statSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { resolveEgoStorePath, updateEgoStore } from "./ego-store.js";
import { createSoulLogger } from "./logger.js";
import type { ProjectContext } from "./types.js";

const log = createSoulLogger("project-context");
const PROJECT_MARKERS = new Set([
  ".git", "package.json", "pyproject.toml", "setup.py", "requirements.txt",
  "pom.xml", "build.gradle", "build.gradle.kts", "cargo.toml", "go.mod", "makefile",
]);
const PATH_KEYS = /^(?:path|file|filePath|file_path|filename|workdir|cwd|directory|projectDir|project_dir)$/i;
const CONTEXT_PATH_KEYS = /^(?:workdir|cwd|workspaceDir|workspaceRoot|workspace_dir|workspace_root)$/i;
const WRITE_TOOL = /(?:write|edit|patch|apply_patch|replace|create_file)/i;
const VERIFY_COMMAND = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck)|(?:^|\s)(?:pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|tsc\b)/i;
const MAX_CONTEXTS = 10;
const MAX_FILES = 30;
const MAX_COMMANDS = 10;

type ToolCallEvidence = {
  name: string;
  arguments: Record<string, unknown>;
};

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined;
  } catch {
    return { input: value };
  }
}

function currentSuccessfulToolCalls(messages: unknown[]): ToolCallEvidence[] {
  const records = messages.filter((message): message is Record<string, unknown> =>
    !!message && typeof message === "object" && !Array.isArray(message));
  let lastUserIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const turn = records.slice(lastUserIndex >= 0 ? lastUserIndex + 1 : 0);
  const successfulResults = new Set<string>();
  for (const message of turn) {
    if (message.role !== "toolResult" || message.isError === true) continue;
    if (message.result && typeof message.result === "object" && (message.result as Record<string, unknown>).isError === true) continue;
    if (typeof message.toolCallId === "string") successfulResults.add(message.toolCallId);
  }

  const calls: ToolCallEvidence[] = [];
  for (const message of turn) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const call = part as Record<string, unknown>;
      if (call.type !== "toolCall" || typeof call.id !== "string" || !successfulResults.has(call.id)) continue;
      if (typeof call.name !== "string" || call.name === "message") continue;
      const args = parseArguments(call.arguments ?? call.input);
      if (args) calls.push({ name: call.name, arguments: args });
    }
  }
  return calls;
}

function collectArgumentStrings(value: unknown, key = "", output: Array<{ key: string; value: string }> = []): Array<{ key: string; value: string }> {
  if (typeof value === "string") {
    output.push({ key, value });
  } else if (Array.isArray(value)) {
    for (const item of value) collectArgumentStrings(item, key, output);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectArgumentStrings(child, childKey, output);
    }
  }
  return output;
}

function extractPathReferences(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:[A-Za-z]:[\\/][^\s\r\n"'<>|*?]+|\/mnt\/[A-Za-z]\/[^\s"'<>|]+|\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~(){}\[\]+,@%=-]+)+)/g)) {
    found.add(match[0].trim().replace(/[),.;:]+$/g, ""));
  }
  for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) {
    found.add(match[1].trim());
  }
  return [...found];
}

function existingStartDirectory(candidate: string): string | undefined {
  const cleaned = candidate.trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned || !isAbsolute(cleaned)) return undefined;
  let current = resolve(cleaned);
  try {
    if (statSync(current).isFile()) current = dirname(current);
  } catch {
    current = dirname(current);
  }
  try {
    return statSync(current).isDirectory() ? current : undefined;
  } catch {
    return undefined;
  }
}

export function findProjectRoot(candidate: string): string | undefined {
  let current = existingStartDirectory(candidate);
  if (!current) return undefined;
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const names = readdirSync(current).map((name) => name.toLowerCase());
      if (names.some((name) => PROJECT_MARKERS.has(name))) return current;
    } catch {
      return undefined;
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return undefined;
}

function appendUnique(items: string[], values: string[], limit: number): string[] {
  return [...new Set([...items, ...values])].slice(-limit);
}

export async function recordAgentProjectActivity(
  messages: unknown[],
  sessionKey?: string,
  hostContext?: unknown,
): Promise<ProjectContext[]> {
  const calls = currentSuccessfulToolCalls(messages);
  if (calls.length === 0) return [];
  const now = Date.now();
  const activity = new Map<string, {
    observedFiles: string[];
    modifiedFiles: string[];
    verificationCommands: string[];
    modified: boolean;
    lastEvidenceOrder: number;
  }>();

  const baseDirectories = new Set<string>();
  const contextStrings = collectArgumentStrings(hostContext);
  for (const item of contextStrings) {
    if (!CONTEXT_PATH_KEYS.test(item.key) || !isAbsolute(item.value.trim())) continue;
    const start = existingStartDirectory(item.value);
    if (start) baseDirectories.add(start);
  }
  for (const call of calls) {
    for (const item of collectArgumentStrings(call.arguments)) {
      if (!/^(?:workdir|cwd)$/i.test(item.key) || !isAbsolute(item.value.trim())) continue;
      const start = existingStartDirectory(item.value);
      if (start) baseDirectories.add(start);
    }
  }

  let evidenceOrder = 0;
  for (const call of calls) {
    const strings = collectArgumentStrings(call.arguments);
    const candidates = new Set<string>();
    for (const item of strings) {
      const direct = item.value.trim();
      if (PATH_KEYS.test(item.key)) {
        if (isAbsolute(direct)) candidates.add(direct);
        else for (const base of baseDirectories) candidates.add(resolve(base, direct));
      }
      for (const reference of extractPathReferences(item.value)) {
        if (isAbsolute(reference)) candidates.add(reference);
        else for (const base of baseDirectories) candidates.add(resolve(base, reference));
      }
    }
    for (const candidate of candidates) {
      const root = findProjectRoot(candidate);
      if (!root) continue;
      const entry = activity.get(root) ?? {
        observedFiles: [], modifiedFiles: [], verificationCommands: [], modified: false, lastEvidenceOrder: 0,
      };
      entry.lastEvidenceOrder = evidenceOrder;
      evidenceOrder += 1;
      const resolvedCandidate = resolve(candidate);
      let file = "";
      try {
        if (statSync(resolvedCandidate).isFile()) file = relative(root, resolvedCandidate).replace(/\\/g, "/");
      } catch {
        if (dirname(resolvedCandidate).toLowerCase().startsWith(root.toLowerCase())) {
          file = relative(root, resolvedCandidate).replace(/\\/g, "/");
        }
      }
      if (file && !file.startsWith("..")) entry.observedFiles.push(file);
      if (WRITE_TOOL.test(call.name) && file && !file.startsWith("..")) {
        entry.modifiedFiles.push(file);
        entry.modified = true;
      }
      const command = strings.find((item) => /^(?:command|cmd)$/i.test(item.key))?.value;
      if (command && VERIFY_COMMAND.test(command)) entry.verificationCommands.push(command.slice(0, 500));
      activity.set(root, entry);
    }
  }

  if (activity.size === 0) return [];
  const preferredRoot = [...activity.entries()]
    .sort((a, b) => Number(b[1].modified) - Number(a[1].modified)
      || b[1].lastEvidenceOrder - a[1].lastEvidenceOrder)[0][0];
  const recorded: ProjectContext[] = [];
  await updateEgoStore(resolveEgoStorePath(), (ego) => {
    for (const [root, evidence] of activity) {
      const existing = (ego.projectContexts ?? []).find((context) =>
        context.root.toLowerCase() === root.toLowerCase());
      const context: ProjectContext = existing ?? {
        root,
        name: parse(root).base,
        source: "agent-tool",
        confidence: 0.9,
        observedFiles: [],
        modifiedFiles: [],
        verificationCommands: [],
        lastObservedAt: now,
      };
      context.source = "agent-tool";
      context.confidence = evidence.modified ? 1 : Math.max(context.confidence, 0.9);
      context.sessionKey = sessionKey ?? context.sessionKey;
      context.lastObservedAt = now;
      if (evidence.modified) context.lastModifiedAt = now;
      context.observedFiles = appendUnique(context.observedFiles, evidence.observedFiles, MAX_FILES);
      context.modifiedFiles = appendUnique(context.modifiedFiles, evidence.modifiedFiles, MAX_FILES);
      context.verificationCommands = appendUnique(context.verificationCommands, evidence.verificationCommands, MAX_COMMANDS);
      ego.projectContexts = [context, ...(ego.projectContexts ?? []).filter((item) =>
        item.root.toLowerCase() !== root.toLowerCase())].slice(0, MAX_CONTEXTS);
      recorded.push({
        ...context,
        observedFiles: [...new Set(evidence.observedFiles)],
        modifiedFiles: [...new Set(evidence.modifiedFiles)],
        verificationCommands: [...new Set(evidence.verificationCommands)],
        lastModifiedAt: evidence.modified ? now : undefined,
      });
    }
    ego.activeProjectRoot = preferredRoot;
    return ego;
  });
  log.info(`Recorded host-agent project context: ${recorded.map((context) => context.root).join(", ")}`);
  return recorded;
}
