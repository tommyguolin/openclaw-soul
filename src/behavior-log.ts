import { randomBytes } from "node:crypto";
import { createSoulLogger } from "./logger.js";
import type {
  ActionType,
  BehaviorEntry,
  BehaviorOutcome,
  ActionSuccessRate,
  EgoState,
} from "./types.js";

const log = createSoulLogger("behavior-log");

/** Max entries to keep. Oldest are pruned during resolve cycles. */
const MAX_ENTRIES = 200;

/** How long before a "pending" entry is auto-expired (2 hours). */
const PENDING_EXPIRY_MS = 2 * 60 * 60 * 1000;

/** Only consider entries from the last N days for success rate calculations. */
const LOOKBACK_DAYS = 14;
const LOOKBACK_MS = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

// --- Recording ---

export function createBehaviorEntry(
  actionType: ActionType,
  thoughtType: string,
  ego: EgoState,
): BehaviorEntry {
  const urgentNeeds = Object.entries(ego.needs)
    .filter(([, n]) => n.current < n.ideal * 0.6)
    .map(([k]) => k);

  return {
    id: randomBytes(6).toString("hex"),
    actionType,
    thoughtType: thoughtType as BehaviorEntry["thoughtType"],
    hourOfDay: new Date().getHours(),
    urgentNeeds,
    outcome: "pending",
    timestamp: Date.now(),
  };
}

// --- Outcome resolution ---

/**
 * Mark a pending entry as successful.
 * Returns true if an entry was found and updated.
 */
export function markSuccess(entries: BehaviorEntry[], actionId: string): boolean {
  const entry = entries.find((e) => e.id === actionId);
  if (entry && entry.outcome === "pending") {
    entry.outcome = "success";
    entry.resolvedAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Resolve pending entries that have exceeded the expiry window.
 * Returns the number of entries expired.
 */
export function expirePending(entries: BehaviorEntry[]): number {
  const now = Date.now();
  let expired = 0;

  for (const entry of entries) {
    if (entry.outcome === "pending" && now - entry.timestamp > PENDING_EXPIRY_MS) {
      entry.outcome = "expired";
      entry.resolvedAt = now;
      expired++;
    }
  }

  return expired;
}

/**
 * Prune entries beyond MAX_ENTRIES (keep the most recent).
 * Returns the pruned list (mutates in place).
 */
export function pruneEntries(entries: BehaviorEntry[]): BehaviorEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;

  // Remove oldest resolved entries first
  const resolved = entries
    .filter((e) => e.outcome !== "pending")
    .sort((a, b) => a.timestamp - b.timestamp);
  const pending = entries.filter((e) => e.outcome === "pending");

  const toRemove = entries.length - MAX_ENTRIES;
  const removed = resolved.slice(0, toRemove);
  const removeSet = new Set(removed.map((e) => e.id));

  entries = entries.filter((e) => !removeSet.has(e.id));
  return entries;
}

// --- Success rate queries ---

/**
 * Get success rate for a specific action type over the lookback window.
 * Returns 0.5 (neutral) if not enough data.
 */
export function getActionSuccessRate(
  actionType: ActionType,
  entries: BehaviorEntry[],
): ActionSuccessRate {
  const cutoff = Date.now() - LOOKBACK_MS;
  const relevant = entries.filter(
    (e) => e.actionType === actionType && e.timestamp >= cutoff && e.outcome !== "pending",
  );

  if (relevant.length < 3) {
    return { actionType, attempts: relevant.length, successes: 0, rate: 0.5 };
  }

  const successes = relevant.filter((e) => e.outcome === "success").length;
  return {
    actionType,
    attempts: relevant.length,
    successes,
    rate: successes / relevant.length,
  };
}

/**
 * Get success rates for all action types.
 */
export function getAllSuccessRates(entries: BehaviorEntry[]): ActionSuccessRate[] {
  const actionTypes: ActionType[] = [
    "send-message",
    "learn-topic",
    "search-web",
    "self-reflect",
    "recall-memory",
    "create-goal",
    "invoke-tool",
    "analyze-problem",
    "run-agent-task",
    "report-findings",
  ];

  return actionTypes.map((at) => getActionSuccessRate(at, entries));
}

/**
 * Get success rate for an action type at a specific time-of-day band.
 * Bands: "morning" (6-12), "afternoon" (12-18), "evening" (18-22), "night" (22-6).
 */
export function getTimeBandedSuccessRate(
  actionType: ActionType,
  entries: BehaviorEntry[],
  hour?: number,
): number {
  const h = hour ?? new Date().getHours();
  const band = hourToBand(h);

  const cutoff = Date.now() - LOOKBACK_MS;
  const relevant = entries.filter(
    (e) =>
      e.actionType === actionType &&
      e.timestamp >= cutoff &&
      e.outcome !== "pending" &&
      hourToBand(e.hourOfDay) === band,
  );

  if (relevant.length < 2) return 0.5;

  const successes = relevant.filter((e) => e.outcome === "success").length;
  return successes / relevant.length;
}

function hourToBand(h: number): string {
  if (h >= 6 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  if (h >= 18 && h < 22) return "evening";
  return "night";
}

// --- Decision helpers ---

/**
 * Adjust an action probability based on historical success rate.
 * Maps rate [0,1] → adjusted probability with damping toward 0.5.
 * - rate 1.0 → multiply by 1.3
 * - rate 0.5 → no change
 * - rate 0.0 → multiply by 0.2
 */
export function adjustProbability(
  baseProbability: number,
  actionType: ActionType,
  entries: BehaviorEntry[],
  hour?: number,
): number {
  // If not enough data, return base probability unchanged (neutral)
  const overall = getActionSuccessRate(actionType, entries);
  if (overall.attempts < 3) {
    return baseProbability;
  }

  const timeRate = getTimeBandedSuccessRate(actionType, entries, hour);
  const timeEntries = entries.filter(
    (e) => e.actionType === actionType && e.timestamp >= Date.now() - LOOKBACK_MS && e.outcome !== "pending",
  );
  // If time-banded data is also sparse, rely mostly on overall
  const timeWeight = timeEntries.length >= 2 ? 0.6 : 0.2;
  const blended = overall.rate * (1 - timeWeight) + timeRate * timeWeight;

  // Damped adjustment: closer to 0.5 means less change
  const factor = 0.5 + (blended - 0.5) * 1.2;
  const clampedFactor = Math.max(0.15, Math.min(1.5, factor));

  return Math.min(1, baseProbability * clampedFactor);
}

/**
 * Log a summary of current success rates for debugging.
 */
export function logSuccessRateSummary(entries: BehaviorEntry[]): void {
  const rates = getAllSuccessRates(entries);
  const lines = rates
    .filter((r) => r.attempts > 0)
    .map((r) => `${r.actionType}: ${(r.rate * 100).toFixed(0)}% (${r.successes}/${r.attempts})`);

  if (lines.length > 0) {
    log.info(`Success rates: ${lines.join(", ")}`);
  }
}
