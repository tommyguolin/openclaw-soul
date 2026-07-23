import type { EgoState, Goal, MaintenanceBacklogItem } from "./types.js";

export type GoalBlueprint = {
  title: string;
  description: string;
  targetState: string;
  measurementCriteria: string[];
  childGoals: string[];
  alignmentHints: string[];
};

type GoalProgressResult = {
  progress: number;
  summary: string;
  measurementCriteria: string[];
  targetState: string;
  childGoals: string[];
};

type GoalFamily = "knowledge" | "trust" | "improvement" | "generic";

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function goalGap(goal: Goal): number {
  return Math.max(0, 100 - Math.max(0, Math.min(100, goal.progress)));
}

function goalFamily(goal: Goal): GoalFamily {
  const text = normalize(`${goal.title} ${goal.description}`);
  if (/(know the user|了解用户|understand the user|了解我|know me)/i.test(text)) return "knowledge";
  if (/(build trust|trust|建立信任|trustworthy|可靠)/i.test(text)) return "trust";
  if (/(self.?improv|优化|改进|更主动|更积极|更有用|更像人|human[- ]like|useful|helpful|proactive|improve)/i.test(text)) return "improvement";
  return "generic";
}

export function buildGoalPath(goal: Goal, goals: Goal[] = []): string {
  const byId = new Map(goals.map((item) => [item.id, item] as const));
  const path: string[] = [];
  const seen = new Set<string>();
  let current: Goal | undefined = goal;

  while (current && !seen.has(current.id)) {
    path.unshift(current.title);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  if (goal.goalFamily && (path[0] ?? "") !== goal.goalFamily) {
    path.unshift(goal.goalFamily);
  }

  return uniqueStrings(path).join(" > ");
}

export function selectPrimaryGoal(ego: EgoState): Goal | undefined {
  const activeGoals = (ego.goals ?? []).filter((goal) => goal.status === "active");
  if (activeGoals.length === 0) return undefined;

  const improvementSignals = (ego.behaviorLog ?? []).filter((entry) =>
    entry.actionType === "observe-and-improve" || entry.actionType === "subagent-improve" || entry.actionType === "run-agent-task",
  ).length;
  const trustSignals = (ego.behaviorLog ?? []).filter((entry) =>
    entry.outcome === "failed" || entry.outcome === "no-response",
  ).length;
  const knowledgeSignals = (ego.userFacts ?? []).filter((fact) => fact.validity !== "superseded").length;

  const scored = activeGoals.map((goal) => {
    const family = goal.goalFamily || goalFamily(goal);
    const gap = goalGap(goal);
    const measurementBonus = (goal.measurementCriteria?.length ?? 0) * 2;
    const targetBonus = goal.targetState ? 4 : 0;
    const familyBonus =
      family === "improvement" ? Math.min(20, 8 + improvementSignals * 2)
        : family === "trust" ? Math.min(16, 6 + trustSignals * 2)
          : family === "knowledge" ? Math.min(14, Math.min(knowledgeSignals, 8))
            : 0;
    const recencyBonus = goal.lastEvaluatedAt ? 2 : 0;
    const score = gap * 1.2 + familyBonus + measurementBonus + targetBonus + recencyBonus;
    return { goal, score };
  });

  scored.sort((a, b) => b.score - a.score || b.goal.updatedAt - a.goal.updatedAt);
  return scored[0]?.goal;
}

function activeUserFacts(ego: EgoState): string[] {
  return (ego.userFacts ?? [])
    .filter((fact) => fact.validity !== "superseded")
    .map((fact) => `${fact.category}:${fact.content}`);
}

function recentBehaviorText(ego: EgoState): string {
  return (ego.behaviorLog ?? [])
    .slice(-80)
    .map((entry) => `${entry.actionType} ${entry.outcome} ${entry.thoughtType}`)
    .join(" ");
}

function recentTaskText(ego: EgoState): string {
  return (ego.activeTasks ?? [])
    .slice(-30)
    .map((task) => `${task.title} ${task.description} ${task.result ?? ""}`)
    .join(" ");
}

function goalEvidenceText(goal: Goal, ego: EgoState): string {
  return `${goal.title} ${goal.description} ${recentBehaviorText(ego)} ${recentTaskText(ego)} ${activeUserFacts(ego).join(" ")}`;
}

function progressForKnowledgeGoal(goal: Goal, ego: EgoState): GoalProgressResult {
  const facts = ego.userFacts ?? [];
  const knownCategories = new Set(
    facts
      .filter((fact) => fact.validity !== "superseded")
      .map((fact) => fact.category),
  );
  const targetCategories = 6;
  const baseProgress = Math.min(70, (knownCategories.size / targetCategories) * 70);
  const avgConfidence = facts.length > 0
    ? facts.reduce((sum, fact) => sum + fact.confidence, 0) / facts.length
    : 0;
  const confidenceBonus = Math.min(30, avgConfidence * 30);
  const progress = Math.min(100, Math.round(baseProgress + confidenceBonus));

  return {
    progress,
    summary: `Known categories ${knownCategories.size}/${targetCategories}; avg confidence ${avgConfidence.toFixed(2)}.`,
    measurementCriteria: [
      "discover stable facts across core user categories",
      "confirm facts through repeated interaction or explicit statements",
      "capture communication preferences and project context",
    ],
    targetState: "A compact but reliable user model that supports useful, specific responses.",
    childGoals: [
      "Identify the user's current projects",
      "Capture stable preferences and habits",
      "Keep factual memory accurate and current",
    ],
  };
}

function progressForTrustGoal(goal: Goal, ego: EgoState): GoalProgressResult {
  const behaviors = ego.behaviorLog ?? [];
  const helpful = behaviors.filter((entry) => entry.outcome === "success").length;
  const failures = behaviors.filter((entry) => entry.outcome === "failed" || entry.outcome === "no-response").length;
  const recentPositiveFeedback = (ego.memories ?? []).filter((memory) =>
    memory.type === "interaction"
    && memory.tags.includes("inbound")
    && /thanks|thank you|不错|可以|很好|adopted|helpful/i.test(memory.content),
  ).length;
  const base = Math.min(60, helpful * 4 + recentPositiveFeedback * 6);
  const penalty = Math.min(30, failures * 3);
  const progress = Math.max(0, Math.min(100, Math.round(base - penalty + 20)));

  return {
    progress,
    summary: `Helpful actions ${helpful}, failed/no-response actions ${failures}, positive feedback signals ${recentPositiveFeedback}.`,
    measurementCriteria: [
      "deliver verified useful outcomes",
      "avoid false claims and unsupported completion",
      "maintain reliable execution and recovery behavior",
    ],
    targetState: "The user can rely on Soul for concrete help, accurate claims, and stable follow-through.",
    childGoals: [
      "Return complete and verified reports",
      "Reduce failed or blocked autonomous actions",
      "Keep proactive messages useful and timely",
    ],
  };
}

function progressForImprovementGoal(goal: Goal, ego: EgoState): GoalProgressResult {
  const evidence = goalEvidenceText(goal, ego);
  const hasMaintenance = containsAny(evidence, [
    /observe-and-improve/i,
    /subagent-improve/i,
    /run-agent-task/i,
    /更主动|更有用|更像人|human[- ]like|proactive|useful|helpful/i,
  ]);
  const hasVerifiedFix = containsAny(evidence, [/fixed/i, /verified/i, /build succeeded/i, /test passed/i, /completion/i]);
  const hasShortReports = containsAny(evidence, [/partial/i, /failed before verification/i, /no final report/i, /stopped before producing/i]);
  const score = (hasMaintenance ? 25 : 0) + (hasVerifiedFix ? 45 : 0) - (hasShortReports ? 20 : 0);
  const progress = Math.max(0, Math.min(100, 35 + score));

  return {
    progress,
    summary: `Maintenance runs=${hasMaintenance ? "yes" : "no"}, verified fixes=${hasVerifiedFix ? "yes" : "no"}, short-report risk=${hasShortReports ? "present" : "low"}.`,
    measurementCriteria: [
      "maintenance work should select the most relevant bottleneck",
      "subagent work should finish with a concrete verified report",
      "gateway restarts and build checks must happen after code changes",
    ],
    targetState: "Soul can identify its own bottlenecks, fix them, and verify the result without stalling.",
    childGoals: [
      "Keep autonomous execution available when possible",
      "Ensure code changes are followed by restart and verification",
      "Prevent report truncation and false completion",
    ],
  };
}

function genericProgress(goal: Goal, ego: EgoState): GoalProgressResult {
  const evidence = goalEvidenceText(goal, ego);
  const keywords = uniqueStrings(
    goal.title
      .split(/\W+/)
      .concat(goal.description.split(/\W+/))
      .filter((token) => token.length >= 4)
      .slice(0, 6),
  );
  const hits = keywords.reduce((count, keyword) => count + (normalize(evidence).includes(normalize(keyword)) ? 1 : 0), 0);
  const progress = Math.min(95, Math.round(20 + hits * 12));

  return {
    progress,
    summary: hits > 0
      ? `Matched ${hits} evidence keyword(s) from the goal text.`
      : "No strong evidence yet; progress remains based on goal existence rather than demonstrated outcomes.",
    measurementCriteria: [
      "make the target state observable and testable",
      "define at least one concrete verification signal",
      "collect evidence before claiming completion",
    ],
    targetState: goal.description || goal.title,
    childGoals: [
      "Turn the goal into observable sub-steps",
      "Add a measurable completion check",
    ],
  };
}

function inferBlueprint(goal: Goal, ego: EgoState): GoalProgressResult {
  switch (goalFamily(goal)) {
    case "knowledge":
      return progressForKnowledgeGoal(goal, ego);
    case "trust":
      return progressForTrustGoal(goal, ego);
    case "improvement":
      return progressForImprovementGoal(goal, ego);
    default:
      return genericProgress(goal, ego);
  }
}

export function recomputeGoalState(ego: EgoState): { changed: number; summary: string } {
  const now = Date.now();
  const updated: string[] = [];

  for (const goal of ego.goals ?? []) {
    if (goal.status !== "active") continue;
    const blueprint = inferBlueprint(goal, ego);
    const nextMeasurementCriteria = uniqueStrings([
      ...(goal.measurementCriteria ?? []),
      ...blueprint.measurementCriteria,
    ]).slice(0, 6);
    const nextChildGoals = uniqueStrings([
      ...(goal.childGoals ?? []),
      ...blueprint.childGoals,
    ]).slice(0, 6);

    goal.progress = Math.max(0, Math.min(100, blueprint.progress));
    goal.targetState = goal.targetState || blueprint.targetState;
    goal.measurementCriteria = nextMeasurementCriteria;
    goal.childGoals = nextChildGoals;
    goal.goalFamily = goal.goalFamily || goalFamily(goal);
    goal.evaluationSummary = blueprint.summary;
    goal.lastEvaluatedAt = now;
    goal.updatedAt = now;
    updated.push(`${goal.title}: ${goal.progress.toFixed(0)}%`);
  }

  return {
    changed: updated.length,
    summary: updated.join(" | "),
  };
}

function renderGoal(goal: Goal, indent = 0): string {
  const pad = " ".repeat(indent);
  const family = goal.goalFamily ? ` [${goal.goalFamily}]` : "";
  const lines = [`${pad}- ${goal.title}${family} (${goal.progress.toFixed(0)}%)`];
  if (goal.targetState) {
    lines.push(`${pad}  - target: ${goal.targetState}`);
  }
  if (goal.measurementCriteria?.length) {
    lines.push(`${pad}  - criteria: ${goal.measurementCriteria.slice(0, 3).join("; ")}`);
  }
  if (goal.evaluationSummary) {
    lines.push(`${pad}  - status: ${goal.evaluationSummary}`);
  }
  if (goal.childGoals?.length) {
    for (const child of goal.childGoals.slice(0, 3)) {
      lines.push(`${pad}  - child: ${child}`);
    }
  }
  return lines.join("\n");
}

export function buildGoalSystemSummary(ego: EgoState, backlog: MaintenanceBacklogItem[] = []): string {
  const activeGoals = (ego.goals ?? []).filter((goal) => goal.status === "active");
  if (activeGoals.length === 0) return "No active goals.";

  const primaryGoal = selectPrimaryGoal(ego);
  const topBacklog = backlog.slice(0, 3);
  const sections = [
    "## Goal System",
    "",
    ...activeGoals.slice(0, 4).map((goal) => renderGoal(goal)),
  ];

  if (primaryGoal) {
    sections.push("", "### Primary Goal", renderGoal(primaryGoal));
  }

  const convergence = buildGoalConvergenceReport(ego);
  if (convergence) {
    sections.push("", "### Convergence", convergence);
  }

  if (topBacklog.length > 0) {
    sections.push("", "### Current Maintenance Focus");
    for (const item of topBacklog) {
      sections.push(`- ${item.label} (${item.score}): ${item.objective}`);
      if (item.goalPath) {
        sections.push(`  - goal path: ${item.goalPath}`);
      }
      if (item.alignmentSummary) {
        sections.push(`  - alignment: ${item.alignmentSummary}`);
      }
      if (item.nextStep) {
        sections.push(`  - next: ${item.nextStep}`);
      }
    }
  }

  return sections.join("\n");
}

export function buildGoalConvergenceReport(ego: EgoState): string {
  const activeGoals = (ego.goals ?? [])
    .filter((goal) => goal.status === "active")
    .sort((left, right) => right.progress - left.progress);
  if (activeGoals.length === 0) return "No active goals to evaluate.";

  const primaryGoal = selectPrimaryGoal(ego);
  const stalled = activeGoals.filter((goal) => goal.progress < 40).slice(0, 3);
  const topTargets = activeGoals.slice(0, 3).map((goal) => {
    const path = buildGoalPath(goal, ego.goals ?? []);
    const criteria = goal.measurementCriteria?.length ? goal.measurementCriteria.slice(0, 2).join("; ") : "no criteria yet";
    return `- ${path}: ${goal.progress.toFixed(0)}% | ${criteria}`;
  });

  const lines = [
    primaryGoal ? `Primary goal: ${buildGoalPath(primaryGoal, ego.goals ?? [])} (${primaryGoal.progress.toFixed(0)}%)` : "Primary goal: none",
    `Active goals: ${activeGoals.length}`,
    ...topTargets,
  ];

  if (stalled.length > 0) {
    lines.push(`Stalled goals: ${stalled.map((goal) => buildGoalPath(goal, ego.goals ?? [])).join("; ")}`);
  }

  return lines.join("\n");
}
