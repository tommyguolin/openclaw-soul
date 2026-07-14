import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assessOutgoingProactiveMessage, getActionCooldownState, isLocalProjectEvidenceQuery, markActionExecuted } from "../src/action-executor.js";
import { createDefaultEgoState, saveEgoStore } from "../src/ego-store.js";
import { collectKnownLocalEvidenceTargets, detectMaintenanceOpportunities, detectThoughtOpportunities, generateIntelligentThought, getActionForOpportunity, type DetectedThoughtOpportunity } from "../src/intelligent-thought.js";
import { ThoughtService } from "../src/thought-service.js";
import { ThoughtPool } from "../src/thought-pool.js";
import { buildUserLanguageInstruction, supportsLocalMessageTemplate } from "../src/language-context.js";
import type { EgoState, SoulMemory, ThoughtGenerationContext } from "../src/types.js";

function context(inputEgo?: ReturnType<typeof createDefaultEgoState>): ThoughtGenerationContext {
  const ego = inputEgo ?? createDefaultEgoState();
  if (!inputEgo) ego.needs.security.current = 0;
  if (!inputEgo) ego.goals.push({
    id: "self-improve",
    title: "Self Improve",
    description: "Observe logs and improve Soul",
    progress: 0,
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return {
    ego,
    recentInteractions: 0,
    timeSinceLastThought: Infinity,
    timeSinceLastInteraction: Infinity,
    currentHour: 12,
    currentMinute: 0,
    dayOfWeek: 1,
    urgentNeeds: ["security"],
    recentMemories: [],
    activeGoals: ego.goals,
    contextHints: [],
  };
}

test("need gaps and self-maintenance are operational work, not thought opportunities", () => {
  const ctx = context();
  const thoughts = detectThoughtOpportunities(ctx);
  assert.equal(thoughts.some((item) => item.type === "self-improvement-monitor"), false);
  assert.equal(thoughts.some((item) => item.triggerDetail.includes("Security need critically low")), false);

  const maintenance = detectMaintenanceOpportunities(ctx);
  assert(maintenance.some((item) => item.type === "self-improvement-monitor"));
  assert(maintenance.some((item) => item.triggerDetail.includes("Security need critically low")));
});

test("goal progress remains background motivation rather than a thought stimulus", () => {
  const ego = createDefaultEgoState();
  ego.goals.push({
    id: "trust", title: "Build Trust", description: "Build a durable relationship",
    progress: 68, status: "active", createdAt: Date.now(), updatedAt: Date.now(),
  });
  const thoughts = detectThoughtOpportunities(context(ego));
  assert.equal(thoughts.some((item) => item.triggerDetail.includes("Build Trust")), false);
  assert.equal(thoughts.some((item) => item.triggerDetail.includes("68%")), false);
});

test("LLM lane budgets reserve capacity for actions and critical memory extraction", () => {
  const service = new ThoughtService();
  type BudgetInternals = {
    reserveLLMCallBudget(lane: "critical" | "action" | "thought" | "shadow"): boolean;
    llmBackoffUntil: number;
  };
  const internals = service as unknown as BudgetInternals;
  for (let index = 0; index < 8; index += 1) {
    assert.equal(internals.reserveLLMCallBudget("thought"), true);
  }
  assert.equal(internals.reserveLLMCallBudget("thought"), false);
  for (let index = 0; index < 10; index += 1) assert.equal(internals.reserveLLMCallBudget("action"), true);
  assert.equal(internals.reserveLLMCallBudget("critical"), true);
  assert.equal(internals.reserveLLMCallBudget("critical"), true);
  assert.equal(internals.llmBackoffUntil, 0);
});

test("low thoughtFrequency raises thought budget for observation runs", () => {
  const service = new ThoughtService({ thoughtFrequency: 0.3 });
  type BudgetInternals = {
    reserveLLMCallBudget(lane: "critical" | "action" | "thought" | "shadow"): boolean;
  };
  const internals = service as unknown as BudgetInternals;
  for (let index = 0; index < 24; index += 1) {
    assert.equal(internals.reserveLLMCallBudget("thought"), true);
  }
  assert.equal(internals.reserveLLMCallBudget("thought"), false);
  for (let index = 0; index < 16; index += 1) assert.equal(internals.reserveLLMCallBudget("action"), true);
  for (let index = 0; index < 8; index += 1) assert.equal(internals.reserveLLMCallBudget("shadow"), true);
  for (let index = 0; index < 12; index += 1) assert.equal(internals.reserveLLMCallBudget("critical"), true);
  assert.equal(internals.reserveLLMCallBudget("critical"), false);
});

test("low thoughtFrequency shortens proactive action cooldowns for observation runs", () => {
  markActionExecuted("proactive-content-push");
  const normal = getActionCooldownState("proactive-content-push", 1);
  const observation = getActionCooldownState("proactive-content-push", 0.3);
  assert.equal(normal.cooldownMs, 90 * 60 * 1000);
  assert.equal(observation.cooldownMs, 20 * 60 * 1000);
});

test("low thoughtFrequency startup greeting uses observation-mode cooldown", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-startup-greeting-"));
  try {
    const storePath = path.join(directory, "ego.json");
    const sent: string[] = [];
    const service = new ThoughtService({
      storePath,
      thoughtFrequency: 0.3,
      proactiveChannel: "feishu",
      proactiveTarget: "ou_test",
      sendMessage: async ({ content }) => { sent.push(content); },
    });
    const ego = await service.getEgoState();
    ego.userLanguage = "zh-CN";
    ego.lastInteractionTime = Date.now() - 45 * 60 * 1000;
    ego.lastStartupGreetingAt = Date.now() - 45 * 60 * 1000;
    type StartupInternals = { sendStartupGreeting(ego: EgoState): Promise<void> };
    await (service as unknown as StartupInternals).sendStartupGreeting(ego);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /测试观察模式/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("startup greeting hides Soul's internal default goals", () => {
  const service = new ThoughtService();
  const ego = createDefaultEgoState();
  type StartupInternals = {
    buildStartupFocusLine(ego: EgoState, lang: "zh" | "en"): string;
  };
  const internals = service as unknown as StartupInternals;

  assert.equal(internals.buildStartupFocusLine(ego, "zh"), "");

  ego.goals.push({
    id: "goal-user-project",
    title: "完成 Soul 项目优化",
    description: "改善念头机制",
    progress: 0.2,
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now() + 1,
  });
  assert.match(internals.buildStartupFocusLine(ego, "zh"), /完成 Soul 项目优化/);
});

test("active inbound conversation defers the Soul background cycle for five minutes", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-conversation-quiet-"));
  try {
    const storePath = path.join(directory, "ego.json");
    const service = new ThoughtService({ storePath });
    await service.recordInteractionWithText({
      type: "inbound",
      text: "Please inspect this project while we are actively talking.",
      messageId: "quiet-1",
      channel: "feishu",
    });
    type QuietInternals = { activeConversationQuietRemainingMs(now?: number): Promise<number> };
    const remaining = await (service as unknown as QuietInternals).activeConversationQuietRemainingMs();
    assert(remaining > 4 * 60 * 1000);
    assert(remaining <= 5 * 60 * 1000);

    const ego = await service.getEgoState();
    const inbound = ego.memories.find((memory) => memory.sourceMessageId === "quiet-1");
    assert(inbound);
    const afterWindow = inbound.timestamp + 5 * 60 * 1000 + 1;
    assert.equal(
      await (service as unknown as QuietInternals).activeConversationQuietRemainingMs(afterWindow),
      0,
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("a successfully delivered proactive message records outbound memory directly", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-proactive-outbound-"));
  try {
    const storePath = path.join(directory, "ego.json");
    const service = new ThoughtService({
      storePath,
      proactiveChannel: "feishu",
      proactiveTarget: "ou_test",
      sendMessage: async () => undefined,
    });
    type SenderInternals = { sendMessage?: (params: { to: string; content: string; channel: string }) => Promise<void> };
    await (service as unknown as SenderInternals).sendMessage?.({
      to: "ou_test",
      channel: "feishu",
      content: "A grounded proactive update was delivered.",
    });
    const ego = await service.getEgoState();
    const outbound = ego.memories.filter((memory) => memory.tags.includes("outbound"));
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].content, "A grounded proactive update was delivered.");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("a repeated non-execution opportunity is suppressed without blocking execution work", () => {
  const service = new ThoughtService();
  const repeated = {
    type: "memory-resurface", trigger: "memory", triggerDetail: "the same stale learning",
    priority: 25, source: "memory-recall", relatedNeeds: [], motivation: "repeat",
  } as const;
  const execution = {
    type: "conversation-replay", trigger: "memory", triggerDetail: "latest explicit task",
    priority: 90, source: "user-interaction", relatedNeeds: [], motivation: "act",
    suggestedAction: "analyze-problem",
  } as const;
  type SuppressionInternals = {
    suppressRepeatedOpportunity(opportunity: any): void;
    filterSuppressedOpportunities(opportunities: any[]): any[];
  };
  const internals = service as unknown as SuppressionInternals;
  internals.suppressRepeatedOpportunity(repeated);
  const remaining = internals.filterSuppressedOpportunities([repeated, execution]);
  assert.deepEqual(remaining, [execution]);
});

test("generic opportunity families receive longer cooldowns", () => {
  const service = new ThoughtService();
  const firstBond = {
    type: "bond-deepen", trigger: "bonding", triggerDetail: "idle for three hours",
    priority: 80, source: "environmental-change", relatedNeeds: [], motivation: "connect",
  } as const;
  const laterBond = { ...firstBond, triggerDetail: "idle for four hours" };
  type FamilyInternals = {
    suppressOpportunityFamilyAfterSelection(opportunity: any): void;
    filterSuppressedOpportunities(opportunities: any[]): any[];
  };
  const internals = service as unknown as FamilyInternals;
  internals.suppressOpportunityFamilyAfterSelection(firstBond);
  assert.deepEqual(internals.filterSuppressedOpportunities([laterBond]), []);
  const push = {
    type: "opportunity-detected", trigger: "curiosity", triggerDetail: "generic push",
    priority: 73, source: "user-interaction", relatedNeeds: [], motivation: "share",
    suggestedAction: "proactive-content-push",
  } as const;
  internals.suppressOpportunityFamilyAfterSelection(push);
  assert.deepEqual(internals.filterSuppressedOpportunities([{ ...push, triggerDetail: "another generic push" }]), []);
});

test("meaningful bond-deepen absence routes to a gated proactive message", () => {
  const ego = createDefaultEgoState();
  const ctx = context(ego);
  const opportunities = detectThoughtOpportunities({
    ...ctx,
    timeSinceLastInteraction: 45 * 60 * 1000,
    currentHour: 15,
  });
  const bond = opportunities.find((opportunity) => opportunity.type === "bond-deepen");
  assert.equal(bond?.suggestedAction, "send-message");
  assert.equal(bond && getActionForOpportunity(bond, ego).actionType, "send-message");
});

test("proactive quality gate rejects permission-seeking menu questions", () => {
  assert.deepEqual(
    assessOutgoingProactiveMessage("你想先查看 ETH 回测结果，还是直接定位某个脚本进行部署？"),
    { ok: false, reason: "permission-menu-question" },
  );
  assert.deepEqual(
    assessOutgoingProactiveMessage("你更想先核实回测时的手续费与滑点设置，还是先查看服务器 /diskb/btc_1 下的实盘交易日志？"),
    { ok: false, reason: "permission-menu-question" },
  );
  assert.deepEqual(
    assessOutgoingProactiveMessage("我怀疑当前最优回测结果可能没有足够考虑真实手续费与滑点的影响。"),
    { ok: false, reason: "unsupported-local-evidence-speculation" },
  );
  assert.deepEqual(
    assessOutgoingProactiveMessage("V39 的 OOS MaxDD 为 48.2%，比 V38 低 3.1 个百分点。"),
    { ok: true },
  );
});

test("proactive quality gate rejects stale resolved SSH config confirmation", () => {
  assert.deepEqual(
    assessOutgoingProactiveMessage("For 192.168.1.206, can we confirm sshd_config has PermitRootLogin yes and the key is in /root/.ssh/authorized_keys?"),
    { ok: false, reason: "resolved-ssh-config-confirmation" },
  );
});

test("a third consecutive inquiry-like private thought becomes natural silence", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-question-silence-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const service = new ThoughtService({ storePath });
    const ego = await service.getEgoState();
    type Internals = {
      recentCognitiveMoves: string[];
      incubatePrivateThoughtSeed(thought: any, opportunity: any, ego: EgoState): Promise<boolean>;
    };
    const internals = service as unknown as Internals;
    internals.recentCognitiveMoves = ["question", "speculation"];
    const incubated = await internals.incubatePrivateThoughtSeed({
      id: "q3", type: "conversation-replay", content: "我想先确认 V38/V39 的具体 OOS CAGR 和 MaxDrawDown。",
      trigger: "memory", source: "memory-recall", triggerDetail: "versions", motivation: "uncertainty",
      targetMetrics: [], priority: 60, createdAt: Date.now(), expiresAt: Date.now() + 1000,
      executed: false, relatedNeeds: [], actionType: "none",
    }, undefined, ego);
    assert.equal(incubated, false);
    assert.deepEqual(internals.recentCognitiveMoves, ["question", "speculation", "silence"]);
    assert.equal((await new ThoughtPool(path.join(directory, "thought-pool.json")).load()).candidates.length, 0);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("private stimulus cooldown does not suppress executable search work", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-stimulus-cooldown-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const opportunity = {
      type: "conversation-replay", trigger: "memory", triggerDetail: "SSH access",
      priority: 70, source: "user-interaction", relatedNeeds: [], motivation: "unresolved",
      suggestedAction: "search-web",
    } as const;
    const stimulusKey = "conversation-replay|user-interaction|memory|search-web|ssh access";
    await new ThoughtPool(path.join(directory, "thought-pool.json")).addCandidate({
      content: "Could SSH access still be unresolved?", stimulusKey,
      sourceMemoryIds: ["m1"], sourceClusters: ["operations"],
      cognitiveMove: "question", qualityFlags: [],
      scores: { novelty: 0.8, coherence: 0.9, resonance: 0.7, userRelevance: 0.8 },
    });
    const service = new ThoughtService({ storePath, thoughtFrequency: 0.3 });
    type CooldownInternals = {
      initializeThoughtPool(): Promise<void>;
      filterSuppressedOpportunities(opportunities: readonly any[]): any[];
    };
    const internals = service as unknown as CooldownInternals;
    await internals.initializeThoughtPool();
    assert.deepEqual(internals.filterSuppressedOpportunities([opportunity]), [opportunity]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("shadow emergence only writes Thought Pool and never executes or increments thoughts", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-shadow-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const service = new ThoughtService({ storePath, shadowThoughtRate: 1 });
    await service.recordInteractionWithText({ type: "inbound", text: "A hidden dialog retained stale state." });
    await service.recordInteractionWithText({ type: "inbound", text: "An API reconnect changed the visible order state." });
    let actionCalls = 0;
    type ShadowInternals = {
      shadowLLMGenerator?: (prompt: string) => Promise<string>;
      maybeGenerateShadowThought(): Promise<void>;
      executeThoughtAction(): Promise<void>;
    };
    const internals = service as unknown as ShadowInternals;
    internals.shadowLLMGenerator = async () => "Hidden state and observed state may diverge after reconnection.";
    internals.executeThoughtAction = async () => { actionCalls += 1; };
    await internals.maybeGenerateShadowThought();

    const ego = await service.getEgoState();
    const pool = JSON.parse(await fs.promises.readFile(path.join(directory, "thought-pool.json"), "utf8")) as {
      candidates: Array<{ shadow: boolean; state: string }>;
    };
    assert.equal(ego.totalThoughts, 0);
    assert.equal(actionCalls, 0);
    assert.equal(pool.candidates.length, 1);
    assert.equal(pool.candidates[0].shadow, true);
    assert.equal(pool.candidates[0].state, "new");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("semantic intent classification supports languages without keyword tables", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-semantics-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const service = new ThoughtService({ storePath, cognitionMode: "primary" });
    const german = "Bitte untersuche den Verbindungsabbruch und führe anschließend die Prüfung erneut aus.";
    await service.recordInteractionWithText({ type: "inbound", text: german, messageId: "de-1" });
    type SemanticInternals = { llmGenerator?: (prompt: string) => Promise<string> };
    (service as unknown as SemanticInternals).llmGenerator = async () =>
      '{"facts":[],"semanticSignals":["problem","execution-directive","topic-shift"],"topicTags":["connection reliability","integration test"],"languageCode":"de"}';
    await service.extractUserFacts(german, "de-1");
    const signals = ["problem", "execution-directive", "topic-shift"];
    const ego = await service.getEgoState();
    assert.deepEqual(ego.memories.at(-1)?.semanticSignals, signals);
    assert(ego.memories.at(-1)?.tags.includes("topic:connection-reliability"));
    assert.equal(ego.userLanguage, "de");
    const intentions = JSON.parse(await fs.promises.readFile(path.join(directory, "intentions.json"), "utf8"));
    assert.equal(intentions.intentions.length, 1);
    assert.equal(intentions.intentions[0].desiredState, german);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("language context follows arbitrary model language codes without translation tables", () => {
  const ego = createDefaultEgoState();
  ego.userLanguage = "ar";
  ego.recentUserMessages = ["أفضل الردود المختصرة والمباشرة"];
  assert.equal(supportsLocalMessageTemplate(ego), null);
  const instruction = buildUserLanguageInstruction(ego);
  assert.match(instruction, /BCP-47 ar/);
  assert.doesNotMatch(instruction, /otherwise English/);
});

test("multilingual preference direction is model-structured rather than keyword-matched", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-preference-direction-"));
  try {
    const service = new ThoughtService({ storePath: path.join(directory, "ego.json") });
    type SemanticInternals = { llmGenerator?: (prompt: string) => Promise<string> };
    (service as unknown as SemanticInternals).llmGenerator = async () => JSON.stringify([{
      aspect: "topic_preference",
      preference: "لا أريد المزيد من رسائل التسويق",
      direction: "avoid",
      confidence: 0.95,
      source: "explicit",
    }]);
    const result = await service.extractUserPreferences("لا أريد المزيد من رسائل التسويق");
    assert.equal(result.preferences[0]?.direction, "avoid");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("conversation replay follows the latest semantic turn instead of reviving an older question", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 10 * 60 * 1000;
  ego.memories = [
    {
      id: "old-question", type: "interaction", content: "Kannst du das frühere Kontingent erklären",
      emotion: 0, valence: "neutral", importance: 0.7, timestamp: now - 30 * 60 * 1000,
      tags: ["conversation", "inbound"], semanticSignals: ["question"],
    },
    {
      id: "new-direction", type: "interaction", content: "Analysiere jetzt bitte ausschließlich die Handelsstrategie",
      emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 10 * 60 * 1000,
      tags: ["conversation", "inbound"], semanticSignals: ["execution-directive", "topic-shift"],
    },
  ];
  const opportunities = detectThoughtOpportunities(context(ego));
  assert.equal(opportunities.some((item) => item.triggerDetail.includes("frühere Kontingent")), false);
  assert(opportunities.some((item) => item.triggerDetail.includes("Handelsstrategie")));
});

test("structured semantics route a non-English code-change directive to the agent", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 10 * 60 * 1000;
  ego.memories = [{
    id: "arabic-code-change", type: "interaction",
    content: "حدّث المكوّن وأصلح الخلل ثم تحقق من النتيجة",
    emotion: 0, valence: "neutral", importance: 0.9, timestamp: now - 10 * 60 * 1000,
    tags: ["conversation", "inbound"],
    semanticSignals: ["execution-directive", "code-change", "verification"],
  }];
  const opportunities = detectThoughtOpportunities(context(ego));
  const replay = opportunities.find((item) => item.triggerDetail.includes("حدّث المكوّن"));
  assert.equal(replay?.suggestedAction, "run-agent-task");
});

test("local backtest result questions route to local analysis instead of search-web", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 10 * 60 * 1000;
  ego.memories = [{
    id: "backtest-question", type: "interaction",
    content: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 10 * 60 * 1000,
    tags: ["conversation", "inbound"], semanticSignals: ["question"],
  }];
  const opportunities = detectThoughtOpportunities(context(ego));
  const replay = opportunities.find((item) =>
    item.type === "conversation-replay" && item.actionParams?.requiresLocalEvidence === true);
  assert.equal(replay?.suggestedAction, "analyze-problem");
  assert.equal(replay?.actionParams?.requiresLocalEvidence, true);
});

test("local evidence questions reuse known target context instead of creating a missing-target block", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 10 * 60 * 1000;
  ego.mentalContext.backgroundConcerns = [
    "192.168.1.206",
    "/diskb/btc_1",
    "SSH key access to 192.168.1.206 is confirmed working; the remote /diskb/btc_1 logs have been accessed successfully.",
  ];
  ego.memories = [{
    id: "backtest-question", type: "interaction",
    content: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 10 * 60 * 1000,
    tags: ["conversation", "inbound"], semanticSignals: ["question"],
  }, {
    id: "remote-context", type: "interaction",
    content: "观察一下192.168.1.206上ETH实盘交易有没有成功过？在/diskb/btc_1目录下。",
    emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 60 * 60 * 1000,
    tags: ["conversation", "inbound"], semanticSignals: ["execution-directive"],
  }];

  const targets = collectKnownLocalEvidenceTargets(ego, ego.memories[0].content);
  assert(targets.includes("192.168.1.206"));
  assert(targets.includes("/diskb/btc_1"));

  const opportunities = detectThoughtOpportunities(context(ego));
  const replay = opportunities.find((item) =>
    item.type === "conversation-replay" && item.triggerDetail.includes("回测"));
  assert.equal(replay?.suggestedAction, "analyze-problem");
  assert.deepEqual(replay?.actionParams?.localEvidenceTargets, targets);
});

test("local evidence questions are not replayed after an internal missing-target result", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 10 * 60 * 1000;
  const question = "现在最优的回测结果是哪一个？收益和回撤分别是多少？";
  ego.memories = [{
    id: "backtest-question", type: "interaction",
    content: question,
    emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 10 * 60 * 1000,
    tags: ["conversation", "inbound"], semanticSignals: ["question"],
  }];
  ego.activeTasks.push({
    id: "missing-local-evidence",
    title: `User asked about "${question}" — inspect local logs/files instead of relying on model memory`,
    description: question,
    status: "completed",
    createdAt: now - 5 * 60 * 1000,
    updatedAt: now - 5 * 60 * 1000,
    completedAt: now - 5 * 60 * 1000,
    sourceThoughtId: "thought-1",
    steps: [],
    requiresWritePermission: false,
    resultDelivered: true,
    result: [
      "Status: blocked",
      "Reason: local-evidence-target-missing",
      `Context: ${question}`,
    ].join("\n"),
  });

  const opportunities = detectThoughtOpportunities(context(ego));
  assert.equal(opportunities.some((item) =>
    item.type === "conversation-replay" &&
    item.suggestedAction === "analyze-problem" &&
    item.triggerDetail.includes("回测")), false);
});

test("proactive content push pauses while a recent local-evidence miss is unresolved", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 30 * 60 * 1000;
  ego.userFacts.push({
    id: "interest",
    category: "interest",
    content: "Crypto trading strategy analysis and optimization",
    confidence: 0.9,
    source: "explicit",
    firstMentionedAt: now - 60 * 60 * 1000,
    updatedAt: now - 60 * 60 * 1000,
    timesConfirmed: 1,
  });
  ego.memories = [{
    id: "old-topic", type: "interaction",
    content: "继续研究 ETH 交易策略",
    emotion: 0, valence: "neutral", importance: 0.7, timestamp: now - 30 * 60 * 1000,
    tags: ["conversation", "inbound"], semanticSignals: ["execution-directive"],
  }];
  ego.activeTasks.push({
    id: "missing-local-evidence",
    title: "User asked about local backtest results",
    description: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    status: "completed",
    createdAt: now - 20 * 60 * 1000,
    updatedAt: now - 20 * 60 * 1000,
    completedAt: now - 20 * 60 * 1000,
    sourceThoughtId: "thought-1",
    steps: [],
    requiresWritePermission: false,
    resultDelivered: true,
    result: "Status: blocked\nReason: local-evidence-target-missing",
  });

  const opportunities = detectThoughtOpportunities(context(ego));
  assert.equal(opportunities.some((item) => item.suggestedAction === "proactive-content-push"), false);
});

test("local-evidence missing state suppresses relationship and generic learning nudges", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 45 * 60 * 1000;
  ego.userFacts.push({
    id: "interest",
    category: "interest",
    content: "Crypto trading strategy analysis and optimization",
    confidence: 0.9,
    source: "explicit",
    firstMentionedAt: now - 60 * 60 * 1000,
    updatedAt: now - 60 * 60 * 1000,
    timesConfirmed: 1,
  });
  ego.memories = [{
    id: "backtest-question", type: "interaction",
    content: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 50 * 60 * 1000,
    tags: ["conversation", "inbound", "topic:trading-backtesting"], semanticSignals: ["question"],
  }];
  ego.activeTasks.push({
    id: "missing-local-evidence",
    title: "User asked about local backtest results",
    description: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    status: "completed",
    createdAt: now - 20 * 60 * 1000,
    updatedAt: now - 20 * 60 * 1000,
    completedAt: now - 20 * 60 * 1000,
    sourceThoughtId: "thought-1",
    steps: [],
    requiresWritePermission: false,
    resultDelivered: true,
    result: "Status: blocked\nReason: local-evidence-target-missing",
  });

  const opportunities = detectThoughtOpportunities(context(ego));
  assert.equal(opportunities.some((item) => item.type === "bond-deepen"), false);
  assert.equal(opportunities.some((item) => item.suggestedAction === "learn-topic"), false);
  assert.equal(opportunities.some((item) => item.suggestedAction === "send-message"), false);
});

test("local-evidence missing block persists until a newer inbound turn", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 3 * 60 * 60 * 1000;
  ego.userFacts.push({
    id: "interest",
    category: "interest",
    content: "Crypto trading strategy analysis and optimization",
    confidence: 0.9,
    source: "explicit",
    firstMentionedAt: now - 24 * 60 * 60 * 1000,
    updatedAt: now - 24 * 60 * 60 * 1000,
    timesConfirmed: 1,
  });
  ego.memories = [{
    id: "original-question", type: "interaction",
    content: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 4 * 60 * 60 * 1000,
    tags: ["conversation", "inbound", "topic:trading-backtesting"], semanticSignals: ["question"],
  }];
  ego.activeTasks.push({
    id: "old-missing-local-evidence",
    title: "User asked about local backtest results",
    description: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    status: "completed",
    createdAt: now - 3 * 60 * 60 * 1000,
    updatedAt: now - 3 * 60 * 60 * 1000,
    completedAt: now - 3 * 60 * 60 * 1000,
    sourceThoughtId: "thought-1",
    steps: [],
    requiresWritePermission: false,
    resultDelivered: true,
    result: "Status: blocked\nReason: local-evidence-target-missing",
  });

  const blocked = detectThoughtOpportunities(context(ego));
  assert.equal(blocked.some((item) => item.type === "bond-deepen"), false);
  assert.equal(blocked.some((item) => item.suggestedAction === "proactive-content-push"), false);
  assert.equal(blocked.some((item) => item.suggestedAction === "learn-topic"), false);

  ego.memories.push({
    id: "new-user-turn", type: "interaction",
    content: "先不用管回测了，继续优化 soul。",
    emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 10 * 60 * 1000,
    tags: ["conversation", "inbound"], semanticSignals: ["topic-shift"],
  });
  ego.lastInteractionTime = now - 10 * 60 * 1000;
  const released = detectThoughtOpportunities({
    ...context(ego),
    timeSinceLastInteraction: 45 * 60 * 1000,
  });
  assert(released.some((item) => item.type === "bond-deepen"));
});

test("known local evidence target releases the broad missing-evidence silence", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.lastInteractionTime = now - 45 * 60 * 1000;
  ego.userFacts.push({
    id: "interest",
    category: "interest",
    content: "Crypto trading strategy analysis and optimization",
    confidence: 0.9,
    source: "explicit",
    firstMentionedAt: now - 24 * 60 * 60 * 1000,
    updatedAt: now - 24 * 60 * 60 * 1000,
    timesConfirmed: 1,
  });
  ego.mentalContext.backgroundConcerns = ["192.168.1.206", "/diskb/btc_1"];
  ego.memories = [{
    id: "original-question", type: "interaction",
    content: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 60 * 60 * 1000,
    tags: ["conversation", "inbound", "topic:trading-backtesting"], semanticSignals: ["question"],
  }];
  ego.activeTasks.push({
    id: "missing-local-evidence",
    title: "User asked about local backtest results",
    description: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    status: "completed",
    createdAt: now - 30 * 60 * 1000,
    updatedAt: now - 30 * 60 * 1000,
    completedAt: now - 30 * 60 * 1000,
    sourceThoughtId: "thought-1",
    steps: [],
    requiresWritePermission: false,
    resultDelivered: true,
    result: "Status: blocked\nReason: local-evidence-target-missing",
  });

  const opportunities = detectThoughtOpportunities(context(ego));
  assert(opportunities.some((item) => item.suggestedAction === "proactive-content-push"));
});

test("unsupported local-metric private thoughts become natural silence", async () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.activeTasks.push({
    id: "missing-local-evidence",
    title: "User asked about local backtest results",
    description: "现在最优的回测结果是哪一个？收益和回撤分别是多少？",
    status: "completed",
    createdAt: now - 20 * 60 * 1000,
    updatedAt: now - 20 * 60 * 1000,
    completedAt: now - 20 * 60 * 1000,
    sourceThoughtId: "thought-1",
    steps: [],
    requiresWritePermission: false,
    resultDelivered: true,
    result: "Status: blocked\nReason: local-evidence-target-missing",
  });
  const service = new ThoughtService();
  const internals = service as unknown as {
    incubatePrivateThoughtSeed: (
      thought: {
        content: string;
      },
      opportunity: DetectedThoughtOpportunity | undefined,
      ego: EgoState,
    ) => Promise<boolean>;
  };
  const incubated = await internals.incubatePrivateThoughtSeed({
    content: "想确认一下 V38 与 V39 的 OOS CAGR 和最大回撤差异。",
  }, undefined, ego);
  assert.equal(incubated, false);
});

test("shadow thoughts do not incubate unsupported local evidence questions while blocked", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-shadow-local-evidence-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const now = Date.now();
    const ego = createDefaultEgoState();
    ego.memories = [
      {
        id: "deploy-question",
        type: "interaction",
        content: "本地回测通过后部署到服务器，需要观察 eth_live.log。",
        emotion: 0,
        valence: "neutral",
        importance: 0.8,
        timestamp: now - 10 * 60 * 1000,
        tags: ["conversation", "inbound"],
        semanticSignals: ["execution-directive"],
      },
      {
        id: "deploy-context",
        type: "interaction",
        content: "继续检查部署后的实盘日志和交易数据。",
        emotion: 0,
        valence: "neutral",
        importance: 0.7,
        timestamp: now - 9 * 60 * 1000,
        tags: ["conversation", "inbound"],
        semanticSignals: ["execution-directive"],
      },
    ];
    ego.activeTasks.push({
      id: "missing-local-evidence",
      title: "User asked about local deployment logs",
      description: "部署后检查 eth_live.log 是否异常",
      status: "completed",
      createdAt: now - 8 * 60 * 1000,
      updatedAt: now - 8 * 60 * 1000,
      completedAt: now - 8 * 60 * 1000,
      sourceThoughtId: "thought-1",
      steps: [],
      requiresWritePermission: false,
      resultDelivered: true,
      result: "Status: blocked\nReason: local-evidence-target-missing",
    });
    await saveEgoStore(storePath, { version: 3, ego, createdAt: now, updatedAt: now });

    const service = new ThoughtService({ storePath, shadowThoughtRate: 1 });
    const internals = service as unknown as {
      shadowLLMGenerator: (prompt: string) => Promise<string>;
      lastShadowThoughtAt: number;
      maybeGenerateShadowThought(): Promise<void>;
    };
    internals.shadowLLMGenerator = async () => JSON.stringify({
      thought: "本地回测通过后部署到服务器，是否会出现 eth_live.log 中缺失或异常交易数据？",
      cognitiveMove: "question",
      qualityFlags: [],
    });
    internals.lastShadowThoughtAt = 0;

    await internals.maybeGenerateShadowThought();

    const pool = await new ThoughtPool(path.join(directory, "thought-pool.json")).load();
    assert.equal(pool.candidates.length, 0);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("search-web identifies local project evidence queries before LLM fallback", () => {
  assert.equal(isLocalProjectEvidenceQuery("现在最优的回测结果是哪一个？收益和回撤分别是多少？"), true);
  assert.equal(isLocalProjectEvidenceQuery("TypeScript decorators proposal current status"), false);
});

test("legacy unverified learning cannot resurface as factual thought", () => {
  const ego = createDefaultEgoState();
  ego.goals = [];
  const now = Date.now();
  const memories: SoulMemory[] = Array.from({ length: 3 }, (_, index) => ({
    id: `learning-${index}`, type: "learning" as const, content: `Unsupported model claim ${index}`,
    emotion: 0, valence: "neutral" as const, importance: 0.8, timestamp: now - index * 1000,
    tags: ["learning"],
  }));
  ego.memories = memories;
  assert.equal(detectThoughtOpportunities(context(ego)).some((item) => item.type === "memory-resurface"), false);
  memories.forEach((memory) => { memory.evidenceKind = "web"; });
  assert.equal(detectThoughtOpportunities(context(ego)).some((item) => item.type === "memory-resurface"), true);
});

test("configured LLM failure does not fall back to a mechanical structured thought", async () => {
  const ctx = context(createDefaultEgoState());
  ctx.ego.memories.push({
    id: "stimulus", type: "interaction", content: "What architecture would fit this system?",
    emotion: 0, valence: "neutral", importance: 0.7, timestamp: Date.now() - 10 * 60 * 1000,
    tags: ["conversation", "inbound"], semanticSignals: ["question"],
  });
  const opportunity: DetectedThoughtOpportunity = {
    type: "conversation-replay", trigger: "curiosity", triggerDetail: "a substantive current topic",
    priority: 80, source: "user-interaction", relatedNeeds: ["growth"], motivation: "understand it",
  };
  await assert.rejects(
    generateIntelligentThought(ctx, {
      preferOpportunity: opportunity,
      llmGenerator: async () => { throw new Error("Soul LLM thought lane budget exhausted"); },
    }),
    /thought lane budget exhausted/,
  );
});

test("LLM thought context excludes stale turns outside the current conversation window", async () => {
  const ego = createDefaultEgoState();
  ego.goals = [];
  const now = Date.now();
  ego.memories = [
    {
      id: "stale", type: "interaction", content: "Invent a daily query counter in usage.json",
      emotion: 0, valence: "neutral", importance: 0.5, timestamp: now - 6 * 60 * 60 * 1000,
      tags: ["conversation", "inbound"],
    },
    {
      id: "current", type: "interaction", content: "Können Maschinen von der Stille zwischen Wörtern träumen?",
      emotion: 0, valence: "neutral", importance: 0.8, timestamp: now - 10 * 60 * 1000,
      tags: ["conversation", "inbound"], semanticSignals: ["question"],
    },
  ];
  const ctx = context(ego);
  const opportunity: DetectedThoughtOpportunity = {
    type: "conversation-replay", trigger: "curiosity", triggerDetail: "current philosophical question",
    priority: 80, source: "user-interaction", relatedNeeds: ["growth"], motivation: "reflect",
  };
  let prompt = "";
  await generateIntelligentThought(ctx, {
    preferOpportunity: opportunity,
    llmGenerator: async (value) => { prompt = value; return "Vielleicht liegt der Traum im Zwischenraum."; },
  });
  assert(prompt.includes("Können Maschinen"));
  assert.equal(prompt.includes("usage.json"), false);
});
