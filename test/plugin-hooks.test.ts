import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("reply delivery captures confirmed assistant replies once and ignores private model runs", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-plugin-hooks-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = directory;
  try {
    const { default: plugin } = await import(`../index.js?hooks=${Date.now()}`);
    const handlers = new Map<string, (event: any, ctx?: any) => Promise<unknown>>();
    plugin.register({
      pluginConfig: {},
      config: {},
      on(name: string, handler: (event: any, ctx?: any) => Promise<unknown>) {
        handlers.set(name, handler);
      },
      registerService() {},
    });
    const replyPayload = handlers.get("reply_payload_sending");
    const afterToolCall = handlers.get("after_tool_call");
    const agentEnd = handlers.get("agent_end");
    const received = handlers.get("message_received");
    assert(replyPayload);
    assert(afterToolCall);
    assert(agentEnd);
    assert(received);
    await received({ content: "Guten Tag", from: "user", messageId: "in-1" }, {
      channelId: "feishu",
      conversationId: "chat-1",
      sessionKey: "agent:main:feishu:direct:user",
    });
    const egoFile = path.join(directory, "soul", "ego.json");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(egoFile) && (await fs.promises.readFile(egoFile, "utf8")).includes("Guten Tag")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await replyPayload({
      kind: "block",
      payload: { text: "partial streaming fragment must not become a memory" },
      channel: "feishu",
      sessionKey: "agent:main:feishu:direct:user",
      runId: "run-1",
    }, { channelId: "feishu", conversationId: "chat-1" });
    await afterToolCall({
      toolName: "message",
      params: { action: "send", channel: "feishu", message: "Dies ist die normale gestreamte Antwort des Assistenten." },
      toolCallId: "tool-1",
      result: { isError: false },
    }, { channelId: "feishu", sessionKey: "agent:main:feishu:direct:user" });
    await agentEnd({
      success: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "Guten Tag" }] },
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "tool-4",
            name: "message",
            arguments: { action: "send", channel: "feishu", message: "Dies ist die normale gestreamte Antwort des Assistenten." },
          }],
        },
        { role: "toolResult", toolName: "message", toolCallId: "tool-4", isError: false },
      ],
    }, { channelId: "feishu", sessionKey: "agent:main:feishu:direct:user" });
    // A normal final is not proof of delivery in message_tool_only mode and
    // must not be recorded as an outbound interaction.
    await agentEnd({
      success: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "Guten Tag" }] },
        { role: "assistant", content: [{ type: "text", text: "Private final without confirmed delivery must stay private." }] },
      ],
    }, { channelId: "feishu", sessionKey: "agent:main:feishu:direct:user" });
    await agentEnd({
      success: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "failure case" }] },
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "tool-5",
            name: "message",
            arguments: JSON.stringify({ action: "send", message: "Failed nested send must stay private." }),
          }],
        },
        { role: "toolResult", toolName: "message", toolCallId: "tool-5", isError: true },
      ],
    }, { channelId: "feishu", sessionKey: "agent:main:feishu:direct:user" });
    await afterToolCall({
      toolName: "message",
      params: { action: "send", channel: "feishu", message: "This failed send must not become a memory." },
      toolCallId: "tool-2",
      error: "delivery failed",
    }, { channelId: "feishu", sessionKey: "agent:main:feishu:direct:user" });
    await afterToolCall({
      toolName: "message",
      params: { action: "edit", channel: "feishu", message: "An edit must not become a new outbound memory." },
      toolCallId: "tool-3",
      result: { isError: false },
    }, { channelId: "feishu", sessionKey: "agent:main:feishu:direct:user" });
    await replyPayload({
      kind: "final",
      payload: { text: "Dies ist die normale gestreamte Antwort des Assistenten." },
      channel: "feishu",
      sessionKey: "agent:main:feishu:direct:user",
      runId: "run-1",
    }, { channelId: "feishu", conversationId: "chat-1" });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(egoFile) && (await fs.promises.readFile(egoFile, "utf8")).includes("normale gestreamte")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stored = JSON.parse(await fs.promises.readFile(egoFile, "utf8"));
    const outbound = stored.ego.memories.filter((memory: any) => memory.tags.includes("outbound"));
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].content, "Dies ist die normale gestreamte Antwort des Assistenten.");
    assert.equal(stored.ego.memories.some((memory: any) => memory.content.includes("partial streaming")), false);
    assert.equal(stored.ego.memories.some((memory: any) => memory.content.includes("failed send")), false);
    assert.equal(stored.ego.memories.some((memory: any) => memory.content.includes("An edit")), false);
    assert.equal(stored.ego.memories.some((memory: any) => memory.content.includes("Failed nested")), false);
    assert.equal(stored.ego.memories.some((memory: any) => memory.content.includes("Private final")), false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
