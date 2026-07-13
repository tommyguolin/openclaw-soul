import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { calculateAttentionScore, calculateThoughtPoolMetrics, inferEpistemicNature, ThoughtPool } from "../src/thought-pool.js";
import { ThoughtCycleJournal } from "../src/thought-journal.js";
import { ThoughtService } from "../src/thought-service.js";

test("Thought Pool persists private candidates and incubates repeated thoughts", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-thought-pool-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    const first = await pool.addCandidate({
      content: "Hidden state and observed state can drift apart after a disconnect.",
      sourceMemoryIds: ["m1", "m2"],
      sourceClusters: ["software", "interface"],
      cognitiveMove: "analogy",
      qualityFlags: [],
      scores: { novelty: 0.9, coherence: 0.9, resonance: 0.7, userRelevance: 0.6 },
    });
    assert.equal(first.merged, false);
    assert.equal(first.candidate.shadow, true);
    assert.equal(first.candidate.state, "new");

    const second = await pool.addCandidate({
      content: "Hidden state and observed state can drift apart after disconnect.",
      sourceMemoryIds: ["m3"],
      sourceClusters: ["operations"],
      cognitiveMove: "analogy",
      qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.9, resonance: 0.8, userRelevance: 0.5 },
    });
    assert.equal(second.merged, true);
    assert.equal(second.candidate.id, first.candidate.id);
    assert.equal(second.candidate.state, "incubating");
    assert.equal(second.candidate.activations, 2);
    assert.equal(second.candidate.distinctActivationCount, 2);
    assert(second.candidate.sourceMemoryIds.includes("m3"));

    const maturity = second.candidate.maturity;
    const duplicateCause = await pool.addCandidate({
      content: "Hidden state and observed state can drift apart after disconnect.",
      sourceMemoryIds: ["m3"],
      sourceClusters: ["operations"],
      cognitiveMove: "analogy",
      qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.9, resonance: 0.8, userRelevance: 0.5 },
    });
    assert.equal(duplicateCause.candidate.maturity, maturity);
    assert.equal(duplicateCause.candidate.distinctActivationCount, 2);

    const reloaded = await new ThoughtPool(filePath).load();
    assert.equal(reloaded.candidates.length, 1);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("v3.1 classifies epistemic nature and lets a grounded workspace question mature by reactivation", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-thought-pool-v31-question-"));
  try {
    const pool = new ThoughtPool(path.join(directory, "thought-pool.json"));
    const base = {
      content: "Could the timeout boundary be input length rather than retry timing?",
      sourceMemoryIds: ["m1"], sourceClusters: ["software"], cognitiveMove: "question",
      qualityFlags: [], originWorkspaceId: "workspace-1", causalTraceIds: ["memory:m1"],
      scores: { novelty: 0.8, coherence: 0.85, resonance: 0.7, userRelevance: 0.8 },
    };
    const first = await pool.addCandidate({ ...base, stimulusId: "stimulus-1", evidenceMemoryIds: ["m1"] });
    assert.equal(first.candidate.epistemicNature, "question");
    assert.equal(first.candidate.state, "new");
    const second = await pool.addCandidate({
      ...base, sourceMemoryIds: ["m2"], causalTraceIds: ["memory:m2"],
      stimulusId: "stimulus-2", evidenceMemoryIds: ["m2"],
    });
    assert.equal(second.candidate.state, "incubating");
    assert.equal(second.candidate.stimulusIds?.length, 2);
    const eligible = await pool.getAttentionCandidatesV31();
    assert.equal(eligible[0]?.id, first.candidate.id);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("v3.1 keeps claims on the strict grounded evidence path", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-thought-pool-v31-claim-"));
  try {
    const pool = new ThoughtPool(path.join(directory, "thought-pool.json"));
    const base = {
      content: "The embedding service has a fixed token limit.", sourceClusters: ["software"],
      cognitiveMove: "reflection", epistemicNature: "claim" as const, qualityFlags: [],
      originWorkspaceId: "workspace-claim", causalTraceIds: ["memory:m1"],
      scores: { novelty: 0.8, coherence: 0.9, resonance: 0.8, userRelevance: 0.8 },
    };
    await pool.addCandidate({ ...base, sourceMemoryIds: ["m1"], evidenceMemoryIds: ["m1"], stimulusId: "s1" });
    await pool.addCandidate({ ...base, sourceMemoryIds: ["m2"], evidenceMemoryIds: ["m2"], stimulusId: "s2" });
    assert.equal((await pool.getAttentionCandidatesV31()).length, 0);
    const third = await pool.addCandidate({ ...base, sourceMemoryIds: ["m3"], evidenceMemoryIds: ["m3"], stimulusId: "s3" });
    assert.equal(third.candidate.distinctActivationCount, 3);
    assert.equal((await pool.getAttentionCandidatesV31())[0]?.id, third.candidate.id);
    assert.equal((await pool.load()).candidateSchemaVersion, "3.1");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("v3.1 migration marks legacy candidates uncertain without auto-attending them", () => {
  assert.equal(inferEpistemicNature("Why does this remain unresolved?", "question"), "question");
  assert.equal(inferEpistemicNature("These two failures follow the same pattern.", "analogy"), "association");
});

test("same stimulus merges paraphrased seeds without treating unchanged evidence as maturity", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-stimulus-merge-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    const stimulusKey = "conversation-replay|user-interaction|memory|search-web|ssh access to remote directory";
    const first = await pool.addCandidate({
      content: "免密登录是否已经允许我读取远程目录？",
      sourceMemoryIds: ["same-memory"], sourceClusters: ["operations"], stimulusKey,
      cognitiveMove: "question", qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.9, resonance: 0.7, userRelevance: 0.8 },
    });
    const paraphrase = await pool.addCandidate({
      content: "SSH key 配置后能不能直接访问服务器上的路径？",
      sourceMemoryIds: ["same-memory"], sourceClusters: ["operations"], stimulusKey,
      cognitiveMove: "question", qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.9, resonance: 0.7, userRelevance: 0.8 },
    });
    assert.equal(paraphrase.merged, true);
    assert.equal(paraphrase.candidate.id, first.candidate.id);
    assert.equal(paraphrase.candidate.activations, 2);
    assert.equal(paraphrase.candidate.distinctActivationCount, 1);
    assert.equal(paraphrase.candidate.maturity, 0.1);
    assert.equal((await pool.load()).candidates.length, 1);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("clean reactivations recover from an old task-pressure flag", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-quality-recovery-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    const base = {
      stimulusKey: "same lingering question",
      sourceMemoryIds: ["m1"], sourceClusters: ["operations"],
      cognitiveMove: "question",
      scores: { novelty: 0.8, coherence: 0.9, resonance: 0.8, userRelevance: 0.8 },
    };
    await pool.addCandidate({ ...base, content: "I should check whether SSH works.", qualityFlags: ["task-pressure"] });
    await pool.addCandidate({ ...base, content: "Could the SSH failure be a root-login policy?", qualityFlags: [] });
    const recovered = await pool.addCandidate({
      ...base, content: "Perhaps the unresolved part is the server login policy.", qualityFlags: [],
    });
    assert.equal(recovered.candidate.distinctActivationCount, 1);
    assert.equal(recovered.candidate.maturity, 0.1);
    assert.equal(recovered.candidate.cleanActivationStreak, 2);
    assert.equal(recovered.candidate.qualityFlags.includes("task-pressure"), false);
    assert(recovered.candidate.scores.coherence > 0.65);
    assert(recovered.candidate.attentionScore > 0.6);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("an explicit resolution fades related private candidates but preserves unrelated ideas", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-resolution-fade-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    await pool.addCandidate({
      content: "Why is SSH access to 192.168.1.206 still failing?",
      stimulusKey: "ssh access 192.168.1.206 authorized_keys",
      sourceMemoryIds: ["ssh"], sourceClusters: ["operations"], cognitiveMove: "question", qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.9, resonance: 0.8, userRelevance: 0.9 },
    });
    await pool.addCandidate({
      content: "Could trading drawdown reveal a regime change?",
      sourceMemoryIds: ["trade"], sourceClusters: ["trading"], cognitiveMove: "question", qualityFlags: [],
      scores: { novelty: 0.8, coherence: 0.9, resonance: 0.7, userRelevance: 0.8 },
    });
    const faded = await pool.fadeRelatedCandidates(
      "SSH to 192.168.1.206 already connected successfully and authorized_keys works now.",
    );
    assert.equal(faded.length, 1);
    const stored = await pool.load();
    assert.equal(stored.candidates.find((item) => item.sourceMemoryIds.includes("ssh"))?.state, "faded");
    assert.notEqual(stored.candidates.find((item) => item.sourceMemoryIds.includes("trade"))?.state, "faded");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("pattern fade removes stale operational candidates with sparse token overlap", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thought-pool-pattern-fade-"));
  const poolPath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(poolPath);
    await pool.addCandidate({
      content: "也许 SSH 免密登录失败是因为主机把 PermitRootLogin no 写进了 sshd_config。",
      sourceMemoryIds: ["m1"],
      sourceClusters: ["ssh"],
      sourceMemoryTimestamps: [Date.now()],
      cognitiveMove: "speculation",
      qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.7, resonance: 0.7, userRelevance: 0.7 },
    });
    await pool.addCandidate({
      content: "The clientOrderId guard behaves like an idempotency lock.",
      sourceMemoryIds: ["m2"],
      sourceClusters: ["api"],
      sourceMemoryTimestamps: [Date.now()],
      cognitiveMove: "analogy",
      qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.7, resonance: 0.7, userRelevance: 0.7 },
    });

    const faded = await pool.fadeMatchingCandidates(/\bssh\b|PermitRootLogin|authorized_keys/i);
    assert.equal(faded.length, 1);
    const store = await pool.load();
    assert.equal(store.candidates.filter((candidate) => candidate.state !== "faded").length, 1);
    assert.equal(store.candidates.find((candidate) => /clientOrderId/.test(candidate.content))?.state, "new");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("a resolution tombstone blocks the same failed premise from growing back", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-resolution-tombstone-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    await pool.registerResolution({
      topicKey: "ssh-access:192.168.1.206",
      resolutionText: "SSH access to 192.168.1.206 works and /diskb/btc_1 was read successfully.",
      evidenceMemoryIds: ["success"],
    });
    const contradiction = await pool.findContradictingResolution(
      "Maybe SSH to 192.168.1.206 is still failing because authorized_keys is wrong.",
    );
    assert.equal(contradiction?.topicKey, "ssh-access:192.168.1.206");
    const staleRecheck = await pool.findContradictingResolution(
      "Confirm the remote host allowed root login and restarted sshd before reading /diskb/btc_1.",
    );
    assert.equal(staleRecheck?.topicKey, "ssh-access:192.168.1.206");
    assert.equal(await pool.findContradictingResolution("The remote trading log contains a new fill."), undefined);
    const reloaded = await new ThoughtPool(filePath).load();
    assert.equal(reloaded.version, 3);
    assert.equal(reloaded.resolutions.length, 1);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("ungrounded model repetitions do not count as independent activation evidence", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-grounded-activation-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    const base = {
      content: "Could the service still be unavailable?", sourceClusters: ["operations"],
      cognitiveMove: "question", qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.9, resonance: 0.7, userRelevance: 0.8 },
    };
    await pool.addCandidate({ ...base, sourceMemoryIds: ["model-a"], evidenceMemoryIds: [] });
    const repeated = await pool.addCandidate({ ...base, sourceMemoryIds: ["model-b"], evidenceMemoryIds: [] });
    assert.equal(repeated.candidate.distinctActivationCount, 1);
    assert.equal(repeated.candidate.maturity, 0.1);
    const grounded = await pool.addCandidate({
      ...base, sourceMemoryIds: ["user-evidence"], evidenceMemoryIds: ["user-evidence"],
    });
    assert.equal(grounded.candidate.distinctActivationCount, 2);
    assert.equal(grounded.candidate.state, "incubating");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("v3 evidence revalidation demotes legacy maturity built from unrelated memories", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-v3-revalidate-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    for (const id of ["m1", "m2", "m3"]) {
      await pool.addCandidate({
        content: "Could SSH access still be failing?", sourceMemoryIds: [id], sourceClusters: ["operations"],
        cognitiveMove: "question", qualityFlags: [],
        scores: { novelty: 0.7, coherence: 0.9, resonance: 0.7, userRelevance: 0.8 },
      });
    }
    assert.equal((await pool.load()).candidates[0].maturity, 0.4);
    const changed = await pool.revalidateEvidence(new Map([
      ["m1", "The user asked about ETH drawdown."],
      ["m2", "V39 has a different CAGR."],
      ["m3", "A backtest completed."],
    ]));
    const candidate = (await pool.load()).candidates[0];
    assert.equal(changed, 1);
    assert.equal(candidate.distinctActivationCount, 1);
    assert.equal(candidate.maturity, 0.1);
    assert.equal(candidate.state, "new");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("natural silence is measured as a valid observation outcome", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-natural-silence-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    await pool.recordObservation(true);
    await pool.recordObservation(false);
    assert.equal((await pool.load()).metrics.naturalSilenceRate, 0.5);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("an explicit SSH success replaces the obsolete failure fact", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-fact-resolution-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const service = new ThoughtService({ storePath });
    await service.recordInteractionWithText({ type: "inbound", text: "昨天 SSH 已经连上 192.168.1.206，也读取了 /diskb/btc_1 的日志。" });
    const facts = (await service.getEgoState()).userFacts.filter((fact) => fact.category === "ssh-access");
    assert.equal(facts.length, 1);
    assert.match(facts[0].content, /confirmed working/);
    assert.equal(facts[0].confidence, 0.99);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("ThoughtService rejects a newly generated premise after the topic was resolved", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-service-resolution-gate-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const service = new ThoughtService({ storePath });
    await service.recordInteractionWithText({
      type: "inbound", text: "SSH 已经连接成功 192.168.1.206，也可以访问 /diskb/btc_1。",
    });
    const ego = await service.getEgoState();
    type Internals = { incubatePrivateThoughtSeed(thought: any, opportunity: any, ego: any): Promise<void> };
    await (service as unknown as Internals).incubatePrivateThoughtSeed({
      id: "new-false-premise", type: "conversation-replay", content: "也许 SSH 到 192.168.1.206 仍然连不上。",
      trigger: "memory", source: "memory-recall", triggerDetail: "ssh", motivation: "uncertain",
      targetMetrics: [], priority: 70, createdAt: Date.now(), expiresAt: Date.now() + 1000,
      executed: false, relatedNeeds: [], actionType: "none",
    }, undefined, ego);
    assert.equal((await new ThoughtPool(path.join(directory, "thought-pool.json")).load()).candidates.length, 0);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("inbound conversation updates foreground and resolution clears matching residue", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-mental-context-"));
  const storePath = path.join(directory, "ego.json");
  try {
    const service = new ThoughtService({ storePath });
    await service.recordInteractionWithText({ type: "inbound", text: "SSH 连接现在有问题，正在排查 authorized_keys。" });
    const before = await service.getEgoState();
    assert(before.mentalContext.foreground.length > 0);
    await service.recordInteractionWithText({ type: "inbound", text: "SSH 已经修复好了，连接成功。" });
    const after = await service.getEgoState();
    assert.equal(after.mentalContext.residue.some((item) => /ssh/i.test(item)), false);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("metrics expose lifecycle, cognition, quality, association, and source-age signals", () => {
  const now = Date.now();
  const metrics = calculateThoughtPoolMetrics([{
    id: "candidate", content: "A question", sourceMemoryIds: ["a", "b"],
    sourceClusters: ["software", "relationship"], sourceMemoryTimestamps: [now - 10 * 86_400_000], stimulusKeys: [],
    activationHistory: [
      { fingerprint: "a|software", sourceMemoryIds: ["a"], sourceClusters: ["software"], activatedAt: now },
      { fingerprint: "b|relationship", sourceMemoryIds: ["b"], sourceClusters: ["relationship"], activatedAt: now },
      { fingerprint: "c|other", sourceMemoryIds: ["c"], sourceClusters: ["other"], activatedAt: now },
    ],
    distinctActivationCount: 3, cognitiveMove: "question", qualityFlags: [], cleanActivationStreak: 1,
    scores: { novelty: 0.9, coherence: 0.8, resonance: 0.7, userRelevance: 0.6 },
    attentionScore: 0.75, maturity: 0.4, activations: 3, state: "incubating",
    createdAt: now, updatedAt: now, lastActivatedAt: now, shadow: true,
  }], now);
  assert.equal(metrics.totalActivations, 3);
  assert.equal(metrics.maturityRate, 1);
  assert.equal(metrics.crossTopicAssociationRate, 1);
  assert.equal(metrics.sourceMemoryDiversityRate, 1);
  assert.equal(metrics.usefulSurpriseRate, 1);
  assert.equal(metrics.nonsenseRate, 0);
  assert.equal(metrics.contextContinuityRate, 0);
  assert.equal(metrics.thoughtSpecificityRate, 0);
  assert.equal(metrics.unsupportedUncertaintyRate, 0);
  assert.equal(metrics.cognitiveMoveDistribution.question, 1);
  assert.equal(metrics.meanSourceMemoryAgeDays, 10);
  assert.equal(metrics.sourceMemoryAgeBuckets.sevenTo30d, 1);
});

test("version 1 Thought Pool snapshots migrate activation history without losing candidates", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-pool-v1-"));
  const filePath = path.join(directory, "thought-pool.json");
  const now = Date.now();
  await fs.promises.writeFile(filePath, JSON.stringify({
    version: 1, updatedAt: now, candidates: [{
      id: "legacy", content: "A legacy private thought", sourceMemoryIds: ["m1", "m2"],
      sourceClusters: ["a", "b"], cognitiveMove: "reflection", qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.8, resonance: 0.6, userRelevance: 0.5 },
      attentionScore: 0.65, maturity: 0.1, activations: 1, state: "new",
      createdAt: now, updatedAt: now, lastActivatedAt: now, shadow: true,
    }],
  }));
  try {
    const loaded = await new ThoughtPool(filePath).load();
    assert.equal(loaded.version, 3);
    assert.equal(loaded.candidates[0].activationHistory.length, 1);
    assert.equal(loaded.candidates[0].distinctActivationCount, 1);
    assert.equal(loaded.metrics.candidates, 1);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("Thought Pool initialization persists migrated version 2 snapshot", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-pool-init-"));
  const filePath = path.join(directory, "thought-pool.json");
  const now = Date.now();
  await fs.promises.writeFile(filePath, JSON.stringify({
    version: 1, updatedAt: now, candidates: [{
      id: "legacy", content: "A legacy private thought", sourceMemoryIds: ["m1", "m2"],
      sourceClusters: ["a", "b"], cognitiveMove: "reflection", qualityFlags: [],
      scores: { novelty: 0.7, coherence: 0.8, resonance: 0.6, userRelevance: 0.5 },
      attentionScore: 0.65, maturity: 0.1, activations: 1, state: "new",
      createdAt: now, updatedAt: now, lastActivatedAt: now, shadow: true,
    }],
  }));
  try {
    const initialized = await new ThoughtPool(filePath).initialize();
    const stored = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as {
      version: number;
      metrics?: { candidates: number };
      candidates: Array<{ distinctActivationCount?: number; activationHistory?: unknown[] }>;
    };
    assert.equal(initialized.version, 3);
    assert.equal(stored.version, 3);
    assert.equal(stored.metrics?.candidates, 1);
    assert.equal(stored.candidates[0].distinctActivationCount, 1);
    assert.equal(stored.candidates[0].activationHistory?.length, 1);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("Attention Gate journals a mature candidate privately without handler, message, or action", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-attention-gate-"));
  const storePath = path.join(directory, "ego.json");
  let handlerCalls = 0;
  let sends = 0;
  let actions = 0;
  try {
    const service = new ThoughtService({
      storePath,
      onThought: async (thought) => { handlerCalls += 1; return { thought, success: true, metricsChanged: [] }; },
      sendMessage: async () => { sends += 1; },
    });
    const pool = new ThoughtPool(path.join(directory, "thought-pool.json"));
    for (const source of ["m1", "m2", "m3"]) {
      await pool.addCandidate({
        content: "Hidden state and observed state may share the same invisible boundary.",
        sourceMemoryIds: [source], sourceClusters: [`cluster-${source}`],
        sourceMemoryTimestamps: [Date.now() - 5 * 86_400_000],
        cognitiveMove: "analogy", qualityFlags: [],
        scores: { novelty: 0.9, coherence: 0.9, resonance: 0.8, userRelevance: 0.7 },
      });
    }
    type AttentionInternals = {
      maybeAttendThoughtPoolCandidate(): Promise<void>;
      executeThoughtAction(...args: unknown[]): Promise<void>;
    };
    const internals = service as unknown as AttentionInternals;
    internals.executeThoughtAction = async () => { actions += 1; };
    await internals.maybeAttendThoughtPoolCandidate();
    const ego = await service.getEgoState();
    const stored = await pool.load();
    const journal = await new ThoughtCycleJournal(path.join(directory, "thought-cycles.jsonl")).loadRecent(5);
    assert.equal(stored.candidates[0].state, "attended");
    assert.equal(ego.totalThoughts, 1);
    assert.equal(handlerCalls, 0);
    assert.equal(sends, 0);
    assert.equal(actions, 0);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].thought?.actionType, "none");
    assert(journal[0].selectedOpportunity?.triggerDetail.startsWith("Thought Pool attention:"));

    for (const source of ["q1", "q2", "q3"]) {
      await pool.addCandidate({
        content: "A distant clock and a silent ocean may obey the same hidden rhythm.",
        sourceMemoryIds: [source], sourceClusters: [`cluster-${source}`],
        cognitiveMove: "analogy", qualityFlags: [],
        scores: { novelty: 0.9, coherence: 0.9, resonance: 0.8, userRelevance: 0.7 },
      });
    }
    const restarted = new ThoughtService({ storePath });
    type RestartInternals = {
      restoreDiversityState(ego: Awaited<ReturnType<ThoughtService["getEgoState"]>>): Promise<void>;
      maybeAttendThoughtPoolCandidate(): Promise<void>;
    };
    const restartInternals = restarted as unknown as RestartInternals;
    await restartInternals.restoreDiversityState(await restarted.getEgoState());
    await restartInternals.maybeAttendThoughtPoolCandidate();
    const afterRestart = await pool.load();
    assert.equal(afterRestart.candidates.filter((candidate) => candidate.state === "attended").length, 1);
    assert.equal((await restarted.getEgoState()).totalThoughts, 1);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("attention scoring penalizes task pressure and experimental framing", () => {
  const scores = { novelty: 0.9, coherence: 0.9, resonance: 0.8, userRelevance: 0.7 };
  const clean = calculateAttentionScore(scores, 0.5, []);
  const leaked = calculateAttentionScore(scores, 0.5, ["meta-framing", "task-pressure"]);
  const forced = calculateAttentionScore(scores, 0.5, ["forced-association"]);
  assert(clean > leaked);
  assert(clean > forced);
  assert(leaked < 0.65);
  assert(forced < 0.65);
});

test("legacy forced-association candidates are reclassified on load", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-forced-association-reclassify-"));
  const filePath = path.join(directory, "thought-pool.json");
  const now = Date.now();
  try {
    await fs.promises.writeFile(filePath, JSON.stringify({
      version: 3,
      updatedAt: now,
      candidates: [{
        id: "forced",
        content: "The clientOrderId guard reminds me of a lock; the five-question cap feels like a separate quota wall. Both signal that systems demand a unique token.",
        sourceMemoryIds: ["m1"],
        sourceClusters: ["api", "quota"],
        sourceMemoryTimestamps: [now],
        stimulusKeys: [],
        activationHistory: [{ fingerprint: "ungrounded", sourceMemoryIds: ["m1"], sourceClusters: ["api"], activatedAt: now }],
        distinctActivationCount: 1,
        cognitiveMove: "analogy",
        qualityFlags: [],
        cleanActivationStreak: 1,
        scores: { novelty: 0.9, coherence: 0.9, resonance: 0.8, userRelevance: 0.7 },
        attentionScore: 0.8,
        maturity: 0.5,
        activations: 1,
        state: "new",
        createdAt: now,
        updatedAt: now,
        lastActivatedAt: now,
        shadow: true,
      }],
    }));
    const loaded = await new ThoughtPool(filePath).load();
    assert(loaded.candidates[0].qualityFlags.includes("forced-association"));
    assert(loaded.candidates[0].attentionScore < 0.65);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("low-quality singleton candidates fade before becoming mental noise", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-low-quality-singleton-fade-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    await pool.addCandidate({
      content: "Both signal a vague connection between unrelated counters.",
      sourceMemoryIds: ["m1"],
      sourceClusters: ["quota"],
      cognitiveMove: "analogy",
      qualityFlags: ["forced-association"],
      scores: { novelty: 0.8, coherence: 0.7, resonance: 0.7, userRelevance: 0.6 },
    });
    for (const source of ["m2", "m3"]) {
      await pool.addCandidate({
        content: "A concrete recurring timeout may be tied to connection reuse.",
        sourceMemoryIds: [source],
        sourceClusters: ["operations"],
        cognitiveMove: "question",
        qualityFlags: ["meta-framing"],
        scores: { novelty: 0.8, coherence: 0.8, resonance: 0.7, userRelevance: 0.7 },
      });
    }

    const faded = await pool.fadeLowQualitySingletons();
    const store = await pool.load();
    assert.equal(faded.length, 1);
    assert.equal(store.candidates.find((candidate) => /vague connection/.test(candidate.content))?.state, "faded");
    assert.notEqual(store.candidates.find((candidate) => /recurring timeout/.test(candidate.content))?.state, "faded");
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("mature attended thoughts receive only one independent expression review", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-expression-gate-"));
  const filePath = path.join(directory, "thought-pool.json");
  try {
    const pool = new ThoughtPool(filePath);
    let id = "";
    for (const source of ["m1", "m2", "m3"]) {
      const result = await pool.addCandidate({
        content: "Could the recurring timeout be about continuity rather than raw speed?",
        sourceMemoryIds: [source], sourceClusters: [`cluster-${source}`],
        cognitiveMove: "question", qualityFlags: [],
        scores: { novelty: 0.9, coherence: 0.9, resonance: 0.8, userRelevance: 0.8 },
      });
      id = result.candidate.id;
    }
    await pool.markAttended(id);
    assert.equal((await pool.getExpressionCandidates(0, 5)).length, 1);
    await pool.markExpressionEvaluated(id, false);
    assert.equal((await pool.getExpressionCandidates(0, 5)).length, 0);
    const stored = await pool.load();
    assert(stored.candidates[0].expressionEvaluatedAt);
    assert.equal(stored.candidates[0].expressedAt, undefined);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
