import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThoughtService } from "../src/thought-service.js";

test("interaction ingestion stores inbound and outbound text with provenance and deduplicates message IDs", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-interaction-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const service = new ThoughtService({ storePath });
    await service.recordInteractionWithText({
      type: "inbound",
      text: "请帮我检查订单状态同步逻辑",
      messageId: "in-1",
      channel: "feishu",
      conversationId: "chat-1",
    });
    await service.recordInteractionWithText({
      type: "outbound",
      text: "我会检查断线重连后的订单状态。",
      messageId: "out-1",
      channel: "feishu",
      conversationId: "chat-1",
    });
    await service.recordInteractionWithText({
      type: "outbound",
      text: "这条重复投递不应被记录。",
      messageId: "out-1",
      channel: "feishu",
      conversationId: "chat-1",
    });
    await service.recordInteractionWithText({
      type: "outbound",
      text: "我会检查断线重连后的订单状态。",
      channel: "feishu",
      conversationId: "chat-1",
    });

    const ego = await service.getEgoState();
    const interactions = ego.memories.filter((memory) => memory.type === "interaction");
    assert.equal(ego.totalInteractions, 2);
    assert.equal(ego.totalSentimentSamples, 1);
    assert.equal(interactions.length, 2);
    assert(interactions.some((memory) => memory.tags.includes("inbound")));
    assert(interactions.some((memory) => memory.tags.includes("outbound")));
    assert(interactions.every((memory) => memory.sourceChannel === "feishu"));
    assert(interactions.every((memory) => memory.sourceConversationId === "chat-1"));
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("short non-Latin messages are retained for model semantic classification", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-short-language-"));
  try {
    const service = new ThoughtService({ storePath: path.join(directory, "ego.json") });
    await service.recordInteractionWithText({ type: "inbound", text: "修正", messageId: "ja-short" });
    const ego = await service.getEgoState();
    assert.equal(ego.memories.at(-1)?.content, "修正");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("startup migration removes internal OpenAI transcripts but preserves real outbound messages", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-interaction-migration-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const service = new ThoughtService({ storePath });
    await service.recordInteractionWithText({
      type: "outbound", text: "internal shadow JSON", channel: "openai",
      conversationId: "agent:main:openai:run-id",
    });
    await service.recordInteractionWithText({
      type: "outbound", text: "real German reply", channel: "feishu",
      conversationId: "agent:main:feishu:direct:user",
    });
    type MigrationInternals = { removeInternalModelInteractions(ego: Awaited<ReturnType<ThoughtService["getEgoState"]>>): Promise<Awaited<ReturnType<ThoughtService["getEgoState"]>>> };
    const ego = await service.getEgoState();
    const migrated = await (service as unknown as MigrationInternals).removeInternalModelInteractions(ego);
    assert.equal(migrated.memories.some((memory) => memory.content === "internal shadow JSON"), false);
    assert.equal(migrated.memories.some((memory) => memory.content === "real German reply"), true);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
