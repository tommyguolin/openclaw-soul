import assert from "node:assert/strict";
import test from "node:test";
import { soulWebSearch } from "../src/soul-search.js";

test("DuckDuckGo is accepted as an explicit key-free search provider", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(`
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle">Useful &amp; Current</a>
        <a class="result__snippet">A concrete external finding.</a>
      </div>
    `, { status: 200 });
  };

  try {
    const results = await soulWebSearch("useful current topic", {
      tools: { web: { search: { provider: "duckduckgo" } } },
      plugins: { entries: { duckduckgo: { config: { webSearch: { region: "cn-zh", safeSearch: "moderate" } } } } },
    });
    assert.equal(results?.length, 1);
    assert.equal(results?.[0]?.title, "Useful & Current");
    assert.equal(results?.[0]?.url, "https://example.com/article");
    assert.equal(results?.[0]?.snippet, "A concrete external finding.");
    assert.match(requestedUrl, /html\.duckduckgo\.com\/html/);
    assert.match(requestedUrl, /kl=cn-zh/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
