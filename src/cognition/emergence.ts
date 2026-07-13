import type { LLMGenerator } from "../soul-llm.js";
import { classifyCognitiveMove, classifyThoughtQualityFlags } from "../thought-emergence.js";
import type { CognitiveWorkspace, EmergenceResult } from "./types.js";

export function buildWorkspaceEmergencePrompt(workspace: CognitiveWorkspace, language?: string): string {
  const materials = workspace.items.map((item, index) =>
    `--- material ${index + 1} (${item.trace.provenance}, activation=${item.activation.toFixed(2)})\n${item.trace.content.slice(0, 400)}`
  ).join("\n");
  return `These contents are momentarily present in private attention:

${materials}

Do not look for a task. Do not help, advise, recommend, plan, prioritize, or prepare a reply.
Do not summarize the materials or mention memories, inputs, a user, a boss, or this generation process.
Do not force unrelated materials into a connection.

If one specific private question, observation, tension, connection, or revision of an earlier
interpretation naturally forms, express only that thought in at most two short sentences.
If no distinct verbal thought forms, output exactly NO_THOUGHT.
${language ? `Use language compatible with: ${language}.` : "Use the natural language of the materials."}`;
}

function cleanOutput(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export async function emergeFromWorkspace(
  workspace: CognitiveWorkspace,
  llm: LLMGenerator,
  language?: string,
): Promise<EmergenceResult> {
  if (!workspace.allowEmergence) return { outcome: "silence", reason: "pre-generation" };
  try {
    const cleaned = cleanOutput(await llm(buildWorkspaceEmergencePrompt(workspace, language)));
    if (!cleaned || /^NO_THOUGHT[.!]?$/i.test(cleaned)) {
      return { outcome: "silence", reason: "model-no-thought" };
    }
    let content = cleaned;
    if (cleaned.startsWith("{")) {
      try {
        const parsed = JSON.parse(cleaned) as { thought?: unknown };
        if (typeof parsed.thought === "string") content = parsed.thought.trim();
      } catch {
        // Plain internal language is the primary contract; malformed JSON stays plain text.
      }
    }
    content = content.slice(0, 500).trim();
    if (!content || /^NO_THOUGHT[.!]?$/i.test(content)) {
      return { outcome: "silence", reason: "model-no-thought" };
    }
    return {
      outcome: "thought",
      content,
      cognitiveMove: classifyCognitiveMove(content),
      qualityFlags: classifyThoughtQualityFlags(content),
    };
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
