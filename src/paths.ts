/**
 * Resolve the soul data directory.
 * Uses OPENCLAW_STATE_DIR if set, otherwise ~/.openclaw.
 * This replaces the core CONFIG_DIR dependency.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".openclaw");
}

export const SOUL_DIR = path.join(resolveStateDir(), "soul");
export const DEFAULT_EGO_STORE_PATH = path.join(SOUL_DIR, "ego.json");
export const DEFAULT_KNOWLEDGE_STORE_PATH = path.join(SOUL_DIR, "knowledge.json");
export const DIARY_PATH = path.join(SOUL_DIR, "diary.md");
export const LEARNED_PATH = path.join(SOUL_DIR, "learned.md");

const DEFAULT_WORKSPACE_FILES = ["SOUL.md", "AGENTS.md", "MEMORY.md", "USER.md"];

/**
 * Read workspace context files from the state directory.
 * Returns concatenated content with section headers, capped at 4000 chars.
 * Silently skips files that don't exist.
 */
export async function loadWorkspaceContext(
  files: string[] = DEFAULT_WORKSPACE_FILES,
): Promise<{ content: string; fileCount: number }> {
  const stateDir = resolveStateDir();
  // Workspace files live in the "workspace" subdirectory of state dir
  const workspaceDir = path.join(stateDir, "workspace");
  const sections: string[] = [];
  let totalChars = 0;
  let fileCount = 0;

  for (const filename of files) {
    const filePath = path.join(workspaceDir, filename);
    try {
      const raw = await readFile(filePath, "utf-8");
      const trimmed = raw.trim();
      if (!trimmed) continue;

      fileCount++;
      const section = `### ${filename}\n${trimmed}`;
      totalChars += section.length;
      sections.push(section);

      if (totalChars > 4000) break;
    } catch {
      // File doesn't exist — skip silently
    }
  }

  if (sections.length === 0) return { content: "", fileCount: 0 };

  const content = sections.join("\n\n").slice(0, 4000);
  return { content, fileCount };
}
