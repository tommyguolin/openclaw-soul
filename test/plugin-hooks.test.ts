import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("before_message_write captures streamed assistant replies but ignores private model runs", async () => {
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
    const write = handlers.get("before_message_write");
    const received = handlers.get("message_received");
    assert(write);
    assert(received);
    await write({ message: { role: "assistant", content: "private shadow output must stay private" }, sessionKey: "agent:soul" }, {});
    await write({ message: { role: "assistant", content: "internal OpenAI output" }, sessionKey: "agent:main:openai:internal-run" }, {});
    await received({ content: "Guten Tag", from: "user", messageId: "in-1" }, { channelId: "feishu", conversationId: "chat-1" });
    const egoFile = path.join(directory, "soul", "ego.json");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(egoFile) && (await fs.promises.readFile(egoFile, "utf8")).includes("Guten Tag")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await write({
      message: { role: "assistant", content: [{ type: "text", text: "Dies ist die normale gestreamte Antwort des Assistenten." }] },
      sessionKey: "agent:main:feishu:direct:user",
    }, {});

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(egoFile) && (await fs.promises.readFile(egoFile, "utf8")).includes("normale gestreamte")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stored = JSON.parse(await fs.promises.readFile(egoFile, "utf8"));
    const outbound = stored.ego.memories.filter((memory: any) => memory.tags.includes("outbound"));
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].content, "Dies ist die normale gestreamte Antwort des Assistenten.");
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
