import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultEgoState } from "../src/ego-store.js";
import { buildGoalSystemSummary, recomputeGoalState } from "../src/goal-system.js";

test("goal system summary includes measurement criteria and maintenance context", () => {
  const ego = createDefaultEgoState();
  ego.mentalContext.maintenanceBacklog = [{
    domain: "subagent-reliability",
    label: "Subagent reliability",
    objective: "Make autonomous improvement runs finish with a complete report instead of timing out or stopping short.",
    nextStep: "Inspect the execution chain and remove the dominant failure bottleneck.",
    preferredAction: "subagent-improve",
    score: 90,
    evidence: ["partial reports", "timeouts"],
    alignedGoals: ["Build Trust"],
    alignmentSummary: "Build Trust demands verified completion.",
    lastSeenAt: Date.now(),
  }];

  const summary = buildGoalSystemSummary(ego, ego.mentalContext.maintenanceBacklog);
  assert.match(summary, /Goal System/);
  assert.match(summary, /Know the User/);
  assert.match(summary, /criteria:/);
  assert.match(summary, /Current Maintenance Focus/);
  assert.match(summary, /Subagent reliability/);
});

test("goal recomputation advances knowledge goals from stable evidence", () => {
  const ego = createDefaultEgoState();
  ego.userFacts = [
    {
      id: "1",
      category: "project",
      content: "openclaw-soul",
      confidence: 0.9,
      source: "explicit",
      firstMentionedAt: Date.now(),
      updatedAt: Date.now(),
      timesConfirmed: 2,
      validity: "active",
    },
    {
      id: "2",
      category: "habit",
      content: "prefers concise technical guidance",
      confidence: 0.8,
      source: "explicit",
      firstMentionedAt: Date.now(),
      updatedAt: Date.now(),
      timesConfirmed: 2,
      validity: "active",
    },
    {
      id: "3",
      category: "interest",
      content: "AI autonomy and memory",
      confidence: 0.7,
      source: "interaction",
      firstMentionedAt: Date.now(),
      updatedAt: Date.now(),
      timesConfirmed: 1,
      validity: "active",
    },
  ];

  const result = recomputeGoalState(ego);
  assert.equal(result.changed >= 2, true);
  const knowUser = ego.goals.find((goal) => goal.id === "goal-know-user");
  assert.ok(knowUser);
  assert.equal(typeof knowUser?.measurementCriteria?.[0], "string");
  assert.equal(typeof knowUser?.evaluationSummary, "string");
  assert.equal(typeof knowUser?.lastEvaluatedAt, "number");
});

test("semantic improvement goals are classified as improvement and pick up maintenance context", () => {
  const ego = createDefaultEgoState();
  const now = Date.now();
  ego.goals.push({
    id: "goal-human-like-soul",
    title: "Make Soul more proactive, useful, human-like",
    description: "Keep maintenance tied to the user's long-term request for a more proactive, useful, human-like Soul.",
    progress: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  recomputeGoalState(ego);

  const semanticGoal = ego.goals.find((goal) => goal.id === "goal-human-like-soul");
  assert.ok(semanticGoal);
  assert.equal(semanticGoal?.goalFamily, "improvement");
  assert.match(semanticGoal?.evaluationSummary ?? "", /Maintenance runs=yes/);
});
