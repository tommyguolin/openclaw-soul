import type { EgoState } from "./types.js";

/** Build a model-facing language rule without maintaining a translation table. */
export function buildUserLanguageInstruction(ego: Pick<EgoState, "userLanguage" | "recentUserMessages">): string {
  const samples = (ego.recentUserMessages ?? []).filter((item) => item.trim()).slice(-3);
  if (ego.userLanguage) {
    return `The user's language is BCP-47 ${ego.userLanguage}. Write in that language. `
      + "Preserve the user's natural register and do not switch to English unless the user did.";
  }
  if (samples.length > 0) {
    return `Infer the language from these recent user messages and write in exactly that language:\n${samples.join("\n")}`;
  }
  return "Use the natural language of the available user content; do not assume English when another language is present.";
}

export function supportsLocalMessageTemplate(ego: Pick<EgoState, "userLanguage" | "recentUserMessages">): "zh" | "en" | null {
  if (ego.userLanguage?.toLocaleLowerCase().startsWith("zh")) return "zh";
  if (ego.userLanguage?.toLocaleLowerCase().startsWith("en")) return "en";
  if (!ego.userLanguage && (ego.recentUserMessages ?? []).length === 0) return "en";
  return null;
}
