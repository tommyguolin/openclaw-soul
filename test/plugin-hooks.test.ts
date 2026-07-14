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
    const projectDir = path.join(directory, "host-agent-project");
    const sourceFile = path.join(projectDir, "src", "app.ts");
    await fs.promises.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.promises.writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "host-agent-project" }), "utf8");
    await fs.promises.writeFile(sourceFile, "export const ready = true;\n", "utf8");
    const { default: plugin } = await import(`../index.js?hooks=${Date.now()}`);
    const handlers = new Map<string, (event: any, ctx?: any) => Promise<unknown>>();
    plugin.register({
      pluginConfig: { cognitionMode: "primary" },
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
    const directiveText = "Please fix it";
    await received({ content: directiveText, from: "user", messageId: "in-2" }, {
      channelId: "feishu",
      conversationId: "chat-1",
      sessionKey: "agent:main:feishu:direct:user",
    });
    const intentionFile = path.join(directory, "soul", "intentions.json");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(intentionFile)) break;
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
        { role: "user", content: [{ type: "text", text: directiveText }] },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-project-shell",
              name: "shell_command",
              arguments: { command: "npm test", workdir: projectDir },
            },
            {
              type: "toolCall",
              id: "tool-project-edit",
              name: "apply_patch",
              arguments: { input: "*** Update File: src/app.ts\n" },
            },
            {
              type: "toolCall",
              id: "tool-4",
              name: "message",
              arguments: { action: "send", channel: "feishu", message: "Dies ist die normale gestreamte Antwort des Assistenten." },
            },
          ],
        },
        { role: "toolResult", toolName: "shell_command", toolCallId: "tool-project-shell", isError: false },
        { role: "toolResult", toolName: "apply_patch", toolCallId: "tool-project-edit", isError: false },
        { role: "toolResult", toolName: "message", toolCallId: "tool-4", isError: false },
      ],
    }, {
      channelId: "feishu",
      conversationId: "chat-1",
      sessionKey: "agent:main:feishu:direct:user",
      workspaceDir: projectDir,
    });
    // A normal final is not proof of delivery in message_tool_only mode and
    // must not be recorded as an outbound interaction.
    await agentEnd({
      success: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "Guten Tag" }] },
        { role: "assistant", content: [{ type: "text", text: "Private final without confirmed delivery must stay private." }] },
      ],
    }, { channelId: "feishu", sessionKey: "agent:main:feishu:direct:user" });
    const failedProjectDir = path.join(directory, "failed-project");
    const failedFile = path.join(failedProjectDir, "failed.ts");
    await fs.promises.mkdir(failedProjectDir, { recursive: true });
    await fs.promises.writeFile(path.join(failedProjectDir, "package.json"), "{}", "utf8");
    await fs.promises.writeFile(failedFile, "export {};\n", "utf8");
    await agentEnd({
      success: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "failure case" }] },
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "failed-project-edit",
            name: "apply_patch",
            arguments: { input: `*** Update File: ${failedFile}\n` },
          }],
        },
        { role: "toolResult", toolName: "apply_patch", toolCallId: "failed-project-edit", isError: true },
      ],
    }, { channelId: "feishu", sessionKey: "agent:main:feishu:direct:user", workspaceDir: failedProjectDir });
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
    assert.equal(stored.ego.activeProjectRoot, projectDir);
    const projectContext = stored.ego.projectContexts.find((context: any) => context.root === projectDir);
    assert(projectContext);
    assert.equal(projectContext.confidence, 1);
    assert.deepEqual(projectContext.modifiedFiles, ["src/app.ts"]);
    assert.deepEqual(projectContext.verificationCommands, ["npm test"]);
    assert.equal(stored.ego.projectContexts.some((context: any) => context.root === failedProjectDir), false);
    const handoffFile = JSON.parse(await fs.promises.readFile(path.join(directory, "soul", "work-handoffs.json"), "utf8"));
    assert.equal(handoffFile.handoffs.length, 1);
    assert.equal(handoffFile.handoffs[0].objective, directiveText);
    assert.equal(handoffFile.handoffs[0].targetProjectRoot, projectDir);
    assert.equal(handoffFile.handoffs[0].phase, "verified");
    assert.deepEqual(handoffFile.handoffs[0].modifiedFiles, ["src/app.ts"]);
    assert.match(handoffFile.handoffs[0].acceptanceCriteria.join(" "), /concrete changed files/);
    assert.match(handoffFile.handoffs[0].acceptanceCriteria.join(" "), /verification command passes/);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("config hot reload registers a new Soul service generation", async () => {
  const { default: plugin } = await import(`../index.js?reload=${Date.now()}`);
  const services: Array<{
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }> = [];
  const register = (autonomousActions: boolean) => plugin.register({
    pluginConfig: { autonomousActions },
    config: {},
    on() {},
    registerService(service: {
      id: string;
      start: () => Promise<void>;
      stop: () => Promise<void>;
    }) {
      services.push(service);
    },
  });

  register(false);
  register(false);
  assert.equal(services.length, 1, "same-config registry reuse must keep one service generation");

  register(true);
  assert.equal(services.length, 2, "changed config must register a replacement service generation");
  assert.equal(services[0]?.id, "soul-thought-service");
  assert.equal(services[1]?.id, "soul-thought-service");
  assert.notEqual(services[0]?.start, services[1]?.start);
  assert.notEqual(services[0]?.stop, services[1]?.stop);
});
