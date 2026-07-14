import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildUserDirectiveIntention, isExplicitUserDirective } from "../src/intention/formation.js";
import { IntentionStore } from "../src/intention/store.js";
import { ExpressionStore } from "../src/expression/store.js";
import { ExpressionFeedbackStore } from "../src/expression/feedback-store.js";
import { inferExpressionFeedback, inferNoReplyFeedback } from "../src/expression/feedback.js";
import { ThoughtService } from "../src/thought-service.js";
import { WorkHandoffStore } from "../src/handoff/store.js";

test("directive formation separates requested work from explanation questions", () => {
  assert.equal(isExplicitUserDirective("请检查部署日志并定位 timeout"), true);
  assert.equal(isExplicitUserDirective("Please inspect the deployment logs"), true);
  assert.equal(isExplicitUserDirective("如何检查部署日志？"), false);
  assert.equal(isExplicitUserDirective("Why does the timeout happen?"), false);
});

test("IntentionStore persists and deduplicates a user directive by origin", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-intentions-"));
  const store = new IntentionStore(path.join(dir, "intentions.json"));
  const input = buildUserDirectiveIntention("请检查部署日志", "message-1");
  const first = await store.add(input);
  const second = await store.add(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.intention.id, second.intention.id);
  assert.equal((await store.load()).intentions.length, 1);
  assert.match(first.intention.evidenceNeeded.join(" "), /clear user-facing outcome report/);
});

test("structured semantics give an Arabic code-change directive concrete completion evidence", () => {
  const intention = buildUserDirectiveIntention(
    "حدّث المكوّن وأصلح الخلل",
    "message-arabic-change",
    undefined,
    ["execution-directive", "code-change"],
  );
  assert(intention.evidenceNeeded.includes("concrete changed files"));
  assert(intention.evidenceNeeded.includes("relevant verification command passes"));
  assert.equal(intention.urgency, 0.8);
});

test("a persisted host-agent handoff restores project scope and acceptance criteria after restart", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-handoff-restart-"));
  try {
    const egoPath = path.join(dir, "ego.json");
    const projectDir = path.join(dir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });
    await fs.promises.writeFile(path.join(projectDir, "package.json"), "{}", "utf8");
    const firstService = new ThoughtService({ storePath: egoPath, cognitionMode: "primary" });
    await firstService.recordInteractionWithText({
      type: "inbound",
      text: "请实现项目修复并运行测试",
      messageId: "handoff-directive-1",
    });
    const intentions = JSON.parse(await fs.promises.readFile(path.join(dir, "intentions.json"), "utf8"));
    const intention = intentions.intentions[0];
    const handoffStore = new WorkHandoffStore(path.join(dir, "work-handoffs.json"));
    const handoff = await handoffStore.upsert({
      intentionId: intention.id,
      objective: intention.desiredState,
      targetProjectRoot: projectDir,
      sessionKey: "agent:main:feishu:direct:user",
      phase: "implementing",
      acceptanceCriteria: intention.evidenceNeeded,
      observedFiles: ["src/app.ts"],
      modifiedFiles: ["src/app.ts"],
      verificationCommands: [],
      failedTools: [],
    });
    const intentionStore = new IntentionStore(path.join(dir, "intentions.json"));
    await intentionStore.add(buildUserDirectiveIntention("请分析另一个项目", "other-directive"));

    const restartedService = new ThoughtService({ storePath: egoPath, cognitionMode: "primary" });
    const thought = {
      id: "handoff-continuation",
      type: "self-improvement-monitor",
      content: "Continue the current verified project work",
      trigger: "opportunity",
      source: "system-monitor",
      triggerDetail: "durable handoff",
      motivation: "Continue the user's project task",
      targetMetrics: [],
      priority: 90,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      executed: false,
      relatedNeeds: [],
      actionType: "observe-and-improve",
      cognitiveKind: "task-continuation",
    } as any;
    const internals = restartedService as unknown as {
      attachIntentionToOperationalWork(item: any): Promise<void>;
    };
    await internals.attachIntentionToOperationalWork(thought);
    assert.equal(thought.actionParams.intentionId, intention.id);
    assert.equal(thought.actionParams.workHandoffId, handoff.id);
    assert.equal(thought.actionParams.projectRoot, projectDir);
    assert.equal(thought.actionParams.priorWorkPhase, "implementing");
    assert.match(thought.actionParams.acceptanceCriteria.join(" "), /concrete changed files/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("a handoff whose local project disappeared is not restored", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-stale-handoff-"));
  try {
    const project = path.join(dir, "ephemeral-project");
    await fs.promises.mkdir(project, { recursive: true });
    const store = new WorkHandoffStore(path.join(dir, "work-handoffs.json"));
    await store.upsert({
      intentionId: "intent-stale",
      objective: "fix the ephemeral project",
      targetProjectRoot: project,
      phase: "implementing",
      acceptanceCriteria: ["concrete changed files"],
      observedFiles: [],
      modifiedFiles: [],
      verificationCommands: [],
      failedTools: [],
    });
    await fs.promises.rm(project, { recursive: true, force: true });
    assert.equal(await store.latestForIntention("intent-stale"), undefined);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("ExpressionStore separates proposal creation from sent/withheld resolution", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-expressions-"));
  const store = new ExpressionStore(path.join(dir, "expression-proposals.json"));
  const proposal = await store.propose({
    sourceType: "task-result", sourceId: "task-1", content: "Root cause found", reason: "result ready",
  });
  assert.equal(proposal.status, "pending");
  const withheld = await store.resolve(proposal.id, false, "bad-timing");
  assert.equal(withheld?.status, "withheld");
  assert.equal(withheld?.withheldReason, "bad-timing");
});

test("expression feedback keeps observations separate and no-reply neutral", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-expression-feedback-"));
  const store = new ExpressionFeedbackStore(path.join(dir, "feedback.json"), "adaptive");
  const proposal = {
    id: "proposal-1", sourceType: "thought" as const, sourceId: "thought-1",
    content: "The timeout may be caused by long embedding input", reason: "mature thought",
    status: "sent" as const, createdAt: Date.now(), evaluatedAt: Date.now(),
  };
  const noReply = await store.observeNoReply(proposal);
  assert.deepEqual(noReply.observations, ["no-reply-window"]);
  assert.equal(noReply.inference.label, "unclear");
  assert.equal((await store.load()).policy.samples, 0);

  const reply = await store.observeReply(proposal, "这个提醒时机不对，请稍后再说", "reply-1");
  assert.equal(reply.observations.includes("explicit-negative"), true);
  assert.equal(reply.inference.label, "bad-timing");
  const adapted = await store.load();
  assert.equal(adapted.policy.samples, 1);
  assert.equal(adapted.policy.minimumAgeMultiplier > 1, true);
});

test("model semantics upgrade an earlier unknown-language feedback observation", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-expression-multilingual-upgrade-"));
  const store = new ExpressionFeedbackStore(path.join(dir, "feedback.json"), "adaptive");
  const proposal = {
    id: "proposal-ar", sourceType: "thought" as const, sourceId: "thought-ar",
    content: "اقتراح لتحسين الاستقرار", reason: "mature thought",
    status: "sent" as const, createdAt: Date.now(), evaluatedAt: Date.now(),
  };
  const initial = await store.observeReply(proposal, "هذه الرسالة لم تكن مفيدة", "reply-ar");
  assert.equal(initial.inference.label, "unclear");
  const upgraded = await store.observeReply(
    proposal, "هذه الرسالة لم تكن مفيدة", "reply-ar", ["negative-feedback"],
  );
  assert.equal(upgraded.inference.label, "not-useful");
  assert.equal((await store.load()).policy.samples, 1);
});

test("observe expression policy records explicit feedback without adapting thresholds", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-expression-observe-"));
  const store = new ExpressionFeedbackStore(path.join(dir, "feedback.json"), "observe");
  const proposal = {
    id: "proposal-observe", sourceType: "thought" as const, sourceId: "thought-observe",
    content: "The timeout may be caused by long embedding input", reason: "mature thought",
    status: "sent" as const, createdAt: Date.now(), evaluatedAt: Date.now(),
  };
  const event = await store.observeReply(proposal, "这个提醒时机不对，请稍后再说", "reply-observe");
  assert.equal(event.inference.label, "bad-timing");
  const state = await store.load();
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.policy, {
    minimumAgeMultiplier: 1, valueThresholdDelta: 0, interruptionCost: 0.5, samples: 0,
  });
});

test("non-primary cognition falls back to legacy expression policy", () => {
  const service = new ThoughtService({ cognitionMode: "observe", expressionPolicy: "adaptive" });
  const internals = service as unknown as {
    expressionPolicy: string;
    expressionFeedbackStore?: ExpressionFeedbackStore;
  };
  assert.equal(internals.expressionPolicy, "legacy");
  assert.equal(internals.expressionFeedbackStore, undefined);
});

test("feedback inference does not turn an unrelated reply into negative feedback", () => {
  const inferred = inferExpressionFeedback("今天午饭吃什么？", "Embedding timeout may depend on input length");
  assert.deepEqual(inferred.observations, ["reply-unrelated"]);
  assert.equal(inferred.label, "unclear");
  assert.equal(inferNoReplyFeedback().label, "unclear");
});

test("model semantic feedback works for non-Latin languages", () => {
  const negative = inferExpressionFeedback(
    "هذه الرسالة لم تكن مفيدة",
    "تفاصيل التحسين المقترح",
    ["negative-feedback"],
  );
  assert.equal(negative.label, "not-useful");
  assert.ok(negative.observations.includes("explicit-negative"));
  const adopted = inferExpressionFeedback("طبقت الاقتراح", "الاقتراح", ["adopted"]);
  assert.equal(adopted.label, "adopted");
});

test("operational work receives a traceable Intention before task execution", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-task-intention-"));
  const egoPath = path.join(dir, "ego.json");
  const service = new ThoughtService({ storePath: egoPath, cognitionMode: "primary" });
  await service.recordInteractionWithText({
    type: "inbound", text: "请检查部署日志并定位 timeout", messageId: "directive-task-1",
  });
  const thought = {
    id: "operational-1", type: "opportunity-detected", content: "Inspect deployment logs for timeout",
    trigger: "opportunity", source: "system-monitor", triggerDetail: "directive", motivation: "Locate timeout",
    targetMetrics: [], priority: 90, createdAt: Date.now(), expiresAt: Date.now() + 1000,
    executed: false, relatedNeeds: [], actionType: "analyze-problem", cognitiveKind: "task-continuation",
  } as const;
  const internals = service as unknown as { attachIntentionToOperationalWork(item: object): Promise<void> };
  await internals.attachIntentionToOperationalWork(thought);
  const intentionId = (thought as unknown as { actionParams: { intentionId: string } }).actionParams.intentionId;
  const intentions = JSON.parse(await fs.promises.readFile(path.join(dir, "intentions.json"), "utf8"));
  assert.equal(intentions.intentions[0].id, intentionId);
  assert.equal(intentions.intentions[0].origin, "user-directive");
});

test("primary ingestion records an Intention without duplicating the host task or creating a private Thought", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-primary-intention-"));
  const service = new ThoughtService({ storePath: path.join(dir, "ego.json"), cognitionMode: "primary" });
  await service.recordInteractionWithText({
    type: "inbound", text: "请检查部署日志并定位 timeout", messageId: "directive-1",
  });
  await service.recordInteractionWithText({
    type: "inbound", text: "请检查部署日志并定位 timeout", messageId: "directive-1",
  });
  const file = JSON.parse(await fs.promises.readFile(path.join(dir, "intentions.json"), "utf8"));
  assert.equal(file.intentions.length, 1);
  assert.equal(file.intentions[0].origin, "user-directive");
  const ego = await service.getEgoState();
  assert.equal(ego.totalThoughts, 0);
  assert.equal(ego.activeTasks.length, 0);
});
