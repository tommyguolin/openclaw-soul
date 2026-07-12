import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Thought } from "../src/types.js";

test("proactive research never sends model-only claims when search has no evidence", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-grounding-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = directory;
  const { executeProactiveResearch } = await import(`../src/action-executor.js?grounding=${Date.now()}`);
  const { createDefaultEgoState } = await import(`../src/ego-store.js?grounding=${Date.now()}`);
  const ego = createDefaultEgoState();
  ego.recentUserMessages = ["Bitte analysiere meine Handelsstrategie weiter."];
  const thought: Thought = {
    id: "grounding-test", type: "conversation-replay", content: "Research the current strategy",
    trigger: "curiosity", source: "user-interaction", triggerDetail: "latest direction",
    motivation: "find evidence", targetMetrics: [], priority: 80, createdAt: Date.now(),
    expiresAt: Date.now() + 60_000, executed: false, relatedNeeds: [],
    actionType: "proactive-research",
    actionParams: {
      conversationSnippets: "Bitte analysiere meine Handelsstrategie weiter und melde nur belegte Ergebnisse.",
      userProfile: "quantitative trading",
    },
  };
  let modelCalls = 0;
  let sends = 0;
  try {
    const result = await executeProactiveResearch(thought, ego, {
    llmGenerator: async () => {
      modelCalls += 1;
      if (modelCalls === 1) return JSON.stringify({
        topic: "strategy robustness", reason: "current user focus", query: "strategy robustness evidence",
      });
      return "[]";
    },
    sendMessage: async () => { sends += 1; },
    channel: "feishu",
    target: "user",
    openclawConfig: {},
  });
    assert.equal(result.result.result, "skipped-no-search-evidence");
    assert.equal(sends, 0);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
