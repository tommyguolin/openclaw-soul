import type { LLMGenerator } from "../soul-llm.js";
import { parseSpontaneousResponse } from "../thought-emergence.js";
import type { CognitiveWorkspace, EmergenceResult } from "./types.js";

export function buildWorkspaceEmergencePrompt(workspace: CognitiveWorkspace, language?: string): string {
  const materials = workspace.items.map((item, index) =>
    `--- material ${index + 1} (${item.role === "associative" ? "exploratory association" : "current attention"}, `
    + `${item.trace.provenance}, activation=${item.activation.toFixed(2)})\n${item.trace.content.slice(0, 400)}`
    + (item.association ? `\n[bridge=${item.association.bridgeLabels.join(",")}; this relation is a hypothesis, not evidence]` : "")
  ).join("\n");
  return `These contents are momentarily present in private attention:

${materials}

Develop whatever natural thought follows from the materials. It may analyze,
question, explain, advise, plan, connect ideas, or propose next steps, with the
same depth and completeness as a response in the main conversation.
Do not force unrelated materials into a connection.
Exploratory association materials are prompts for a possible question or analogy, never evidence that a connection is true.
If a thought depends on an exploratory bridge, keep that uncertainty visible in the thought itself.

Express the complete thought naturally. There is no sentence, word, or character limit.
If no distinct verbal thought forms, output exactly NO_THOUGHT.
${language ? `Use language compatible with: ${language}.` : "Use the natural language of the materials."}

Otherwise return only compact JSON in this exact shape:
{"thought":"the private thought","cognitiveMove":"question|analogy|speculation|recommendation|research|problem-solving|causal-analysis|counterexample|comparison|synthesis|experiment-design|prioritization|reframing|release|outreach|follow-up|confusion|reflection","qualityFlags":[]}

Classify cognitiveMove and qualityFlags by meaning regardless of the language used in thought.
qualityFlags may contain "meta-framing", "forced-association", "task-pressure", or "empty-intention". Do not add markdown.`;
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
    const assessment = parseSpontaneousResponse(cleaned);
    const content = assessment.content.trim();
    if (!content || /^NO_THOUGHT[.!]?$/i.test(content)) {
      return { outcome: "silence", reason: "model-no-thought" };
    }
    const cognitiveMove = assessment.cognitiveMove;
    const qualityFlags = [...assessment.qualityFlags];
    if (workspace.items.some((item) => item.role === "associative")
      && !["question", "analogy", "speculation", "confusion"].includes(cognitiveMove)) {
      qualityFlags.push("association-unverified");
    }
    return {
      outcome: "thought",
      content,
      cognitiveMove,
      qualityFlags,
    };
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
