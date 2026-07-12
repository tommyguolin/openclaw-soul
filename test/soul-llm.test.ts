import assert from "node:assert/strict";
import test from "node:test";
import { createSoulLLMGenerator } from "../src/soul-llm.js";

test("LLM generator honors configured maxTokens", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.SOUL_LLM_TEST_KEY;
  let requestBody: Record<string, unknown> | undefined;
  process.env.SOUL_LLM_TEST_KEY = "test-key-for-local-mock";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "a short thought" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const generator = await createSoulLLMGenerator({
      provider: "mock",
      model: "mock-model",
      apiKeyEnv: "SOUL_LLM_TEST_KEY",
      baseUrl: "http://127.0.0.1:1",
      maxTokens: 192,
    });
    assert(generator);
    assert.equal(await generator("test"), "a short thought");
    assert.equal(requestBody?.max_tokens, 192);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.SOUL_LLM_TEST_KEY;
    else process.env.SOUL_LLM_TEST_KEY = originalKey;
  }
});
