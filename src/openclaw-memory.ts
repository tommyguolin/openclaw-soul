import { createSoulLogger } from "./logger.js";

const log = createSoulLogger("memory");

/**
 * Search all registered memory corpus supplements via OpenClaw's plugin SDK.
 * Works with any memory plugin that registers via registerMemoryCorpusSupplement
 * (Hindsight, memory-wiki, memory-lancedb, or any third-party memory plugin).
 *
 * Extracts keywords from the query and searches with each to maximize match rate.
 */
export async function searchExternalMemories(
  query: string,
  maxResults = 3,
): Promise<{ snippet: string; source: string }[]> {
  if (!query || query.length < 3) return [];

  try {
    const { listMemoryCorpusSupplements } = await import(
      "openclaw/plugin-sdk/memory-host-core"
    );
    const supplements = listMemoryCorpusSupplements();
    if (supplements.length === 0) return [];

    // Extract keywords for more reliable matching across different search engines
    const keywords = extractKeywords(query, 3);
    const candidates = keywords.length > 0 ? keywords : [query.slice(0, 40)];

    const results: { snippet: string; source: string }[] = [];
    const seen = new Set<string>();

    for (const registration of supplements) {
      for (const searchQuery of candidates) {
        if (results.length >= maxResults) break;
        try {
          const searchResults = await registration.supplement.search({
            query: searchQuery,
            maxResults: maxResults - results.length,
          });
          for (const hit of searchResults) {
            const key = hit.snippet ?? hit.title ?? "";
            if (!key || seen.has(key)) continue;
            seen.add(key);
            results.push({
              snippet: key,
              source: hit.source ?? registration.pluginId,
            });
          }
        } catch {
          // skip this query for this plugin
        }
      }
    }

    if (results.length > 0) {
      log.info(`External memory: ${results.length} result(s) via "${candidates.join(", ")}"`);
    }
    return results;
  } catch {
    // Plugin SDK not available
    return [];
  }
}

/**
 * Format search results into a prompt section.
 */
export function formatMemoryContext(results: { snippet: string; source: string }[]): string {
  if (results.length === 0) return "";
  const lines = results
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.snippet} (from ${r.source})`);
  return `**Recalled from memory plugins**:\n${lines.join("\n")}`;
}

function extractKeywords(text: string, max = 3): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "can", "not",
    "i", "me", "my", "we", "you", "he", "she", "it", "they", "them",
    "this", "that", "what", "how", "why", "when", "for", "with",
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "都",
    "一", "上", "也", "很", "到", "说", "要", "去", "你", "会",
    "着", "没有", "看", "好", "吗", "吧", "呢", "啊", "把", "被",
    "让", "给", "从", "对", "跟", "与",
  ]);
  return [...new Set(
    text
      .split(/[\s,，。.！!？?；;：:、（）()\[\]{}""''\n\r]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length >= 3 && !stopWords.has(w)),
  )].slice(0, max);
}
