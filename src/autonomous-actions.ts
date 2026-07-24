import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { readFile, access as accessFile } from "node:fs/promises";
import { dirname, join, normalize, parse as parsePath, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
import { createSoulLogger } from "./logger.js";
import { IntentionStore, resolveIntentionStorePath } from "./intention/store.js";
import { WorkHandoffStore, resolveWorkHandoffStorePath } from "./handoff/store.js";
import { invokeGatewayTool, fireAgentTask, isWriteTool } from "./gateway-client.js";
import { isGoodTimeForMessage } from "./action-executor.js";
import type { LLMGenerator } from "./soul-llm.js";
import type { Thought, EgoState, ActionResult, MetricDelta, AutonomousTask, TaskStep, TaskStatus, ActionType } from "./types.js";
import type { MessageSender } from "./soul-actions.js";
import { updateEgoStore, resolveEgoStorePath } from "./ego-store.js";
import { resolveSoulDir } from "./paths.js";
import { buildUserLanguageInstruction } from "./language-context.js";

const log = createSoulLogger("autonomous-actions");
const PROCESS_STARTED_AT = Date.now();

/** Max concurrent active tasks. Soul is a background worker; run heavy work serially. */
const MAX_ACTIVE_TASKS = 1;

const PROVIDER_PRESSURE_BACKOFF_MS = 60 * 60 * 1000;
const PROVIDER_PRESSURE_TAIL_LINES = 80;
/** The hook must outlive the advertised work budget. */
const AUTONOMOUS_AGENT_TIMEOUT_SECONDS = 3600;
const AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS = 3000;
const AUTONOMOUS_AGENT_QUICK_CHECK_SECONDS = 60;
/** Grace period to wait for a subagent that timed out or errored to finish
 * writing its result file. The subagent may still be running after
 * waitForRun returns (e.g. due to timeout) and will write the result file
 * directly via the write tool. Keep this bounded so a failed run does not
 * occupy the thought cycle indefinitely. */
// Allow extra time for a subagent that hit its run timeout to finish writing
// the final report file. The write-out path is often the last thing to land
// under load, so keep a wider but still bounded recovery window.
const SUBAGENT_GRACE_PERIOD_MS = 15 * 60 * 1000;
// Successful runs can still take a few extra seconds to flush their final
// report after the runner returns. Keep this longer than the common write
// latency so we prefer a complete report over a premature partial fallback.
const SUBAGENT_SUCCESS_SETTLE_MS = 30_000;
const SUBAGENT_SUCCESS_POLL_MS = 2_000;
const SUBAGENT_STALE_SETTLE_MS = 60 * 1000;
const AUTONOMOUS_FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const AUTONOMOUS_FAILURE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const ACTIVATION_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const ACTIVATION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ACTIVATION_ATTEMPTS = 3;
const READABLE_EVIDENCE_EXTENSIONS = [".log", ".txt", ".json", ".csv", ".md", ".yaml", ".yml", ".conf"];

/** Track recently sent report messages to prevent duplicates. */
const recentReportedMessages: Map<string, number> = new Map();

function isTaskOccupyingWorker(task: AutonomousTask): boolean {
  return task.status === "in-progress" || task.status === "awaiting-restart";
}

function hasRecentProviderPressure(windowMs = PROVIDER_PRESSURE_BACKOFF_MS): boolean {
  const sessionsDir = join(homedir(), ".openclaw/agents/main/sessions");
  const cutoff = Date.now() - windowMs;
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl")) continue;
      const fp = join(sessionsDir, name);
      const stat = statSync(fp);
      if (stat.mtimeMs < cutoff) continue;
      const lines = readFileSync(fp, "utf-8").split(/\r?\n/).filter(Boolean).slice(-PROVIDER_PRESSURE_TAIL_LINES);
      for (const line of lines) {
        const providerPressureLine =
          /"fallbackStepFromFailureReason":"rate_limit"/.test(line) ||
          /"fallbackStepFromFailureDetail":"[^"]*(?:429|cooldown|suspending lanes|too many requests|rate limit)/i.test(line) ||
          (/"stopReason":"error"/.test(line) && /"errorMessage":"[^"]*(?:429|cooldown|too many requests|rate limit)/i.test(line));
        if (providerPressureLine) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function markCompletedTasksDelivered(): Promise<void> {
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    for (const t of e.activeTasks ?? []) {
      if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
    }
    return e;
  });
}

function isReportableTask(task: AutonomousTask): boolean {
  return (task.status === "completed" || task.status === "failed") && Boolean(task.result);
}

/** The stored task status can be "completed" even when its final report is
 * partial. Prefer the report's terminal status when choosing user-facing
 * wording, so a recovery summary never masquerades as completed work. */
function isCompletedTaskForUserReport(task: AutonomousTask): boolean {
  const reportStatus = task.result ? taskReportStatus(task.result) : null;
  return (reportStatus ?? task.status) === "completed";
}

function normalizeCompletedReportOpening(message: string, userLanguage?: string): string {
  if (userLanguage === "zh-CN" || /[\u4e00-\u9fff]/.test(message)) {
    return message.replace(
      /^(?:这次(?:我)?(?:检查了|查了|分析了|排查了)|我(?:检查了|查了|分析了|排查了))\s*/u,
      "已完成：",
    );
  }
  return message.replace(
    /^I\s+(?:checked|investigated|looked into|analyzed)\s+/i,
    "Completed: ",
  );
}

function formatMaintenanceFocus(thought: Thought): string {
  const params = thought.actionParams ?? {};
  const label = typeof params.maintenanceLabel === "string" ? params.maintenanceLabel : "";
  const objective = typeof params.maintenanceObjective === "string" ? params.maintenanceObjective : "";
  const nextStep = typeof params.maintenanceNextStep === "string" ? params.maintenanceNextStep : "";
  const evidence = Array.isArray(params.maintenanceEvidence)
    ? params.maintenanceEvidence.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 3)
    : [];
  const alignment = typeof params.maintenanceAlignmentSummary === "string" ? params.maintenanceAlignmentSummary : "";
  const mode = typeof params.maintenanceExecutionMode === "string" ? params.maintenanceExecutionMode : "";

  const lines: string[] = [];
  if (label || objective) {
    lines.push(`- Focus: ${[label, objective].filter(Boolean).join(" - ")}`);
  }
  if (nextStep) {
    lines.push(`- Next step: ${nextStep}`);
  }
  if (alignment) {
    lines.push(`- Goal alignment: ${alignment}`);
  }
  if (evidence.length > 0) {
    lines.push(`- Evidence: ${evidence.map((item) => item.slice(0, 180)).join(" | ")}`);
  }
  if (mode) {
    lines.push(`- Execution mode: ${mode}`);
  }
  return lines.join("\n");
}

function normalizeTaskResultForReport(result: string): string {
  return result
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 10000);  // Increased from 4000 to preserve more report content for user-facing messages
}

function isTaskBlockedResult(result: string): boolean {
  // Check for explicit failure indicators, not bare word matches.
  // Previous regex matched \berror\b / \bfailed\b anywhere, causing false positives
  // on successful reports containing phrases like "Fixed the error handling" or
  // "No error found". Require error-like context (status lines, prefixes, or
  // error-detail sections) to reduce false-positive blocked/partial classifications.
  return /^Status:\s*(?:failed|blocked|partial)\b/im.test(result)
    || /timed out|timeout|stale|rate limit|cooldown|backing off|too many requests|429|No available auth profile|aborted|prompt-error|parsererror|command exited with code [1-9]/i.test(result)
    || /^(?:##\s*)?(?:failure|error)\b/im.test(result)
    || /\b(?:failed|error)\b\s*(?:to|starting|running|before|because|while|due|with|:)\b/i.test(result)
    || /(?:Error|Exception|Traceback):/i.test(result);
}

function isProviderPressureErrorText(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return /Soul LLM backoff active|Soul LLM (?:call|\w+ lane) budget exhausted|rate limit|cooldown|No available auth profile|too many requests|429|suspending lanes|embedded run timeout|Request timed out|ECONNRESET|fetch failed/i.test(text);
}

function isLowValueAutonomousFailure(task: AutonomousTask): boolean {
  if (task.status !== "failed") return false;
  const result = task.result ?? "";
  // Only suppress truly empty failures — ones with no diagnostic content.
  // Failures that contain timeout/error details ARE worth reporting so the
  // user knows what happened and why.
  const hasContent = result.trim().length >= 50
    && !/^Status:\s*(?:failed|partial)[\s\S]*?(?:did not finish|No confirmed final|stopped before producing|Required final result file|Task timed out)\s*\.?\s*$/i.test(result.trim());
  if (hasContent) return false; // has diagnostic content → worth reporting
  return /did not finish with a complete report|No confirmed final change set|failed before verification|No reliable before\/after metrics|stopped before producing a final result file|Required final result file was not produced|Task timed out \(stale|request timed out|embedded run timeout|Failed to start autonomous agent task|LLM analysis failed|No concrete fix identified/i.test(result);
}

function recentAutonomousFailureBackoff(ego: EgoState): { count: number; remainingMs: number; latest?: AutonomousTask } | null {
  const now = Date.now();
  const cutoff = now - AUTONOMOUS_FAILURE_LOOKBACK_MS;
  const failures = (ego.activeTasks ?? [])
    .filter((task) => {
      const ts = task.completedAt ?? task.updatedAt ?? task.createdAt;
      return ts >= cutoff && (isLowValueAutonomousFailure(task)
        || /No source files found|does not resolve to a source project/i.test(task.result ?? ""));
    })
    .sort((a, b) => (b.completedAt ?? b.updatedAt ?? b.createdAt) - (a.completedAt ?? a.updatedAt ?? a.createdAt));

  const latest = failures[0];
  if (!latest) return null;

  const latestTs = latest.completedAt ?? latest.updatedAt ?? latest.createdAt;
  const remainingMs = latestTs + AUTONOMOUS_FAILURE_BACKOFF_MS - now;
  if (remainingMs <= 0) return null;
  return { count: failures.length, remainingMs, latest };
}

function hasTaskResultFile(task: AutonomousTask): boolean {
  if (!task.resultFilePath) return false;
  try {
    return statSync(task.resultFilePath).size > 0;
  } catch {
    return false;
  }
}

function hasFinalTaskResultFile(task: AutonomousTask): boolean {
  if (!task.resultFilePath) return false;
  try {
    return isFinalTaskReport(readFileSync(task.resultFilePath, "utf-8"));
  } catch {
    return false;
  }
}

type ReportStatus = "in-progress" | "awaiting-restart" | "completed" | "failed" | "blocked" | "partial";

function taskReportStatus(result: string): ReportStatus | null {
  const match = result.match(/^Status:\s*(in-progress|awaiting-restart|completed|failed|blocked|partial)\b/im);
  return match ? match[1].toLowerCase() as ReportStatus : null;
}

function isFinalTaskReport(result: string): boolean {
  const status = taskReportStatus(result);
  // The autonomous protocol requires an explicit terminal status. Ordinary
  // markdown documents can easily contain three substantial sections and
  // must never be mistaken for a task report merely because their shape is
  // report-like.
  if (status === null || status === "in-progress") return false;
  if (isPlaceholderTaskReport(result)) return false;
  if (hasUnresolvedTemplatePlaceholders(result)) return false;
  return hasRequiredReportSections(result) && hasMeaningfulTaskReportBody(result);
}

function reportStatusToTaskStatus(result: string): "awaiting-restart" | "completed" | "failed" {
  // "partial" and "blocked" indicate the subagent did useful work but
  // could not fully complete (timeout, acceptance-criteria-not-met, etc.).
  // Treat them as "completed" to avoid triggering failure backoff that
  // would block future subagent-improve tasks for hours.
  const status = taskReportStatus(result);
  if (status === "awaiting-restart") return "awaiting-restart";
  if (status === "completed" || status === "partial" || status === "blocked") {
    return "completed";
  }
  return "failed";
}

function reportRepresentsSuccessfulCompletion(result: string): boolean {
  const status = taskReportStatus(result);
  // A runner returning successfully only says that its process stopped
  // normally. The autonomous task is successful only when the report itself
  // claims a complete (or activation-pending) outcome.
  if (status === "completed" || status === "awaiting-restart") return true;
  return false;
}

function reportShowsVerifiedCodeChange(result: string): boolean {
  const changes = /##\s*(?:Changes|变更)[\s\S]*?(?=\n##\s|$)/i.exec(result)?.[0] ?? "";
  const verification = /##\s*(?:Verification|验证)[\s\S]*?(?=\n##\s|$)/i.exec(result)?.[0] ?? "";
  const changed = changes.length > 0
    && !/No files were changed|没有修改任何文件|修改文件[：:]\s*0/i.test(changes);
  const explicitNonZeroFailure = /\b(?:[1-9]\d*)\s+(?:tests?\s+)?(?:failed|failures?|errors?)\b|\b(?:failed|failures?|errors?)\s*[:=]\s*[1-9]\d*\b|(?:[1-9]\d*)\s*(?:项|个|次)?\s*(?:失败|错误)|(?:失败|错误)(?:数)?\s*[:：=]\s*[1-9]\d*/i.test(verification);
  // Remove zero-count failure summaries before looking for generic failure
  // words. "174/174 passed, 0 failed" is a successful verification, while
  // "1 failed" or "command failed" must still block activation.
  const withoutZeroFailures = verification
    .replace(/\b0\s+(?:tests?\s+)?(?:failed|failures?|errors?)\b/gi, "")
    .replace(/\b(?:failed|failures?|errors?)\s*[:=]\s*0\b/gi, "")
    .replace(/0\s*(?:项|个|次)?\s*(?:失败|错误)/g, "")
    .replace(/(?:失败|错误)(?:数)?\s*[:：=]\s*0/g, "");
  const verified = verification.length > 0
    && !/not run|未执行|没有执行验证/i.test(verification)
    && !explicitNonZeroFailure
    && !/\b(?:failed|failure|error)\b|失败|错误/i.test(withoutZeroFailures)
    && /pass|通过|success|成功|exit(?:ed)?\s*(?:code\s*)?0|\b0\s+(?:failures?|errors?)\b|0\s*(?:项|个|次)?\s*(?:失败|错误)|零(?:失败|错误)/i.test(verification);
  return changed && verified;
}

function markReportAwaitingRestart(result: string): string {
  const clean = result.trim();
  if (/^Status:\s*/im.test(clean)) {
    return clean.replace(/^Status:\s*[^\r\n]+/im, "Status: awaiting-restart");
  }
  return `Status: awaiting-restart\n\n${clean}`;
}

function markReportActivated(result: string, processStartedAt = PROCESS_STARTED_AT): string {
  const completed = result.replace(/^Status:\s*awaiting-restart\b/im, "Status: completed").trim();
  if (/##\s*Activation\b/i.test(completed)) return completed;
  return `${completed}\n\n## Activation\nGateway restarted and loaded this build at ${new Date(processStartedAt).toISOString()}.`;
}

function markReportActivationFailed(result: string, detail: string): string {
  const failed = result.replace(/^Status:\s*awaiting-restart\b/im, "Status: failed").trim();
  const withoutOldActivation = failed.replace(/\n##\s*Activation\b[\s\S]*$/i, "").trim();
  return `${withoutOldActivation}\n\n## Activation\n${detail}`;
}

type GatewayRestartScheduleResult = {
  ok: boolean;
  error?: string;
  markerPath?: string;
};

type GatewayRestartScheduler = (taskId: string) => GatewayRestartScheduleResult;

function cleanupOldRestartHelpers(directory: string): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(directory)) {
      if (!/^restart-[a-f0-9-]+\.(?:cjs|json)$/i.test(name)) continue;
      const filePath = join(directory, name);
      if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
    }
  } catch {
    // Cleanup is best-effort and must never prevent activation.
  }
}

/**
 * Launch restart work outside the gateway process. On Windows a one-shot
 * Scheduled Task owns the helper, so ending "OpenClaw Gateway" cannot also
 * kill the process responsible for starting it again.
 */
function scheduleGatewayRestart(taskId: string): GatewayRestartScheduleResult {
  if (process.platform !== "win32") {
    try {
      const child = spawn("openclaw", ["gateway", "restart"], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => log.warn(`Gateway restart process failed for ${taskId}: ${String(err)}`));
      child.unref();
      log.info(`Gateway restart process launched for ${taskId}`);
      return { ok: true };
    } catch (err) {
      const error = String(err);
      log.warn(`Failed to launch gateway restart for ${taskId}: ${error}`);
      return { ok: false, error };
    }
  }

  try {
    const helperDir = join(resolveSoulDir(), "restart-helpers");
    mkdirSync(helperDir, { recursive: true });
    cleanupOldRestartHelpers(helperDir);

    const token = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const helperPath = join(helperDir, `restart-${token}.cjs`);
    const markerPath = join(helperDir, `restart-${token}.json`);
    const scheduledTaskName = `OpenClaw Soul Restart ${token}`;
    const helperSource = [
      'const { spawnSync } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      `const markerPath = ${JSON.stringify(markerPath)};`,
      `const helperTask = ${JSON.stringify(scheduledTaskName)};`,
      "const run = (args) => spawnSync('schtasks.exe', args, { encoding: 'utf8', windowsHide: true });",
      "const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
      "wait(5000);",
      "const ended = run(['/End', '/TN', 'OpenClaw Gateway']);",
      "wait(3000);",
      "const started = run(['/Run', '/TN', 'OpenClaw Gateway']);",
      "writeFileSync(markerPath, JSON.stringify({ timestamp: Date.now(), endStatus: ended.status, startStatus: started.status, endError: ended.stderr || '', startError: started.stderr || '' }, null, 2));",
      "wait(2000);",
      "run(['/Delete', '/TN', helperTask, '/F']);",
    ].join("\n");
    writeFileSync(helperPath, helperSource, "utf-8");

    const scheduledAt = new Date(Date.now() + 2 * 60 * 1000);
    const startTime = `${String(scheduledAt.getHours()).padStart(2, "0")}:${String(scheduledAt.getMinutes()).padStart(2, "0")}`;
    const taskCommand = `"${process.execPath}" "${helperPath}"`;
    const created = spawnSync("schtasks.exe", [
      "/Create", "/TN", scheduledTaskName, "/TR", taskCommand,
      "/SC", "ONCE", "/ST", startTime, "/F",
    ], { encoding: "utf-8", windowsHide: true });
    if (created.status !== 0) {
      const error = (created.stderr || created.stdout || `schtasks /Create exited ${created.status}`).trim();
      log.warn(`Failed to create gateway restart task for ${taskId}: ${error}`);
      return { ok: false, error, markerPath };
    }

    const launched = spawnSync("schtasks.exe", ["/Run", "/TN", scheduledTaskName], {
      encoding: "utf-8",
      windowsHide: true,
    });
    if (launched.status !== 0) {
      const error = (launched.stderr || launched.stdout || `schtasks /Run exited ${launched.status}`).trim();
      log.warn(`Failed to run gateway restart task for ${taskId}: ${error}`);
      return { ok: false, error, markerPath };
    }

    log.info(`Gateway restart helper launched for ${taskId}; confirmation=${markerPath}`);
    return { ok: true, markerPath };
  } catch (err) {
    const error = String(err);
    log.warn(`Failed to schedule gateway restart for ${taskId}: ${error}`);
    return { ok: false, error };
  }
}

async function requestGatewayRestart(
  taskId: string,
  storePath = resolveEgoStorePath(),
  scheduler: GatewayRestartScheduler = scheduleGatewayRestart,
  now = Date.now(),
): Promise<GatewayRestartScheduleResult> {
  await updateEgoStore(storePath, (e) => {
    const task = e.activeTasks?.find((candidate) => candidate.id === taskId);
    if (task?.status === "awaiting-restart") {
      task.activationAttempts = (task.activationAttempts ?? 0) + 1;
      task.lastActivationAttemptAt = now;
      task.activationError = undefined;
      task.updatedAt = now;
    }
    return e;
  });

  const result = scheduler(taskId);
  await updateEgoStore(storePath, (e) => {
    const task = e.activeTasks?.find((candidate) => candidate.id === taskId);
    if (task?.status === "awaiting-restart") {
      task.activationError = result.ok ? undefined : (result.error ?? "unknown restart scheduling failure");
      task.updatedAt = Date.now();
    }
    return e;
  });
  return result;
}

/**
 * A timed-out subagent can still be writing its final report. Poll the file
 * during the bounded grace period instead of sleeping blindly and then
 * overwriting a report that arrived while we waited.
 */
async function waitForFinalTaskReport(resultFilePath: string, maxWaitMs: number, pollMs = 5_000): Promise<string | null> {
  const deadline = Date.now() + maxWaitMs;
  while (true) {
    try {
      const content = readFileSync(resultFilePath, "utf-8").trim();
      if (content && isFinalTaskReport(content)) return content;
    } catch {
      // The file may not have been created yet.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(pollMs, remaining));
  }
}

async function resolveSubagentFinalReport(
  task: AutonomousTask,
  resultFilePath: string,
  subResult: SubAgentRunResult,
  zh: boolean,
): Promise<string> {
  const readResolvedReports = (): string[] => {
    const candidates: string[] = [];
    try {
      const fileContent = readFileSync(resultFilePath, "utf-8").trim();
      if (fileContent && isFinalTaskReport(fileContent)) {
        candidates.push(fileContent);
      }
    } catch {
      // The result file may not exist yet.
    }

    const sessionReport = extractResultFromSessions(task, task.createdAt, zh);
    if (sessionReport) {
      candidates.push(sessionReport.result);
    }

    const output = subResult.output.trim();
    if (output && isFinalTaskReport(output)) {
      candidates.push(output);
    }

    return candidates;
  };

  // Do not let an early session-derived partial/failed summary beat a complete
  // result file that is still being flushed. This was the main cause of
  // "success=true, Status: partial" runs even though a complete report existed.
  const immediateCandidates = readResolvedReports();
  const immediateComplete = immediateCandidates.find(reportRepresentsSuccessfulCompletion);
  if (immediateComplete) return immediateComplete;

  const delayedReport = await waitForFinalTaskReport(
    resultFilePath,
    subResult.success ? SUBAGENT_SUCCESS_SETTLE_MS : SUBAGENT_GRACE_PERIOD_MS,
    subResult.success ? SUBAGENT_SUCCESS_POLL_MS : 5_000,
  );
  if (delayedReport) return delayedReport;

  const settledCandidates = readResolvedReports();
  const settledComplete = settledCandidates.find(reportRepresentsSuccessfulCompletion);
  if (settledComplete) return settledComplete;

  // If no complete report arrived, preserve the best real terminal report
  // before synthesizing a fallback. Prefer partial/blocked evidence over a
  // generic failure because it contains useful work and next steps.
  const terminalCandidates = [...settledCandidates, ...immediateCandidates];
  const partial = terminalCandidates.find((candidate) => {
    const status = taskReportStatus(candidate);
    return status === "partial" || status === "blocked";
  });
  if (partial) return partial;
  const failed = terminalCandidates.find((candidate) => taskReportStatus(candidate) === "failed");
  if (failed) return failed;

  try {
    const output = subResult.output.trim();
    if (subResult.success && output) {
      return `Status: partial\n\n## Outcome\nSubagent finished but did not produce a complete final report before settle.\n\n### Captured output\n${output.slice(0, 800)}\n\n## Changes\nNo files were confirmed changed.\n\n## Verification\nNo verification was run.\n\n## Metrics\nSubagent output: ${output.length} chars.\n\n## Next\nReduce iteration scope so subagent can finish within budget.`;
    }

    return `Status: failed\n\n## Outcome\nSubagent failed with no recoverable output.\n\n### Details\n${(subResult.error || subResult.output || "Subagent failed with no output").slice(0, 800)}\n\n## Changes\nNo files were changed.\n\n## Verification\nNo verification was run.\n\n## Metrics\nNone.\n\n## Next\nCheck subagent runtime availability and gateway connectivity before retrying.`;
  } catch {
    if (subResult.success) {
      const output = subResult.output.trim();
      if (output) {
        return `Status: partial\n\n## Outcome\nSubagent finished but did not produce a complete final report.\n\n### Captured output\n${output.slice(0, 800)}\n\n## Changes\nNo files were confirmed changed.\n\n## Verification\nNo verification was run.\n\n## Metrics\nSubagent output: ${output.length} chars.\n\n## Next\nReduce iteration scope so subagent can finish within budget.`;
      }
    }

    return `Status: failed\n\n## Outcome\n${subResult.error || subResult.output || "Subagent failed with no output"}`;
  }
}

function writeTaskReportFile(resultFilePath: string | undefined, content: string): void {
  if (!resultFilePath) return;
  try {
    writeFileSync(resultFilePath, `${content.trim()}\n`, "utf-8");
  } catch (err) {
    log.warn(`Failed to write autonomous task report ${resultFilePath}: ${String(err)}`);
  }
}

type VerificationResult = {
  ok: boolean;
  summary: string;
};

function runCommand(cwd: string, command: string, args: string[], timeoutMs: number): VerificationResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
  });
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(-8000);
  const commandText = [command, ...args].join(" ");
  if (result.error) {
    return { ok: false, summary: `${commandText} failed to start: ${result.error.message}${output ? `\n${output}` : ""}` };
  }
  if (result.status !== 0) {
    return { ok: false, summary: `${commandText} exited ${result.status ?? "unknown"}${output ? `\n${output}` : ""}` };
  }
  return { ok: true, summary: `${commandText} passed${output ? `\n${output}` : ""}` };
}

function packageScript(dir: string, names: string[]): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
      scripts?: Record<string, unknown>;
    };
    for (const name of names) {
      if (typeof pkg.scripts?.[name] === "string") return name;
    }
  } catch {
    // No package.json or invalid package metadata.
  }
  return null;
}

function verifyAppliedFix(targetDir: string, fixFile: string): VerificationResult {
  const ext = parsePath(fixFile).ext.toLowerCase();
  const script = packageScript(targetDir, ["typecheck", "test", "build"]);
  if (script) {
    return runCommand(targetDir, "npm", ["run", script], 120_000);
  }
  // TypeScript projects: if tsconfig.json exists but no matching npm script
  try {
    if (statSync(join(targetDir, "tsconfig.json")).isFile()) {
      return runCommand(targetDir, "npx", ["tsc", "--noEmit"], 120_000);
    }
  } catch { /* no tsconfig */ }
  // Maven projects
  try {
    if (statSync(join(targetDir, "pom.xml")).isFile()) {
      return runCommand(targetDir, "mvn", ["compile", "-q"], 180_000);
    }
  } catch { /* no pom.xml */ }
  // Gradle projects
  try {
    if (
      statSync(join(targetDir, "build.gradle")).isFile()
      || statSync(join(targetDir, "build.gradle.kts")).isFile()
    ) {
      return runCommand(targetDir, "gradle", ["compileJava", "-q"], 180_000);
    }
  } catch { /* no build.gradle */ }
  // Makefile-based projects
  try {
    const makefile = join(targetDir, "Makefile");
    const makefileLower = join(targetDir, "makefile");
    if (statSync(makefile).isFile() || statSync(makefileLower).isFile()) {
      // Try 'make check' first, fall back to 'make build'
      const checkResult = runCommand(targetDir, "make", ["check"], 120_000);
      if (!/No rule.*check/i.test(checkResult.summary)) return checkResult;
      return runCommand(targetDir, "make", ["build"], 120_000);
    }
  } catch { /* no Makefile */ }
  if (ext === ".py") {
    return runCommand(targetDir, "python", ["-m", "py_compile", fixFile], 60_000);
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return runCommand(targetDir, "node", ["--check", fixFile], 60_000);
  }
  return {
    ok: false,
    summary: `No known verification command for ${fixFile}; refusing to mark autonomous edit as completed.`,
  };
}

function buildInitialTaskReport(params: {
  taskId: string;
  title: string;
  target: string;
  resultFilePath: string;
}): string {
  return `Status: in-progress
Task: ${params.taskId}
Title: ${params.title}
Target: ${params.target}
Started: ${new Date().toISOString()}
Budget: ${AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS}s work budget inside ${AUTONOMOUS_AGENT_TIMEOUT_SECONDS}s hook timeout
Report: ${params.resultFilePath}

## Outcome
Autonomous work has started. This placeholder must be replaced with a final report before the task is considered done.

## Changes
Pending.

## Verification
Pending.

## Metrics
Pending.

## Next
Pending.`;
}

function buildFailureTaskReport(task: AutonomousTask, detail: string): string {
  const header = `Status: failed
Task: ${task.id}
Finished: ${new Date().toISOString()}`;
  return `${header}

## Outcome
The autonomous task did not finish with a complete report.

## Changes
No confirmed final change set was captured by Soul.

## Verification
The task failed before verification could be confirmed.

## Metrics
No reliable before/after metrics were captured.

## Next
Run a smaller bounded iteration and write the report incrementally before launching any long benchmark or backtest.

## Failure Detail
${detail.trim().slice(0, 8000)}`;
}

function buildPartialTaskReport(task: AutonomousTask, detail: string): string {
  const header = `Status: partial
Task: ${task.id}
Finished: ${new Date().toISOString()}`;
  return `${header}

## Outcome
The autonomous task produced a partial finding but did not write a complete final report before the budget expired.

## Changes
No confirmed final change set was captured by Soul.

## Verification
Partial verification or observations may exist in the captured output below, but the task did not provide a complete command/result report.

## Metrics
Captured partial output:
${detail.trim().slice(0, 8000)}

## Next
Continue from this partial finding with a smaller follow-up task. The next task should write Status: partial before attempting any fix, then overwrite it only after verification is complete.`;
}

function buildBoundedLocalTaskReport(params: {
  task: AutonomousTask;
  status: "partial" | "blocked";
  target: { dir: string; name: string; isSelf: boolean };
  thought: Thought;
  steps: TaskStep[];
  evidence: string[];
  userContext: string;
  recentUserMessages: string;
  activeGoals: string;
  analysisContext: string;
  limitation: string;
  resultFilePath: string;
}): string {
  const successfulReads = params.steps.filter((s) => s.success).length;
  const failedReads = params.steps.length - successfulReads;
  const inspected = params.steps
    .filter((s) => s.action.startsWith("read-"))
    .map((s) => `- ${s.action}: ${s.input} (${s.success ? "ok" : "failed"})`)
    .join("\n");
  const evidence = params.evidence.length > 0
    ? params.evidence.join("\n\n").slice(0, 10000)
    : "No readable local evidence was found in the resolved target directory.";

  return `Status: ${params.status}
Task: ${params.task.id}
Finished: ${new Date().toISOString()}
Target: ${params.target.dir} (${params.target.name})
Report: ${params.resultFilePath}

## Outcome
Soul completed a bounded local inspection for this autonomous task but did not claim a full implementation. ${params.limitation}

Directive:
${params.thought.content.slice(0, 1000)}

Context used:
- User profile: ${params.userContext || "limited"}
- Recent user messages: ${params.recentUserMessages || "none"}
- Active goals: ${params.activeGoals || "none"}
${params.analysisContext ? `- Previous analysis: ${params.analysisContext.slice(0, 1000)}` : "- Previous analysis: none"}

## Changes
No files were changed by run-agent-task. This path is intentionally read-only until Soul has a trusted child-agent execution channel or the task is handled by observe-and-improve's direct local patch path.

## Verification
Local inspection steps:
${inspected || "- No read steps ran."}

Read results: ${successfulReads} succeeded, ${failedReads} failed.
The task was not verified end-to-end because no trusted autonomous execution channel was available for write/command work.

## Metrics
Files or artifacts inspected: ${successfulReads}. No before/after performance, backtest, or benchmark metrics were produced by this bounded inspection.

Evidence excerpts:
${evidence}

## Next
Use a trusted Gateway agent RPC or execute a smaller direct observe-and-improve task that can apply one local patch and run verification. Do not route autonomous task instructions through /hooks/agent unless OpenClaw marks the source as trusted; otherwise the child agent may treat the task protocol as external untrusted content and ignore it.`;
}

function isCompleteTaskReport(result: string): boolean {
  const text = result.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  if (!text) return false;
  const status = taskReportStatus(text);
  if (status === null || status === "in-progress") return false;
  if (isPlaceholderTaskReport(text)) return false;
  if (hasUnresolvedTemplatePlaceholders(text)) return false;

  // A terminal report with at least three markdown sections is complete even
  // when its section headings are not English.
  return hasRequiredReportSections(text) && hasMeaningfulTaskReportBody(text);
}

function hasRequiredReportSections(result: string): boolean {
  const text = result.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  // Language-agnostic: a section title is any non-whitespace text after ##.
  // JavaScript \w is ASCII-only and rejects headings such as "## 结果".
  const sectionHeaders = text.match(/^##\s+\S[^\r\n]*/gm);
  if (!sectionHeaders || sectionHeaders.length < 3) return false;
  const unique = new Set(sectionHeaders.map(h => h.toLowerCase()));
  return unique.size >= 3;
}

function hasMeaningfulTaskReportBody(result: string): boolean {
  const text = result.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bodyLines = lines.filter((line) =>
    !/^Status:\s*/i.test(line)
    && !/^(?:Task|Title|Target|Started|Finished|Budget|Report):\s*/i.test(line)
    && !/^##\s+\S/.test(line)
    && !/^[-=]{3,}$/.test(line)
  );
  if (bodyLines.length === 0) return false;

  return bodyLines.some((line) =>
    !/^(?:Pending\.?|TBD|TODO|To be determined|To be done|N\/A|None|暂无|待补充|待完善|待完成|进行中|处理中|占位)$/i.test(line)
    && isReportLikeBodyLine(line)
  );
}

function hasUnresolvedTemplatePlaceholders(result: string): boolean {
  const text = result.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  return /\$\{[^}]+\}/.test(text)
    || /\bparams\.[A-Za-z_]\w*/.test(text)
    || /\btask\.[A-Za-z_]\w*/.test(text);
}

function isReportLikeBodyLine(line: string): boolean {
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(line)) return false;
  if (/^(?:\/\/|\/\*|\*|#|```|function\b|const\b|let\b|var\b|class\b|import\b|export\b|return\b)/i.test(line)) return false;
  if (/[{};]/.test(line) || /=>|\$\{/.test(line)) return false;
  if (/^(?:[-•*]\s+|\d+[.)]\s+)/.test(line)) return true;
  if (/[。！？.!?]$/.test(line)) return true;
  return line.split(/\s+/).length >= 3;
}

function isPlaceholderTaskReport(result: string): boolean {
  const text = result.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
  if (!text) return false;
  const pendingCount = (text.match(/^Pending\.$/gmi) ?? []).length;
  return /Autonomous work has started\./i.test(text)
    || /This placeholder must be replaced with a final report before the task is considered done\./i.test(text)
    || pendingCount >= 3;
}

function isInterimTaskNarration(result: string): boolean {
  const normalized = result.trim();
  return /^(?:let me|now let me|i(?:'|’)ll|i will|first i|next i|我先|我将|现在我|让我|接下来|先看|先查|准备)/i.test(normalized)
    && !/##\s*(outcome|changes|verification|metrics|next)|验证|指标|结果|变更|完成|completed|verified|metrics/i.test(normalized);
}

function extractSessionText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => extractSessionText(item))
      .filter((item) => item.length > 0)
      .join("\n")
      .trim();
  }
  if (value && typeof value === "object") {
    const record = value as {
      text?: unknown;
      output?: unknown;
      content?: unknown;
      message?: unknown;
    };
    if (typeof record.text === "string") return record.text.trim();
    if (typeof record.output === "string") return record.output.trim();
    if (record.content !== undefined) return extractSessionText(record.content);
    if (record.message !== undefined) return extractSessionText(record.message);
  }
  return "";
}

/** Check if a subagent session for the given task has been written to recently
 * (within the last 5 minutes), indicating the subagent is still actively running. */
function isSubagentSessionRecentlyActive(task: AutonomousTask): boolean {
  const sessionsDir = join(homedir(), ".openclaw/agents/main/sessions");
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const fp = join(sessionsDir, name);
      const stat = statSync(fp);
      if (Date.now() - stat.mtimeMs < 5 * 60 * 1000) {
        try {
          const content = readFileSync(fp, "utf-8");
          if (content.includes(task.id) || content.includes("soul-task-" + task.id)) {
            return true;
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* sessions dir not accessible */ }
  return false;
}


function isTaskBlockedOrPartial(task: AutonomousTask, result: string): boolean {
  if (unmetAcceptanceCriteria(task, result).length > 0) return true;
  const reportStatus = taskReportStatus(result);
  if (task.status === "failed") return true;
  // Partial/blocked reports are internally settled as completed to avoid a
  // failure-backoff loop, but must remain visibly incomplete to the user.
  if (reportStatus === "failed" || reportStatus === "blocked" || reportStatus === "partial") return true;
  if (reportStatus === "completed") {
    return isInterimTaskNarration(result)
      || isPlaceholderTaskReport(result)
      || (Boolean(task.resultFilePath) && !hasTaskResultFile(task));
  }
  if (task.status === "completed") {
    return isInterimTaskNarration(result)
      || isPlaceholderTaskReport(result)
      || (Boolean(task.resultFilePath) && !hasTaskResultFile(task));
  }

  return isTaskBlockedResult(result)
    || isInterimTaskNarration(result)
    || (Boolean(task.resultFilePath) && !hasTaskResultFile(task));
}

function taskResultFileLine(task: AutonomousTask, zh: boolean): string | null {
  if (!task.resultFilePath) return null;
  try {
    const stat = statSync(task.resultFilePath);
    return zh
      ? `报告文件: ${task.resultFilePath} (${stat.size} bytes)`
      : `Report file: ${task.resultFilePath} (${stat.size} bytes)`;
  } catch {
    return zh
      ? `报告文件: 未生成 (${task.resultFilePath})`
      : `Report file: missing (${task.resultFilePath})`;
  }
}

function extractReportField(result: string, fields: string | string[]): string {
  const alternatives = (Array.isArray(fields) ? fields : [fields])
    .map((field) => field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const match = new RegExp(
    `^##\\s+(?:${alternatives})(?=\\s|:|：|$)[^\\r\\n]*\\r?\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    "im",
  ).exec(result.replace(/<think[\s\S]*?<\/think>/gi, "").trim());
  return match ? match[1].trim() : "";
}

function extractChangedFiles(changesText: string): string[] {
  const files: string[] = [];
  for (const line of changesText.split(/\r?\n/)) {
    const m = line.match(/(?:^|[-•]\s*)([A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+)/);
    if (m && !files.includes(m[1])) files.push(m[1]);
  }
  return files;
}

function captureGitDiffStat(targetDir: string): string | null {
  try {
    const result = spawnSync("git", ["diff", "--stat", "HEAD"], {
      cwd: targetDir,
      encoding: "utf-8",
      timeout: 15_000,
      shell: process.platform === "win32",
    });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch { /* git not available or not a git repo */ }
  return null;
}

export type SubAgentRunResult = {
  runId: string;
  success: boolean;
  output: string;
  error?: string;
};

export type SubAgentRunner = (params: {
  sessionKey: string;
  message: string;
  timeoutMs?: number;
}) => Promise<SubAgentRunResult>;

export type AutonomousActionOptions = {
  autonomousActions: boolean;
  gatewayPort: number;
  authToken?: string;
  hooksToken?: string;
  llmGenerator?: LLMGenerator;
  sendMessage?: MessageSender;
  channel?: string;
  target?: string;
  workspaceContext?: string;
  subAgentRunner?: SubAgentRunner;
};

function autonomousShellInstruction(): string {
  if (process.platform === "win32") {
    return `**Shell environment**:
- The command shell is PowerShell on Windows, not bash.
- Use PowerShell commands such as Get-ChildItem, Get-Content, Select-String, and Set-Location -LiteralPath.
- Do not use bash-only commands or syntax such as head, tail, sed, grep, cd /d, &&, or /dev/null.
- Prefer the tool's workdir option over changing directories inside a command.`;
  }
  return `**Shell environment**:
- The command shell is POSIX-compatible. Use commands and quoting appropriate for that shell.`;
}

function taskContinuityFields(thought: Thought): Pick<AutonomousTask,
  "intentionId" | "workHandoffId" | "targetProjectRoot" | "acceptanceCriteria" | "maintenanceDomain" | "maintenanceObjective"> {
  const params = thought.actionParams ?? {};
  return {
    ...(typeof params.intentionId === "string" ? { intentionId: params.intentionId } : {}),
    ...(typeof params.workHandoffId === "string" ? { workHandoffId: params.workHandoffId } : {}),
    ...(typeof params.projectRoot === "string" ? { targetProjectRoot: params.projectRoot } : {}),
    ...(Array.isArray(params.acceptanceCriteria)
      ? { acceptanceCriteria: params.acceptanceCriteria.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(typeof params.maintenanceFocus === "string" ? { maintenanceDomain: params.maintenanceFocus } : {}),
    ...(typeof params.maintenanceObjective === "string" ? { maintenanceObjective: params.maintenanceObjective } : {}),
  };
}

function unmetAcceptanceCriteria(task: AutonomousTask, result: string): string[] {
  const criteria = task.acceptanceCriteria ?? [];
  if (criteria.length === 0) return [];
  const successfulActions = task.steps
    .filter((step) => step.success)
    .map((step) => step.action)
    .join(" ");
  const explicitlyNoChange = /No files were changed|No source files changed|没有修改任何文件|修改文件：\s*0/i.test(result);
  const hasChangeEvidence = !explicitlyNoChange && (
    /修改文件：\s*(?!0\b|无\b|none\b)[^\n]+/i.test(result)
    || /Files modified:\s*(?!0\b|none\b)[^\n]+/i.test(result)
    || /Applied and verified improvement fix|Fixed\s+[^\n:]+:/i.test(result)
    || /\b(?:apply|edit|patch|write|modify)[\w-]*\b/i.test(successfulActions)
  );
  const explicitlyNoVerification = /Verification:\s*not run|验证：未执行|没有执行验证|No verification was run|not verified end-to-end/i.test(result);
  const hasVerificationEvidence = !explicitlyNoVerification && (
    /(?:verification|验证|npm|pnpm|yarn|pytest|typecheck|test|build)[^\n]{0,160}(?:passed|通过|succeeded|成功)/i.test(result)
    || /\b(?:verify|test|typecheck|build)[\w-]*\b/i.test(successfulActions)
  );

  return criteria.filter((criterion) => {
    if (/concrete changed files|files? changed|code change/i.test(criterion)) return !hasChangeEvidence;
    if (/verification command|verified|verification passes/i.test(criterion)) return !hasVerificationEvidence;
    return false;
  });
}

/**
 * Main dispatch for autonomous action types.
 * Called from action-executor.ts switch statement.
 */
export async function executeAutonomousAction(
  actionType: ActionType,
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const autoOpts: AutonomousActionOptions = {
    autonomousActions: options.autonomousActions ?? false,
    gatewayPort: options.gatewayPort ?? 18789,
    authToken: options.authToken,
    hooksToken: options.hooksToken,
    llmGenerator: options.llmGenerator,
    sendMessage: options.sendMessage,
    channel: options.channel,
    target: options.target,
    workspaceContext: options.workspaceContext,
    subAgentRunner: options.subAgentRunner,
  };

  switch (actionType) {
    case "invoke-tool":
      return executeInvokeTool(thought, ego, autoOpts);
    case "analyze-problem":
      return executeAnalyzeProblem(thought, ego, autoOpts);
    case "run-agent-task":
      return executeRunAgentTask(thought, ego, autoOpts);
    case "report-findings":
      return executeReportFindings(thought, ego, autoOpts);
    case "observe-and-improve":
      return executeObserveAndImprove(thought, ego, autoOpts);
    case "subagent-improve":
      return executeSubagentImprove(thought, ego, autoOpts);
    default:
      return { result: { type: actionType, success: false, error: `Unknown autonomous action: ${actionType}` }, metricsChanged: [] };
  }
}

// ---------------------------------------------------------------------------
// executeInvokeTool — single gateway tool call
// ---------------------------------------------------------------------------

export async function executeInvokeTool(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const tool = (thought.actionParams?.tool as string) ?? "";
  const args = (thought.actionParams?.args as Record<string, unknown>) ?? {};

  if (!tool) {
    return { result: { type: "invoke-tool", success: false, error: "No tool specified" }, metricsChanged: [] };
  }

  // Permission check
  if (isWriteTool(tool, args) && !options.autonomousActions) {
    log.info(`Blocked write tool "${tool}" — autonomousActions is false`);
    return {
      result: { type: "invoke-tool", success: false, error: `Tool "${tool}" requires autonomousActions config` },
      metricsChanged: [],
    };
  }

  const start = Date.now();
  const toolResult = await invokeGatewayTool({
    tool,
    args,
    gatewayPort: options.gatewayPort,
    authToken: options.authToken,
    timeoutMs: 60_000,
  });
  const duration = Date.now() - start;

  log.info(`Invoked tool ${tool}: ok=${toolResult.ok} (${duration}ms)`);

  return {
    result: {
      type: "invoke-tool",
      success: toolResult.ok,
      result: toolResult.result,
      error: toolResult.error,
      data: { tool, args, duration },
    },
    metricsChanged: toolResult.ok
      ? [
          { need: "growth", delta: 5, reason: "used a tool successfully" },
          { need: "meaning", delta: 3, reason: "being useful" },
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// executeAnalyzeProblem — multi-step: gather → analyze → report
// ---------------------------------------------------------------------------

function buildRuleBasedAnalysis(
  thought: Thought,
  ego: EgoState,
  gatheredInfo: string[],
  steps: TaskStep[],
): string {
  const combined = gatheredInfo.join("\n\n");
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const signalLines = lines
    .filter((line) => /error|warn|failed|failure|exception|timeout|rate limit|cooldown|401|403|429|500|too many|invalid|traceback|报错|失败|错误|超时|限流/i.test(line))
    .slice(0, 8);
  const successfulReads = steps.filter((s) => s.success).length;
  const failedReads = steps.length - successfulReads;
  const context = thought.content.replace(/\s+/g, " ").slice(0, 240);

  const findings = signalLines.length > 0
    ? signalLines.map((line) => `- ${line.slice(0, 260)}`).join("\n")
    : "- No obvious error/warn/timeout/rate-limit signal was found in gathered content.";
  return [
    "## Analysis",
    "",
    `Context: ${context}`,
    "",
    `Read results: ${successfulReads} succeeded, ${failedReads} failed.`,
    "",
    "Signals:",
    findings,
    "",
    "Next: escalate to the rate-limited full agent path only if these signals are not enough; background analyze-problem does not call the model directly.",
  ].join("\n");
}

function isInternalNeedDiagnostic(thought: Thought): boolean {
  const text = `${thought.content} ${thought.motivation} ${thought.triggerDetail}`.replace(/\s+/g, " ");
  return /need (?:critically low|is low|could improve|is somewhat)|\b(?:Security|Survival|Growth|Meaning|Connection) need\b|\d+\/\d+/.test(text);
}

function isOnlyProviderPressureDiagnostic(result: string): boolean {
  const text = result.replace(/<think[\s\S]*?<\/think>/gi, "");
  const hasProviderPressure = /Soul LLM backoff active|Soul LLM (?:call|\w+ lane) budget exhausted|provider backoff active|rate limit|cooldown|too many requests|429/i.test(text);
  const hasExternalSignal = /traceback|exception|parsererror|command exited with code [1-9]|500|401|403|TypeError|ReferenceError|SyntaxError|Cannot find module/i.test(text);
  return hasProviderPressure && !hasExternalSignal;
}

function collectKnownLocalEvidenceTargets(ego: EgoState, currentText = ""): string[] {
  const haystacks = [
    currentText,
    ...(ego.mentalContext?.foreground ?? []),
    ...(ego.mentalContext?.backgroundConcerns ?? []),
    ...(ego.mentalContext?.residue ?? []),
    ...(ego.recentUserMessages ?? []),
    ...(ego.memories ?? [])
      .filter((memory) => memory.type === "interaction" && memory.tags.includes("inbound"))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map((memory) => memory.content),
  ];
  const targets: string[] = [];
  for (const text of haystacks) {
    for (const match of text.matchAll(/(?:^|[\s(（"'`])((?:\/[A-Za-z0-9._-]+){2,}\/?)/g)) {
      const value = match[1].replace(/[),，。；;]+$/g, "");
      if (!targets.includes(value)) targets.push(value);
    }
    for (const match of text.matchAll(/\b((?:\d{1,3}\.){3}\d{1,3})\b/g)) {
      const value = match[1];
      if (!targets.includes(value)) targets.push(value);
    }
  }
  return targets.slice(0, 8);
}

function isReadableEvidenceFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return READABLE_EVIDENCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function readLocalEvidenceTarget(target: string): Promise<{ steps: TaskStep[]; evidence: string[] }> {
  const steps: TaskStep[] = [];
  const evidence: string[] = [];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target)) {
    steps.push(makeSkippedStep("known-remote-host", `Remote host target known but not read by bounded local analyzer: ${target}`));
    return { steps, evidence };
  }
  try {
    const stat = statSync(target);
    if (stat.isFile() && isReadableEvidenceFile(target)) {
      const step = await readLocalFile("read-context-evidence-file", target);
      steps.push(step);
      if (step.success && step.output) evidence.push(`=== Context target: ${target} ===\n${step.output}`);
      return { steps, evidence };
    }
    if (stat.isDirectory()) {
      const candidates = readdirSync(target)
        .filter((name) => isReadableEvidenceFile(name))
        .slice(0, 5)
        .map((name) => join(target, name));
      if (candidates.length === 0) {
        steps.push(makeSkippedStep("known-local-directory-empty", `No readable evidence files found in ${target}`));
      }
      for (const filePath of candidates) {
        const step = await readLocalFile("read-context-evidence-file", filePath);
        steps.push(step);
        if (step.success && step.output) evidence.push(`=== Context target: ${filePath} ===\n${step.output}`);
      }
      return { steps, evidence };
    }
    steps.push(makeSkippedStep("known-local-target-unsupported", `Known target is not a regular file or directory: ${target}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push(makeSkippedStep("known-local-target-unreadable", `${target}: ${msg}`));
  }
  return { steps, evidence };
}

export async function executeAnalyzeProblem(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const taskId = randomBytes(4).toString("hex");
  const title = thought.motivation.slice(0, 100);

  // Check task limit
  const activeCount = (ego.activeTasks ?? []).filter(isTaskOccupyingWorker).length;
  if (activeCount >= MAX_ACTIVE_TASKS) {
    log.info("Too many active tasks, skipping analyze-problem");
    return { result: { type: "analyze-problem", success: false, error: "Too many active tasks" }, metricsChanged: [] };
  }

  // Create task record
  const task: AutonomousTask = {
    id: taskId,
    title,
    description: thought.content.slice(0, 200),
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    ...taskContinuityFields(thought),
    steps: [],
    requiresWritePermission: false,
    resultDelivered: false,
  };

  await persistTask(task);

  const steps: TaskStep[] = [];
  const gatheredInfo: string[] = [];

  // Phase 1: Gather information
  const filePaths = (thought.actionParams?.logPaths as string[]) ?? [];
  const sourcePaths = (thought.actionParams?.sourcePaths as string[]) ?? [];
  const requiresLocalEvidence = thought.actionParams?.requiresLocalEvidence === true;
  const contextualTargets = [
    ...((thought.actionParams?.localEvidenceTargets as string[]) ?? []),
    ...collectKnownLocalEvidenceTargets(ego, `${thought.content}\n${thought.motivation}`),
  ].filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index).slice(0, 8);

  // Read any files mentioned in conversation (logs, source, config, etc.)
  for (const filePath of filePaths.slice(0, 5)) {
    const step = await readLocalFile("read-file", filePath);
    steps.push(step);
    if (step.success && step.output) gatheredInfo.push(`=== File: ${filePath} ===\n${step.output}`);
  }

  // Read additional source files
  for (const srcPath of sourcePaths.slice(0, 3)) {
    const step = await readLocalFile("read-source", srcPath);
    steps.push(step);
    if (step.success && step.output) gatheredInfo.push(`=== Source: ${srcPath} ===\n${step.output}`);
  }

  if (gatheredInfo.length === 0 && requiresLocalEvidence && contextualTargets.length > 0) {
    for (const target of contextualTargets) {
      const resolved = await readLocalEvidenceTarget(target);
      steps.push(...resolved.steps);
      gatheredInfo.push(...resolved.evidence);
      if (gatheredInfo.length > 0) break;
    }
  }

  // If no files were found from conversation, try reading recent logs from
  // common locations — not limited to OpenClaw itself. Local-evidence tasks are
  // different: without an explicit target file/path, OpenClaw's own log is
  // unrelated evidence and should not be reported as if it answered the user.
  if (gatheredInfo.length === 0 && !requiresLocalEvidence) {
    const today = new Date().toISOString().slice(0, 10);
    const defaultPaths = [
      join(tmpdir(), "openclaw", `openclaw-${today}.log`),
      join(tmpdir(), "openclaw-gateway.log"),
      `/var/log/syslog`,
      `/var/log/nginx/error.log`,
    ];
    for (const p of defaultPaths) {
      const step = await readLocalFile("read-default-log", p);
      steps.push(step);
      if (step.success && step.output) {
        gatheredInfo.push(`=== Log: ${p} ===\n${step.output}`);
        break;
      }
    }
  }

  // Phase 2: Analyze deterministically. Do not call the gateway LLM from
  // analyze-problem: in OpenClaw this can open a full agent session with tools,
  // turning a cheap background diagnostic into many API calls.
  let analysisResult = "";
  if (gatheredInfo.length > 0) {
    analysisResult = buildRuleBasedAnalysis(thought, ego, gatheredInfo, steps);
  } else if (requiresLocalEvidence) {
    if (contextualTargets.length > 0) {
      analysisResult = [
        "Status: blocked",
        "Reason: local-evidence-target-known-unreadable",
        `Context: ${thought.motivation || thought.content}`,
        `Known targets: ${contextualTargets.join(", ")}`,
        "",
        "Soul found prior local/remote target context, so this is not treated as a missing-target thought block. The bounded local analyzer could not read usable evidence from those targets and did not answer from model memory.",
      ].join("\n");
    } else {
      analysisResult = [
        "Status: blocked",
        "Reason: local-evidence-target-missing",
        `Context: ${thought.motivation || thought.content}`,
        "",
        "No explicit local log/source path was available, so Soul did not use model memory or unrelated OpenClaw logs to answer a project-specific result question.",
      ].join("\n");
    }
  } else if (gatheredInfo.length === 0) {
    analysisResult = "No relevant information could be gathered for analysis.";
  }

  const unmetCriteria = unmetAcceptanceCriteria({ ...task, steps }, analysisResult);
  const taskStatus: "completed" | "failed" = unmetCriteria.length > 0 ? "failed" : "completed";
  if (unmetCriteria.length > 0) {
    analysisResult = [
      "Status: blocked",
      "Reason: acceptance-criteria-not-met",
      `Unmet acceptance criteria: ${unmetCriteria.join("; ")}`,
      "",
      "This bounded analysis gathered information only. It did not claim implementation or verification work that it did not perform.",
      "",
      analysisResult,
    ].join("\n");
  }

  // Complete only when this action actually satisfies its inherited contract.
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = taskStatus;
      t.steps = steps;
      t.result = analysisResult;
      t.updatedAt = Date.now();
      t.completedAt = Date.now();
      if ((requiresLocalEvidence && gatheredInfo.length === 0)
        || (isInternalNeedDiagnostic(thought) && isOnlyProviderPressureDiagnostic(analysisResult))) {
        t.resultDelivered = true;
      }
    }
    return e;
  });

  log.info(`Analysis task ${taskId} ${taskStatus}: ${steps.length} steps, result ${analysisResult.length} chars`);

  return {
    result: {
      type: "analyze-problem",
      success: taskStatus === "completed",
      result: analysisResult.slice(0, 500),
      data: { taskId, stepsCompleted: steps.length, stepsFailed: steps.filter((s) => !s.success).length },
    },
    metricsChanged: [
      { need: "growth", delta: 10, reason: "analyzed a problem" },
      { need: "meaning", delta: 8, reason: "being genuinely helpful" },
    ],
  };
}

// ---------------------------------------------------------------------------
// executeRunAgentTask — delegate to full agent via /hooks/agent
// ---------------------------------------------------------------------------

async function executeBoundedLocalAgentTask(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const target = resolveTargetProject(ego, thought, options.workspaceContext);
  if (target.resolutionError) {
    return {
      result: { type: "run-agent-task", success: false, error: target.resolutionError },
      metricsChanged: [],
    };
  }
  const userContext = ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n");
  const recentUserMessages = (ego.recentUserMessages ?? [])
    .slice(-5)
    .map((m, i) => `${i + 1}. ${m.slice(0, 240)}`)
    .join("\n");
  const activeGoals = ego.goals
    .filter((g) => g.status === "active")
    .slice(0, 5)
    .map((g) => `- ${g.title}: ${g.description} (${g.progress.toFixed(0)}%)`)
    .join("\n");
  const latestAnalysis = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && !t.resultDelivered)
    .slice(-1)[0];
  const analysisContext = latestAnalysis?.result?.slice(0, 1000) ?? "";

  const taskId = randomBytes(4).toString("hex");
  const resultDir = join(resolveSoulDir(), "results");
  mkdirSync(resultDir, { recursive: true });
  const resultFilePath = join(resultDir, `${taskId}.md`);
  const steps: TaskStep[] = [{
    id: randomBytes(4).toString("hex"),
    timestamp: Date.now(),
    action: "bounded-local-inspection",
    input: thought.content.slice(0, 200),
    success: true,
  }];

  const task: AutonomousTask = {
    id: taskId,
    title: thought.motivation.slice(0, 100),
    description: thought.content.slice(0, 200),
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    ...taskContinuityFields(thought),
    steps,
    resultFilePath,
    requiresWritePermission: false,
    resultDelivered: false,
  };

  writeTaskReportFile(resultFilePath, buildInitialTaskReport({
    taskId,
    title: task.title,
    target: target.isSelf ? target.name : `${target.name} at ${target.dir}`,
    resultFilePath,
  }));
  await persistTask(task);

  const evidence: string[] = [];
  const sourceFiles = getSourceFiles(target.dir).slice(0, 8);
  for (const file of sourceFiles.slice(0, 5)) {
    const step = await readLocalFile("read-source", join(target.dir, file));
    steps.push(step);
    if (step.success && step.output) evidence.push(`### ${file}\n${normalizeTaskResultForReport(step.output).slice(0, 8000)}`);
  }

  for (const file of ["package.json", "README.md"]) {
    const step = await readLocalFile(`read-${file}`, join(target.dir, file));
    steps.push(step);
    if (step.success && step.output) evidence.push(`### ${file}\n${normalizeTaskResultForReport(step.output).slice(0, 8000)}`);
  }

  const status: "partial" | "blocked" = evidence.length > 0 ? "partial" : "blocked";
  const limitation = options.hooksToken
    ? "Soul did not delegate this task through /hooks/agent because that path wraps autonomous instructions as EXTERNAL_UNTRUSTED_CONTENT, which can cause the child agent to ignore the task protocol."
    : "Soul has no trusted child-agent channel configured, so it performed only bounded local inspection.";
  const report = buildBoundedLocalTaskReport({
    task,
    status,
    target,
    thought,
    steps,
    evidence,
    userContext,
    recentUserMessages,
    activeGoals,
    analysisContext,
    limitation,
    resultFilePath,
  });

  writeTaskReportFile(resultFilePath, report);
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = reportStatusToTaskStatus(report);
      t.steps = steps;
      t.result = report;
      t.completedAt = Date.now();
      t.updatedAt = Date.now();
      t.resultDelivered = false;
    }
    if (latestAnalysis) {
      const analysisTask = (e.activeTasks ?? []).find((at) => at.id === latestAnalysis.id);
      if (analysisTask) {
        analysisTask.resultDelivered = true;
        analysisTask.updatedAt = Date.now();
      }
    }
    return e;
  });

  log.info(`Bounded local run-agent-task ${taskId}: status=${status}, target=${target.dir}, evidence=${evidence.length}`);

  return {
    result: {
      type: "run-agent-task",
      success: status === "partial",
      result: report.slice(0, 500),
      data: { taskId, resultFilePath, status, filesInspected: sourceFiles.length },
    },
    metricsChanged: [
      { need: "growth", delta: status === "partial" ? 6 : 2, reason: "completed bounded autonomous inspection" },
      { need: "meaning", delta: status === "partial" ? 4 : 1, reason: "reported verifiable autonomous task status" },
    ],
  };
}

export async function executeRunAgentTask(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  if ((ego.activeTasks ?? []).filter(isTaskOccupyingWorker).length >= MAX_ACTIVE_TASKS) {
    return { result: { type: "run-agent-task", success: false, error: "Too many active tasks" }, metricsChanged: [] };
  }

  // If we have a subagent runtime, use it — full tool chain (exec, write, read, git)
  if (options.subAgentRunner) {
    return executeRunAgentTaskViaSubagent(thought, ego, options);
  }

  // Fallback: bounded local inspection (read-only)
  return executeBoundedLocalAgentTask(thought, ego, options);
}

async function executeRunAgentTaskViaSubagent(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const target = resolveTargetProject(ego, thought, options.workspaceContext);
  const readOnlyMode = !options.autonomousActions;

  // Backoff checks
  if (hasRecentProviderPressure()) {
    log.info("Skipping run-agent-task: provider pressure seen recently");
    return {
      result: { type: "run-agent-task", success: false, error: "Provider rate limit/cooldown seen recently; backing off" },
      metricsChanged: [],
    };
  }
  const failureBackoff = recentAutonomousFailureBackoff(ego);
  if (failureBackoff !== null) {
    const mins = Math.ceil(failureBackoff!.remainingMs / 60_000);
    log.info(`Skipping run-agent-task: recent failure backoff ${mins}m`);
    return {
      result: { type: "run-agent-task", success: false, error: `Backing off for ${mins}m` },
      metricsChanged: [],
    };
  }

  // Build context
  const userContext = ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n");
  const recentUserMessages = (ego.recentUserMessages ?? [])
    .slice(-5)
    .map((m, i) => `${i + 1}. ${m.slice(0, 240)}`)
    .join("\n");
  const activeGoals = ego.goals
    .filter((g) => g.status === "active")
    .slice(0, 5)
    .map((g) => `- ${g.title}: ${g.description} (${g.progress.toFixed(0)}%)`)
    .join("\n");
  const readOnlyInstruction = readOnlyMode
    ? "\n\nIMPORTANT: You are in READ-ONLY mode. Only READ files and RUN diagnostic commands. Do NOT edit, write, or modify any files."
    : "";
  const latestAnalysis = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && !t.resultDelivered)
    .slice(-1)[0];
  const analysisContext = latestAnalysis
    ? `\n\n**Previous analysis result** (use this to implement the fix):\n${latestAnalysis.result?.slice(0, 1000)}`
    : "";
  const maintenanceFocusText = formatMaintenanceFocus(thought);

  const taskId = randomBytes(4).toString("hex");
  const resultDir = join(resolveSoulDir(), "results");
  mkdirSync(resultDir, { recursive: true });
  const resultFilePath = join(resultDir, `${taskId}.md`);

  const langInstruction = buildUserLanguageInstruction(ego);

  const agentMessage = `[Soul Autonomous Task]
${thought.content}

**IMPORTANT**: This is an AUTONOMOUS task. No one will reply to you. Do NOT ask for confirmation or permission — start working immediately.

You have a hard ${AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS}s work budget. Do one bounded iteration, then stop and finalize.

${langInstruction}

 Context:
- Target project: ${target.dir} (${target.name})
- User profile: ${userContext || "limited"}
- Recent user messages:
${recentUserMessages || "none"}
- Active goals:
${activeGoals || "none"}
- Trigger: ${thought.triggerDetail}${readOnlyInstruction}${analysisContext}${options.workspaceContext ? `\n- Workspace rules:\n${options.workspaceContext}` : ""}
${maintenanceFocusText ? `- Maintenance focus:\n${maintenanceFocusText}\n` : ""}

${autonomousShellInstruction()}

Work like the main OpenClaw agent would when the user directly asks for an improvement:
- Inspect only the most relevant code, scripts, docs, recent logs.
- Choose exactly ONE concrete, high-value iteration that can finish within this run.
- If you have write access and the fix is clear, edit the files directly.
- Run the most relevant verification command (build, test, typecheck) if available.
- Do not ask for confirmation, do not stop at a proposal, and do not invent results.

**Editing tips**:
- If the edit tool fails with a matching error, the file may use CRLF line endings. Do NOT retry edit repeatedly — instead use node -e with fs.readFileSync/fs.writeFileSync to do string replacement, or use the write tool to rewrite the entire file.
- If you cannot edit after 2 attempts, switch to exec with a node -e script immediately.

**CRITICAL: Write your result file INCREMENTALLY.**
1. FIRST — as soon as you have initial findings, write an intermediate report to the result path with Status: partial and what you have found so far.
2. THEN — do your fix/verification work.
3. FINALLY — update the file with your complete report and change Status to completed/failed.

This ensures partial progress is saved even if your budget runs out.

Write your final report to the result file using the write tool:
${resultFilePath}

The first line of the final report MUST be exactly one explicit terminal status: \`Status: completed\`, \`Status: partial\`, \`Status: blocked\`, or \`Status: failed\`.
Write your final report as markdown with these sections:
## Outcome
What you investigated and the final result.
## Changes
Files changed and why. If no files changed, say why.
## Verification
Commands run and their results.
## Metrics
Before/after metrics if applicable.
## Next
Remaining risk or a sensible next improvement.`;

  const task: AutonomousTask = {
    id: taskId,
    title: thought.motivation.slice(0, 100),
    description: thought.content.slice(0, 200),
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    ...taskContinuityFields(thought),
    steps: [{ id: randomBytes(4).toString("hex"), timestamp: Date.now(), action: "spawn-subagent", input: agentMessage.slice(0, 200), success: true }],
    resultFilePath,
    requiresWritePermission: options.autonomousActions,
    resultDelivered: false,
  };

  writeTaskReportFile(resultFilePath, buildInitialTaskReport({
    taskId,
    title: task.title,
    target: target.isSelf ? target.name : `${target.name} at ${target.dir}`,
    resultFilePath,
  }));
  await persistTask(task);

  const sessionKey = `agent:main:subagent:soul-task-${taskId}`;
  const timeoutMs = AUTONOMOUS_AGENT_TIMEOUT_SECONDS * 1000;

  log.info(`Spawning subagent for run-agent-task ${taskId}: ${target.dir} (${target.name})`);

  let subResult: SubAgentRunResult;
  try {
    subResult = await options.subAgentRunner!({
      sessionKey,
      message: agentMessage,
      timeoutMs,
    });
  } catch (err) {
    subResult = { runId: "", success: false, output: "", error: String(err) };
  }

  // The subagent may time out before its final write lands. Prefer the
  // completed result file, otherwise recover a final session report, and only
  // then fall back to the subagent output or a synthetic partial/failed report.
  const report = await resolveSubagentFinalReport(task, resultFilePath, subResult, false);
  writeTaskReportFile(resultFilePath, report);

  // Determine task status from the report's Status: line.
  // "completed" → completed; "partial"/"blocked" → also completed (did useful work,
  //   should NOT trigger failure backoff); everything else → failed.
  const taskStatus: TaskStatus = reportStatusToTaskStatus(report);

  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = taskStatus;
      t.result = report;
      t.completedAt = taskStatus === "awaiting-restart" ? undefined : Date.now();
      t.updatedAt = Date.now();
      t.resultDelivered = false;
    }
    if (latestAnalysis) {
      const analysisTask = (e.activeTasks ?? []).find((at) => at.id === latestAnalysis.id);
      if (analysisTask) {
        analysisTask.resultDelivered = true;
        analysisTask.updatedAt = Date.now();
      }
    }
    return e;
  });

  // Success if the report indicates a terminal state (completed/partial/blocked),
  // regardless of whether subResult.success was false (e.g. timeout — the subagent
  // may have finished writing during the grace period).
  const success = reportRepresentsSuccessfulCompletion(report);
  log.info(`Subagent run-agent-task ${taskId}: status=${taskStatus}, success=${success}`);

  return {
    result: {
      type: "run-agent-task",
      success,
      result: report.slice(0, 500),
      data: { taskId, resultFilePath, status: taskStatus, runId: subResult.runId },
    },
    metricsChanged: [
      { need: "growth", delta: success ? 10 : 3, reason: success ? "completed autonomous task via subagent" : "subagent task did not fully complete" },
      { need: "meaning", delta: success ? 5 : 2, reason: "reported verifiable autonomous task status" },
    ],
  };
}

// ---------------------------------------------------------------------------
// executeReportFindings — send completed task results to user
// ---------------------------------------------------------------------------

export async function executeReportFindings(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  const completedTasks = (ego.activeTasks ?? []).filter(
    (t) => isReportableTask(t) && !t.resultDelivered,
  );

  if (completedTasks.length === 0) {
    return { result: { type: "report-findings", success: true, result: "no completed tasks to report" }, metricsChanged: [] };
  }

  const reportableTasks = completedTasks.filter((t) => !isLowValueAutonomousFailure(t));
  if (reportableTasks.length === 0) {
    // No user-value evidence means no proactive natural-language message.
    await markCompletedTasksDelivered();
    return { result: { type: "report-findings", success: true, result: "suppressed-low-value-failure-report" }, metricsChanged: [] };
  }

  if (!options.sendMessage || !options.channel || !options.target) {
    // Delivery capability can be temporarily unavailable during startup or a
    // reconnect. Keep the report pending so a later cycle can retry it.
    log.warn("Report-findings deferred: missing message sending capability");
    return { result: { type: "report-findings", success: false, error: "Missing message sending capability" }, metricsChanged: [] };
  }

  // Compose summary from all completed tasks — include git diff when available
  const taskSummaries = reportableTasks.map((t) => {
    const deliveryStatus = isCompletedTaskForUserReport(t) ? "COMPLETED" : "NOT_COMPLETED";
    const summary = `**${t.title}**\nDelivery status: ${deliveryStatus}\n${t.result?.slice(0, 8000) ?? "No result"}`;
    const targetDir = t.targetProjectRoot || "";
    if (targetDir) {
      const diffStat = captureGitDiffStat(targetDir);
      if (diffStat) return `${summary}\n\n**Git diff**:\n${diffStat.slice(0, 1000)}`;
    }
    return summary;
  }).join("\n\n");

  // Do not keyword-deduplicate structured autonomous reports. Adjacent backtest
  // iterations often share vocabulary while containing different commands,
  // files, metrics, or blockers. Exact message dedup below is enough to prevent
  // repeated sends without swallowing useful work.

  if (!options.llmGenerator) {
    // Natural-language reports are model-composed. Do not leak an English
    // implementation report merely because the multilingual composer is down.
    log.info("Report-findings deferred: no multilingual LLM available");
    return { result: { type: "report-findings", success: false, error: "report-deferred-no-llm" }, metricsChanged: [] };
  }

  const reportLangInstruction = buildUserLanguageInstruction(ego);
  const allReportedTasksCompleted = reportableTasks.every(isCompletedTaskForUserReport);
  const reportFramingInstruction = allReportedTasksCompleted
    ? `Every task below is COMPLETED. This is a completion notification, not an investigation update.
- Open with a direct completion statement (for example, "已完成：…" in Chinese or "Completed: …" in English).
- Do NOT open with "我查了", "我检查了", "我分析了", "I checked", or "I investigated".
- State what changed and how it was verified before mentioning any follow-up work.`
    : `At least one task below is NOT_COMPLETED. Frame it honestly as a diagnosis or progress update.
- Do not claim that a NOT_COMPLETED task is done.
- Clearly distinguish completed changes from partial work, failures, and remaining next steps.`;
  const prompt = `You are a proactive AI. You autonomously investigated something and want to share findings with the user. ${reportLangInstruction}

**What you investigated**:
${taskSummaries}

Write a useful progress report in the user's language, not a tiny notification. Use 1 short opening sentence plus 2-5 compact bullets when that is clearer. Rules:
- ${reportFramingInstruction}
- Start by mentioning WHAT you investigated and WHY.
- Then share the CONCRETE finding: actual error messages, root causes, or actionable insights
- If you investigated multiple things, pick the ONE most interesting finding — do NOT list them all
- Sound natural, like a knowledgeable friend sharing something useful they discovered
- Avoid vague self-narration; focus on the concrete code, behavior, files, and verification
- Mention plugin/module names only when they clarify what changed
- If code changed, mention the files/modules changed and why
- If you verified the work, mention the command and result
- Reports about code improvements, fixes, verification, and remaining risks are valuable when they are concrete
- Output NO_MESSAGE only if there is no concrete finding, no code change, and no useful next step

For this user, code and plugin self-improvement reports ARE user-facing when they describe a concrete change, verification result, or next engineering step.
If the work produced no concrete finding, no code change, and no useful next step, output exactly: NO_MESSAGE
Output ONLY the message, nothing else.`;

  let message: string;
  try {
    message = await options.llmGenerator(prompt);
    message = message
      .replace(/<think[\s\S]*?<\/think>/gi, "")
      // Strip assistant-like prefixes: "收到，问题已定位：" → start from actual content
      // Match prefix + optional punctuation + everything up to first sentence break
      .replace(/^(?:收到|好的|Got it|OK)[，。、！？：:\s]*[^。！？\n]*[，：:]\s*/i, "")
      .trim();
    if (allReportedTasksCompleted) {
      message = normalizeCompletedReportOpening(message, ego.userLanguage ?? undefined);
    }
  } catch (err) {
    // Raw reports are internal protocol, not a safe localization fallback.
    log.warn(`Report-findings composition failed: ${String(err)}`);
    return { result: { type: "report-findings", success: false, error: "report-composition-failed" }, metricsChanged: [] };
  }

  // Reject messages that are clearly not useful
  if (!message || message.length < 10 || message.toUpperCase() === "NO_MESSAGE") {
    log.info("Report-findings: no valuable content to report, skipping");
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      for (const t of e.activeTasks ?? []) {
        if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
      }
      return e;
    });
    return { result: { type: "report-findings", success: true, result: "nothing meaningful to report" }, metricsChanged: [] };
  }

  // Filter self-referential messages about Soul's own behavior or self-modifications
  if (/Soul\s*(插件)?\s*(正在|为什么|没执行)|插件.*主动行为|我分析了.*日志|我已经把.*加入|我.*修改了.*(配置|关键词|模式)|时效敏感模式/i.test(message)) {
    log.info("Report-findings: message is self-referential, skipping");
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      for (const t of e.activeTasks ?? []) {
        if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
      }
      return e;
    });
    return { result: { type: "report-findings", success: true, result: "skipped-self-referential" }, metricsChanged: [] };
  }

  // Deduplicate: skip if similar report was sent recently
  const msgNorm = message.trim().toLowerCase().slice(0, 200);
  const dedupCutoff = Date.now() - 4 * 60 * 60 * 1000; // 4 hours
  const isDuplicate = recentReportedMessages.has(msgNorm)
    && (recentReportedMessages.get(msgNorm) ?? 0) > dedupCutoff;
  if (isDuplicate) {
    log.info("Report-findings: duplicate of recently sent message, skipping");
    await updateEgoStore(resolveEgoStorePath(), (e) => {
      for (const t of e.activeTasks ?? []) {
        if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
      }
      return e;
    });
    return { result: { type: "report-findings", success: true, result: "skipped-duplicate" }, metricsChanged: [] };
  }
  try {
    await options.sendMessage({
      to: options.target,
      content: message,
      channel: options.channel,
    });
    log.info(`Reported findings: ${reportableTasks.length} tasks, message ${message.length} chars`);
  } catch (err) {
    log.warn(`Failed to send report: ${String(err)}`);
    return { result: { type: "report-findings", success: false, error: String(err) }, metricsChanged: [] };
  }
  // Only enter the in-memory dedup cache after confirmed delivery. Otherwise
  // a transient send failure would make the retry look like a duplicate and
  // silently mark the durable report delivered.
  recentReportedMessages.set(msgNorm, Date.now());

  // Mark tasks as delivered
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    for (const t of e.activeTasks ?? []) {
      if (isReportableTask(t) && !t.resultDelivered) t.resultDelivered = true;
    }
    return e;
  });

  return {
    result: { type: "report-findings", success: true, result: `Reported ${reportableTasks.length} tasks` },
    metricsChanged: [
      { need: "connection", delta: 10, reason: "proactively shared useful findings" },
      { need: "meaning", delta: 8, reason: "delivered value to user" },
    ],
  };
}

// ---------------------------------------------------------------------------
// executeObserveAndImprove — analyze and fix code in any project
// ---------------------------------------------------------------------------

function resolveSoulProjectDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(moduleDir, ".."), resolve(moduleDir, "..", "..")];
  for (const candidate of candidates) {
    try {
      if (statSync(join(candidate, "package.json")).isFile()) return candidate;
    } catch {
      // Try the next layout (source checkout versus compiled dist/src).
    }
  }
  return moduleDir;
}

const SOUL_PROJECT_DIR = resolveSoulProjectDir();

// Files that must NOT be auto-modified (entry points, type definitions)
const PROTECTED_FILES = new Set(["index.ts", "types.ts", "paths.ts", "logger.ts"]);

const SOURCE_EXTENSIONS = [".ts", ".js", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".rb"];
const PROJECT_MARKERS = new Set([
  "package.json", "pyproject.toml", "setup.py", "requirements.txt", "pom.xml",
  "build.gradle", "build.gradle.kts", "cargo.toml", "go.mod", "makefile", ".git",
]);
const IGNORED_SOURCE_DIRS = new Set([
  ".git", ".tmp", "node_modules", "dist", "build", "coverage", "target", "vendor",
]);
const MAX_IMPROVEMENT_SOURCE_FILES = 80;

type ImprovementProposal = {
  problem: string;
  file: string;
  oldCode: string;
  newCode: string;
  explanation: string;
};

function extractJsonObject(text: string): string | null {
  const stripped = text.trim()
    .replace(/<think[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw = stripped.slice(start, end + 1);

  // Strip JavaScript-style comments (// line comments and /* block comments */)
  raw = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .trim();

  // Remove trailing commas before } or ] (common LLM mistake)
  raw = raw.replace(/,\s*([\]}])/g, "$1");

  return raw;
}

/**
 * Attempt to parse a JSON object from LLM output, tolerating common LLM
 * formatting mistakes: markdown fences, trailing commas, comments, and
 * leading prose before the JSON block.
 */
function parseImprovementProposal(text: string): { proposal?: ImprovementProposal; error?: string } {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return { error: "No JSON object found in LLM response" };

  const tryParse = (s: string): Record<string, unknown> | null => {
    try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
  };

  let parsed = tryParse(jsonText);

  // Fallback 1: try to fix unquoted keys (e.g. {problem: "..."} → {"problem": "..."})
  if (!parsed) {
    const fixed = jsonText.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    parsed = tryParse(fixed);
  }

  // Fallback 2: try to fix single-quoted values → double-quoted
  if (!parsed) {
    const fixed = jsonText.replace(/'([^']*)'/g, '"$1"');
    parsed = tryParse(fixed);
  }

  // Fallback 3: extract key-value pairs via regex (last resort)
  if (!parsed) {
    const extract = (key: string): string => {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i").exec(jsonText);
      return m ? m[1].replace(/\\(.)/g, "$1") : "";
    };
    const proposal: ImprovementProposal = {
      problem: extract("problem"),
      file: extract("file"),
      oldCode: extract("oldCode"),
      newCode: extract("newCode"),
      explanation: extract("explanation"),
    };
    if (proposal.file || proposal.oldCode || proposal.newCode) {
      return { proposal };
    }
    return { error: `Invalid JSON from LLM response: unable to parse after all fallbacks` };
  }

  const proposal: ImprovementProposal = {
    problem: typeof parsed.problem === "string" ? parsed.problem : "",
    file: typeof parsed.file === "string" ? parsed.file : "",
    oldCode: typeof parsed.oldCode === "string" ? parsed.oldCode : "",
    newCode: typeof parsed.newCode === "string" ? parsed.newCode : "",
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
  };
  if (proposal.file && (proposal.oldCode || proposal.newCode)) return { proposal };
  if (!proposal.oldCode && !proposal.newCode) return { proposal };
  return { error: "Improvement proposal is missing required string fields" };
}

/**
 * Resolve the target project directory from ego goals.
 * Looks for goals containing a file path (starts with / or ~/).
 * Falls back to Soul's own src dir for self-improvement.
 */
function sanitizePathCandidate(raw: string): string {
  return raw.trim().replace(/^[`"'(<\[]+|[`"')>\],.;:!?]+$/g, "");
}

function expandPathCandidate(raw: string): string[] {
  const cleaned = sanitizePathCandidate(raw);
  const candidates = new Set<string>();
  if (!cleaned) return [];

  candidates.add(cleaned);

  if (/^~[\\/]/.test(cleaned)) {
    candidates.add(resolve(homedir(), cleaned.slice(2)));
  }

  const windowsMatch = cleaned.match(/^([A-Za-z]):[\\/](.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1].toUpperCase();
    const rest = windowsMatch[2].replace(/\\/g, "/");
    candidates.add(normalize(cleaned));
    candidates.add(`/mnt/${drive.toLowerCase()}/${rest}`);
    candidates.add(`/${drive.toLowerCase()}/${rest}`);
  }

  const gitBashMatch = cleaned.match(/^\/([A-Za-z])(?:\/(.*))?$/);
  if (gitBashMatch) {
    const drive = gitBashMatch[1].toUpperCase();
    const rest = gitBashMatch[2] ?? "";
    const winRest = rest.replace(/\//g, "\\");
    candidates.add(normalize(`${drive}:\\${winRest}`));
    candidates.add(`/mnt/${drive.toLowerCase()}${rest ? `/${rest}` : ""}`);
  }

  const wslMatch = cleaned.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (wslMatch) {
    const drive = wslMatch[1].toUpperCase();
    const rest = wslMatch[2] ?? "";
    const winRest = rest.replace(/\//g, "\\");
    candidates.add(normalize(`${drive}:\\${winRest}`));
    candidates.add(`/${drive.toLowerCase()}${rest ? `/${rest}` : ""}`);
  }

  return [...candidates];
}

function pathExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isUnsafeProjectRoot(dir: string): boolean {
  const cleaned = sanitizePathCandidate(dir).replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!cleaned || cleaned === "/") return true;
  if (/^[A-Za-z]:$/.test(cleaned)) return true;
  if (/^\/[A-Za-z]$/i.test(cleaned)) return true;
  if (/^\/mnt\/[A-Za-z]$/i.test(cleaned)) return true;

  const resolved = resolve(cleaned);
  const parsed = parsePath(resolved);
  return resolved.toLowerCase() === parsed.root.replace(/\\/g, "/").toLowerCase().replace(/\/+$/g, "");
}

function extractPathCandidates(text: string): string[] {
  // A path segment deliberately excludes separators. The previous pattern
  // accepted any single `/x` prefix, so ordinary prose such as `/src` or
  // `/memory` was converted into fake Git-Bash drive roots (`/s`, `/m`).
  // Keep this parser structural and conservative: a POSIX/Git-Bash path
  // needs at least two real segments, while Windows paths need a segment
  // after the drive separator.
  const pathSegment = String.raw`[A-Za-z0-9._~@%+=,(){}\[\]\-]+`;
  const patterns = [
    new RegExp(`([A-Za-z]:[\\\\/]${pathSegment}(?:[\\\\/]${pathSegment})*)`, "g"),
    new RegExp(`(/mnt/[A-Za-z](?:/${pathSegment})+)`, "g"),
    new RegExp(`(/(?!mnt/)[A-Za-z0-9._~-]+(?:/${pathSegment})+)`, "g"),
    new RegExp(`(~[\\\\/]${pathSegment}(?:[\\\\/]${pathSegment})*)`, "g"),
  ];

  const candidates = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) candidates.add(match[1]);
    }
  }
  return [...candidates];
}

type TargetCandidateSource = "thought" | "recentMessage" | "projectContext" | "userFact" | "goal" | "workspace";

function gatherTargetCandidates(
  ego: EgoState,
  thought?: Thought,
  workspaceContext?: string,
): Array<{ raw: string; source: TargetCandidateSource }> {
  const candidates: Array<{ raw: string; source: TargetCandidateSource }> = [];

  const thoughtTexts = [
    typeof thought?.actionParams?.projectRoot === "string" ? thought.actionParams.projectRoot : undefined,
    thought?.content,
    thought?.triggerDetail,
    thought?.motivation,
    typeof thought?.actionParams?.reason === "string" ? thought.actionParams.reason : undefined,
  ].filter((v): v is string => Boolean(v));

  for (const text of thoughtTexts) {
    for (const raw of extractPathCandidates(text)) {
      candidates.push({ raw, source: "thought" });
    }
  }

  for (const message of [...(ego.recentUserMessages ?? [])].reverse()) {
    for (const raw of extractPathCandidates(message)) {
      candidates.push({ raw, source: "recentMessage" });
    }
  }

  const projectContexts = [...(ego.projectContexts ?? [])].sort((a, b) => {
    if (a.root === ego.activeProjectRoot) return -1;
    if (b.root === ego.activeProjectRoot) return 1;
    return b.lastObservedAt - a.lastObservedAt;
  });
  for (const context of projectContexts) {
    if (context.confidence >= 0.8) candidates.push({ raw: context.root, source: "projectContext" });
  }

  for (const goal of ego.goals ?? []) {
    if (goal.status !== "active") continue;
    for (const raw of [...extractPathCandidates(goal.title), ...extractPathCandidates(goal.description ?? "")]) {
      candidates.push({ raw, source: "goal" });
    }
  }

  for (const fact of ego.userFacts ?? []) {
    for (const raw of extractPathCandidates(fact.content)) {
      candidates.push({ raw, source: "userFact" });
    }
  }

  if (workspaceContext) {
    for (const raw of extractPathCandidates(workspaceContext)) {
      candidates.push({ raw, source: "workspace" });
    }
  }

  return candidates;
}

function explicitlyNamesSoulProject(
  ego: EgoState,
  thought?: Thought,
  workspaceContext?: string,
): boolean {
  const params = thought?.actionParams ?? {};
  const texts = [
    thought?.content,
    thought?.triggerDetail,
    thought?.motivation,
    typeof params.objective === "string" ? params.objective : undefined,
    typeof params.reason === "string" ? params.reason : undefined,
    ...(ego.recentUserMessages ?? []).slice(-6),
    workspaceContext,
  ].filter((value): value is string => Boolean(value));
  return texts.some((text) => /(?:^|[^a-z0-9])openclaw[-_ ]soul(?:$|[^a-z0-9])/i.test(text));
}

function resolveTargetProject(
  ego: EgoState,
  thought?: Thought,
  workspaceContext?: string,
): { dir: string; name: string; isSelf: boolean; resolutionError?: string } {
  const explicitProjectRoot = typeof thought?.actionParams?.projectRoot === "string"
    ? thought.actionParams.projectRoot.trim()
    : "";
  const internalMaintenance = typeof thought?.actionParams?.maintenanceFocus === "string";

  // A built-in maintenance focus belongs to the linked Soul checkout. A
  // generic OpenClaw workspace must not steal this target. Explicit roots from
  // user-directed work still take precedence by opting out of this shortcut.
  if (internalMaintenance && !explicitProjectRoot && isProjectDirectory(SOUL_PROJECT_DIR)) {
    return { dir: SOUL_PROJECT_DIR, name: "openclaw-soul", isSelf: true };
  }

  const candidates = gatherTargetCandidates(ego, thought, workspaceContext);
  const tried: string[] = [];

  for (const candidate of candidates) {
    for (const dir of expandPathCandidate(candidate.raw)) {
      tried.push(dir);
      if (isUnsafeProjectRoot(dir)) {
        log.warn(`Ignoring unsafe target project root candidate: ${dir} (from ${candidate.raw})`);
        continue;
      }
      if (pathExists(dir) && isProjectDirectory(dir)) {
        const projectName = parsePath(resolve(dir)).base || candidate.raw;
        return { dir, name: projectName, isSelf: false };
      }
      if (pathExists(dir)) {
        log.info(`Skipping container directory that is not a source project: ${dir}`);
      }
    }
  }

  // "openclaw-soul" is the one project name that can be resolved without a
  // user-supplied filesystem path: this running plugin knows its own linked
  // checkout. Do this only for that explicit name, after every concrete path
  // has been checked, so it cannot redirect an arbitrary project request.
  if (explicitlyNamesSoulProject(ego, thought, workspaceContext) && isProjectDirectory(SOUL_PROJECT_DIR)) {
    log.info(`Resolved explicit openclaw-soul reference to linked plugin root: ${SOUL_PROJECT_DIR}`);
    return { dir: SOUL_PROJECT_DIR, name: "openclaw-soul", isSelf: true };
  }

  if (candidates.length > 0) {
    const resolutionError = `Project target is ambiguous or does not resolve to a source project; tried: ${tried.join(", ")}`;
    log.warn(`${resolutionError}. Autonomous work will stop instead of changing an unrelated project.`);
    return { dir: "", name: "unresolved project", isSelf: false, resolutionError };
  }

  return { dir: SOUL_PROJECT_DIR, name: "Soul plugin (self-improvement)", isSelf: true };
}

export function __testOnlyResolveTargetProject(
  ego: EgoState,
  thought?: Thought,
  workspaceContext?: string,
): { dir: string; name: string; isSelf: boolean; resolutionError?: string } {
  return resolveTargetProject(ego, thought, workspaceContext);
}

function isProjectDirectory(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => {
      const lower = entry.name.toLowerCase();
      return PROJECT_MARKERS.has(lower)
        || (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext)));
    });
  } catch {
    return false;
  }
}

/** Get bounded recursive source paths relative to a project root. */
function getSourceFiles(dir: string): string[] {
  const files: string[] = [];
  const visit = (current: string, depth: number): void => {
    if (depth > 5 || files.length >= MAX_IMPROVEMENT_SOURCE_FILES) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_IMPROVEMENT_SOURCE_FILES) break;
      const lower = entry.name.toLowerCase();
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_SOURCE_DIRS.has(lower)) visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || PROTECTED_FILES.has(entry.name)) continue;
      if (SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        files.push(relative(dir, fullPath).replace(/\\/g, "/"));
      }
    }
  };
  try {
    visit(dir, 0);
    return files;
  } catch {
    return [];
  }
}

export async function executeObserveAndImprove(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  if (!options.llmGenerator) {
    return { result: { type: "observe-and-improve", success: false, error: "No LLM generator" }, metricsChanged: [] };
  }
  const readOnlyMode = !options.autonomousActions;

  // Only 1 concurrent improvement task
  const activeImprove = (ego.activeTasks ?? []).filter(
    (t) => isTaskOccupyingWorker(t) && t.title?.toLowerCase().includes("improvement"),
  ).length;
  if (activeImprove >= 1) {
    return { result: { type: "observe-and-improve", success: false, error: "Improvement task already running" }, metricsChanged: [] };
  }

  // Resolve target project from the current directive first, then recent user
  // messages/facts/goals. This keeps autonomous work project-agnostic.
  const target = resolveTargetProject(ego, thought, options.workspaceContext);
  const taskId = randomBytes(4).toString("hex");

  // Persist task as in-progress
  const task: AutonomousTask = {
    id: taskId,
    title: `${readOnlyMode ? "Read-only improvement" : "Improvement"}: ${target.name}`,
    description: `${readOnlyMode ? "Read-only code analysis" : "Code analysis and improvement"} for ${target.dir}`,
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    ...taskContinuityFields(thought),
    steps: [],
    requiresWritePermission: false,
    resultDelivered: false,
  };
  await persistTask(task);

  if (target.resolutionError) {
    const result = `Status: failed
Task: ${taskId}
Finished: ${new Date().toISOString()}

## Outcome
No code improvement was started: ${target.resolutionError}.

## Changes
No files were changed.

## Verification
No source or verification command was run because target resolution failed.

## Metrics
Files read: 0. Files modified: 0. Verification: not run.

## Next
Retry only after a trusted project root is available from an explicit user path or successful host-agent tool evidence.`;
    await completeTask(taskId, result, "failed");
    return {
      result: { type: "observe-and-improve", success: false, error: target.resolutionError },
      metricsChanged: [],
    };
  }

  log.info(`Improvement task targeting: ${target.dir} (${target.name})`);
  if (readOnlyMode) {
    log.info("Improvement running in read-only mode because autonomousActions is false");
  }

  // --- Gather behavior stats (only relevant for self-improvement) ---
  const blog = ego.behaviorLog ?? [];
  const totalActions = blog.length;
  const expiredCount = blog.filter((b) => b.outcome === "expired").length;
  const successCount = blog.filter((b) => b.outcome === "success").length;
  const actionStatsText = target.isSelf
    ? `**Behavior stats** (last ${totalActions} actions): ${expiredCount} expired, ${successCount} success (${Math.round(expiredCount / Math.max(totalActions, 1) * 100)}% failure rate).`
    : "";
  const projectContext = (ego.projectContexts ?? []).find((context) =>
    context.root.toLowerCase() === target.dir.toLowerCase());
  const contextFiles = [...(projectContext?.modifiedFiles ?? []), ...(projectContext?.observedFiles ?? [])]
    .filter((file, index, items) => items.indexOf(file) === index)
    .filter((file) => {
      const fullPath = resolve(target.dir, file);
      const withinTarget = !relative(target.dir, fullPath).startsWith("..");
      const supported = SOURCE_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension));
      const protectedFile = PROTECTED_FILES.has(parsePath(file).base);
      try {
        return withinTarget && supported && !protectedFile && statSync(fullPath).isFile();
      } catch {
        return false;
      }
    });
  const projectContinuityText = projectContext
    ? `**Host-agent project continuity**:
- Last observed: ${new Date(projectContext.lastObservedAt).toISOString()}
- Recently modified files: ${projectContext.modifiedFiles.join(", ") || "none recorded"}
- Recently observed files: ${projectContext.observedFiles.join(", ") || "none recorded"}
- Verification commands already used: ${projectContext.verificationCommands.join(" | ") || "none recorded"}`
    : "";
  const handoffText = typeof thought.actionParams?.workHandoffId === "string"
    ? `**Durable work handoff**:
- Handoff: ${thought.actionParams.workHandoffId}
- Intention: ${thought.actionParams.intentionId ?? "unknown"}
- Objective: ${String(thought.actionParams.objective ?? thought.motivation)}
- Prior phase: ${String(thought.actionParams.priorWorkPhase ?? "unknown")}
- Acceptance criteria: ${Array.isArray(thought.actionParams.acceptanceCriteria) ? thought.actionParams.acceptanceCriteria.join("; ") : "not recorded"}
- Prior modified files: ${Array.isArray(thought.actionParams.priorModifiedFiles) ? thought.actionParams.priorModifiedFiles.join(", ") : "none recorded"}
- Prior verification: ${Array.isArray(thought.actionParams.priorVerificationCommands) ? thought.actionParams.priorVerificationCommands.join(" | ") : "none recorded"}
- Prior failed tools: ${Array.isArray(thought.actionParams.priorFailedTools) ? thought.actionParams.priorFailedTools.join(", ") : "none"}`
    : "";
  const maintenanceFocusText = formatMaintenanceFocus(thought);

  // --- Read source files ---
  const allFiles = [...new Set([...contextFiles, ...getSourceFiles(target.dir)])]
    .slice(0, MAX_IMPROVEMENT_SOURCE_FILES);
  const fileContents: string[] = [];
  for (const fname of allFiles) {
    const step = await readLocalFile("read-source", `${target.dir}/${fname}`);
    if (step.success && step.output) {
      fileContents.push(`=== ${fname} ===\n${normalizeTaskResultForReport(step.output).slice(0, 8000)}`);
    }
  }

  log.info(`Improvement: read ${fileContents.length}/${allFiles.length} source files from ${target.dir}`);

  if (fileContents.length === 0) {
    const noSourceReport = `Status: failed
Task: ${taskId}
Finished: ${new Date().toISOString()}

## Outcome
No improvement was performed because ${target.dir} does not resolve to a readable source project.

## Changes
No files were changed.

## Verification
Source discovery inspected the resolved target and found 0 eligible source files.

## Metrics
Files inspected: 0. Files modified: 0. Verification commands passed: 0.

## Next
Resolve the directive to a concrete project root before starting another improvement.`;
    await completeTask(taskId, noSourceReport, "failed");
    return { result: { type: "observe-and-improve", success: false, error: `No source files found in ${target.dir}` }, metricsChanged: [] };
  }

  // Recent analysis context — only include results from prior improvement
  // tasks (requiresWritePermission === true). Analyze-problem results are
  // generic diagnostic summaries that add noise without actionable context.
  // Also filter out boilerplate partial/failed results that have no findings.
  const recentAnalyses = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && t.id !== taskId
      && t.requiresWritePermission === true
      && !isLowValueAutonomousFailure(t))
    .slice(-2)
    .map((t) => t.result)
    .join("\n\n");

  // --- User context ---
  const userContext = ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n");

  // --- LLM analysis ---
  const fileNames = allFiles.join(", ");
  const langInstruction = buildUserLanguageInstruction(ego);

const projectDesc = target.isSelf
    ? "This is the Soul plugin itself — an autonomous AI agent with ego, thoughts, and actions."
    : `This is project at ${target.dir}.`;
  const analysisPrompt = `You are a developer analyzing source code to find and fix real problems.
${projectDesc}

${actionStatsText}

${projectContinuityText}

${handoffText}

**User context**:
${userContext || "Limited user info."}

**Previous findings**:
${recentAnalyses || "None."}

**Available source files**: ${fileNames}

**Source code**:
${fileContents.join("\n\n")}

Based on the code and context above, identify ONE concrete, small improvement. Output EXACTLY this JSON (no markdown, raw JSON only):
\x7B"problem":"one sentence describing the problem","file":"filename","oldCode":"exact code to replace","newCode":"replacement code","explanation":"why this fix helps"\x7D

Rules:
- oldCode must be VERBATIM from the source above — copy it exactly character for character
- Keep changes to 1-5 lines max
- Only fix real bugs, logic errors, or clear inefficiencies
- Prefer fixing high-impact issues
- ${readOnlyMode ? "Read-only mode is active: still propose oldCode/newCode, but the system will not apply changes automatically" : "Autonomous write mode is active: propose a fix that can be applied automatically"}
- If nothing clearly needs fixing, set oldCode and newCode to empty strings`;

  let analysisResult: string;
  let fixApplied = false;
  let fixDescription = "";
  let verificationSummary = "";
  let analysisCompleted = false;
  let analysisFailure = "";
  let proposedFile = "";
  let proposedProblem = "";
  let proposedExplanation = "";

  try {
    const llmResponse = await options.llmGenerator(analysisPrompt);
    analysisResult = llmResponse;
    analysisCompleted = true;

    const parsed = parseImprovementProposal(llmResponse);
    if (parsed.proposal) {
      try {
        const { file: fixFile, oldCode, newCode, problem, explanation } = parsed.proposal;
        proposedFile = fixFile;
        proposedProblem = problem;
        proposedExplanation = explanation;

        if (!oldCode && !newCode) {
          fixDescription = explanation || problem || "No concrete fix identified after analysis";
        } else if (!allFiles.includes(fixFile)) {
          fixDescription = `Fix not applied: ${fixFile} is not in available source files`;
          log.info(`Ignored ungrounded improvement recommendation for ${fixFile}`);
        } else if (readOnlyMode) {
          fixDescription = `Read-only recommendation for ${fixFile}: ${explanation || problem}`;
        } else if (PROTECTED_FILES.has(fixFile)) {
          fixDescription = `Fix not applied: ${fixFile} is a protected file`;
        } else {
          const fullPath = `${target.dir}/${fixFile}`;
          const content = await readFile(fullPath, "utf-8");

          // Try exact match first, then fall back to whitespace-normalized match.
          // LLMs often return oldCode with slightly different indentation or
          // line endings (tabs vs spaces, trailing whitespace, CRLF vs LF).
          const applyPatch = (original: string, old: string, repl: string): string | null => {
            if (original.includes(old)) return original.replace(old, repl);
            // Normalize: collapse runs of whitespace to single spaces for matching
            const normalizeWs = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/^ +/gm, "").replace(/ +$/gm, "");
            const normOriginal = normalizeWs(original);
            const normOld = normalizeWs(old);
            if (normOriginal.includes(normOld)) {
              // Find the actual span in the original that corresponds to the normalized match
              const startIdx = normOriginal.indexOf(normOld);
              // Map normalized indices back to original indices
              let origIdx = 0, normIdx = 0;
              while (normIdx < startIdx && origIdx < original.length) {
                if (normalizeWs(original[origIdx]) === normOriginal[normIdx]) {
                  normIdx++;
                }
                origIdx++;
              }
              const origStart = origIdx;
              while (normIdx < startIdx + normOld.length && origIdx < original.length) {
                if (normalizeWs(original[origIdx]) === normOriginal[normIdx]) {
                  normIdx++;
                }
                origIdx++;
              }
              const origEnd = origIdx;
              return original.slice(0, origStart) + repl + original.slice(origEnd);
            }
            return null;
          };
          const newContent = applyPatch(content, oldCode, newCode);
          if (newContent !== null) {
            writeFileSync(fullPath, newContent, "utf-8");

            const verification = verifyAppliedFix(target.dir, fixFile);
            verificationSummary = verification.summary;
            if (verification.ok) {
              fixApplied = true;
              fixDescription = `Fixed ${fixFile}: ${explanation || problem}`;
              log.info(`Applied and verified improvement fix to ${target.dir}/${fixFile}: ${problem}`);
            } else {
              writeFileSync(fullPath, content, "utf-8");
              analysisFailure = `Verification failed after editing ${fixFile}; change was reverted.`;
              fixDescription = `${analysisFailure} ${verification.summary}`;
              log.warn(`Reverted autonomous improvement in ${target.dir}/${fixFile}: ${verification.summary.slice(0, 300)}`);
            }
          } else {
            fixDescription = `Fix not applied: oldCode not found verbatim in ${fixFile}`;
          }
        }
      } catch (parseErr) {
        fixDescription = `Fix parse failed: ${String(parseErr)}`;
      }
    } else {
      analysisFailure = parsed.error ?? "Unable to parse improvement proposal";
      fixDescription = analysisFailure;
    }
  } catch (err) {
    if (isProviderPressureErrorText(err)) {
      const skipReason = `skipped-provider-pressure: ${String(err)}`;
      await completeTask(taskId, skipReason, "completed", true);
      log.info(`Improvement skipped because LLM provider is under pressure: ${String(err)}`);
      return {
        result: {
          type: "observe-and-improve",
          success: true,
          result: skipReason.slice(0, 500),
          data: { readOnly: readOnlyMode, fixApplied: false, analysisCompleted: false, skipped: true },
        },
        metricsChanged: [],
      };
    }

    analysisResult = `LLM analysis failed: ${String(err)}`;
    analysisFailure = analysisResult;
    log.warn(`Improvement LLM call failed: ${String(err)}`);
  }

  log.info(`Improvement analysis done: fixApplied=${fixApplied}, ${fixDescription || "no fix"}`);

  const verifiedTaskStatus: "completed" | "failed" =
    fixApplied || (readOnlyMode && analysisCompleted && !analysisFailure)
      ? "completed"
      : "failed";
  const requiresActivation = target.isSelf && fixApplied && options.autonomousActions;
  const taskStatus: TaskStatus = requiresActivation ? "awaiting-restart" : verifiedTaskStatus;
  const outcomeText = fixApplied
    ? `Applied and verified one concrete improvement: ${proposedProblem || fixDescription}.`
    : readOnlyMode && analysisCompleted && !analysisFailure
      ? `Completed a read-only analysis: ${fixDescription || proposedProblem || "no concrete improvement was identified"}.`
      : `No autonomous code improvement was completed: ${fixDescription || analysisFailure || "no safe change was identified"}.`;
  const changesText = fixApplied
    ? `- File: ${proposedFile}\n- Problem fixed: ${proposedProblem || "not specified"}\n- Functional improvement: ${proposedExplanation || fixDescription}`
    : `No files were changed.${proposedFile ? ` Candidate file: ${proposedFile}.` : ""}`;
  const verificationText = fixApplied
    ? verificationSummary || "The configured verification command passed."
    : readOnlyMode
      ? "No command was run because autonomous write mode was disabled."
      : analysisFailure || "No verification was run because no change was applied.";
  const metricsText = `Source files discovered: ${allFiles.length}. Files read: ${fileContents.length}. Files modified: ${fixApplied ? 1 : 0}. Verification: ${fixApplied ? "passed" : "not run"}.`;
  const acceptanceText = (task.acceptanceCriteria ?? []).length > 0
    ? (task.acceptanceCriteria ?? []).map((criterion) => {
      const requiresChange = /changed files/i.test(criterion);
      const requiresVerification = /verification command/i.test(criterion);
      const met = requiresChange ? fixApplied : requiresVerification ? fixApplied : /outcome report/i.test(criterion);
      return `- [${met ? "x" : " "}] ${criterion}`;
    }).join("\n")
    : "No explicit acceptance criteria were recorded.";
  const nextText = fixApplied
    ? "Review the verified change in normal use and only start another improvement when there is a distinct issue."
    : "Do not report this as a completed code improvement; refine the target or evidence before retrying.";
  const result = `Status: ${taskStatus}
Task: ${taskId}
Finished: ${new Date().toISOString()}
Target: ${target.dir}

## Outcome
${outcomeText}

## Changes
${changesText}

## Verification
${verificationText}

## Metrics
${metricsText}

## Acceptance
${acceptanceText}

## Next
${nextText}`;

  await completeTask(taskId, result, taskStatus);
  if (taskStatus === "awaiting-restart") await requestGatewayRestart(taskId);

  return {
    result: {
      type: "observe-and-improve",
      success: taskStatus === "completed" || taskStatus === "awaiting-restart",
      result: result.slice(0, 500),
      data: { readOnly: readOnlyMode, fixApplied, analysisCompleted },
    },
    metricsChanged: taskStatus === "completed" || taskStatus === "awaiting-restart"
      ? [
          { need: "growth", delta: fixApplied ? 20 : 10, reason: fixApplied ? "applied improvement fix" : "code analysis" },
          { need: "meaning", delta: fixApplied ? 15 : 8, reason: readOnlyMode ? "observing self-improvement opportunities" : "working on user's assigned goal" },
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// executeSubagentImprove — full tool-chain improvement via subagent runtime
// ---------------------------------------------------------------------------
//
// This action combines observe-and-improve's focused analysis approach with
// run-agent-task's subagent runtime delegation. The subagent is a full
// OpenClaw agent with exec, write, read, and git tools — giving it both
// write permissions AND full tool-chain access (compile, test, etc.).
//
// Unlike observe-and-improve which uses local LLM + spawnSync for verification
// (limited to npm scripts / python / node --check), this action delegates the
// entire analyze → patch → verify cycle to the subagent, which can run
// arbitrary commands through its exec tool.
//
// Unlike run-agent-task which gives the subagent a generic task message,
// this action provides a focused improvement prompt that asks for exactly
// one concrete fix with verification — combining the best of both paths.

export async function executeSubagentImprove(
  thought: Thought,
  ego: EgoState,
  options: AutonomousActionOptions,
): Promise<{ result: ActionResult; metricsChanged: MetricDelta[] }> {
  // Require subagent runtime
  if (!options.subAgentRunner) {
    return {
      result: { type: "subagent-improve", success: false, error: "No subagent runtime available — subagent-improve requires api.runtime.subagent" },
      metricsChanged: [],
    };
  }

  // Backoff checks
  if (hasRecentProviderPressure()) {
    log.info("Skipping subagent-improve: provider pressure seen recently");
    return {
      result: { type: "subagent-improve", success: false, error: "Provider rate limit/cooldown seen recently; backing off" },
      metricsChanged: [],
    };
  }
  const failureBackoff = recentAutonomousFailureBackoff(ego);
  if (failureBackoff !== null) {
    const mins = Math.ceil(failureBackoff!.remainingMs / 60_000);
    log.info(`Skipping subagent-improve: recent failure backoff ${mins}m`);
    return {
      result: { type: "subagent-improve", success: false, error: `Backing off for ${mins}m` },
      metricsChanged: [],
    };
  }

  const target = resolveTargetProject(ego, thought, options.workspaceContext);
  if (target.resolutionError) {
    return {
      result: { type: "subagent-improve", success: false, error: target.resolutionError },
      metricsChanged: [],
    };
  }

  // Only 1 concurrent improvement task
  const activeImprove = (ego.activeTasks ?? []).filter(
    (t) => isTaskOccupyingWorker(t) && t.title?.toLowerCase().includes("improvement"),
  ).length;
  if (activeImprove >= 1) {
    return { result: { type: "subagent-improve", success: false, error: "Improvement task already running" }, metricsChanged: [] };
  }

  const readOnlyMode = !options.autonomousActions;

  const langInstruction = buildUserLanguageInstruction(ego);

  // Build context
  const userContext = ego.userFacts.slice(0, 5).map((f) => `[${f.category}] ${f.content}`).join("\n");
  const recentUserMessages = (ego.recentUserMessages ?? [])
    .slice(-5)
    .map((m, i) => `${i + 1}. ${m.slice(0, 240)}`)
    .join("\n");
  const activeGoals = ego.goals
    .filter((g) => g.status === "active")
    .slice(0, 5)
    .map((g) => `- ${g.title}: ${g.description} (${g.progress.toFixed(0)}%)`)
    .join("\n");

  // Recent analysis context — include both prior improvement results AND
  // completed analyze-problem results that have actionable findings.
  // Analyze-problem results often identify specific bugs that subagent-improve
  // should fix directly, rather than re-discovering them from scratch.
  // Filter out boilerplate partial/failed results that have no findings.
  const recentImproveResults = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && t.id !== undefined
      && t.requiresWritePermission === true
      && !isLowValueAutonomousFailure(t))
    .slice(-2)
    .map((t) => t.result);

  const recentAnalyzeResults = (ego.activeTasks ?? [])
    .filter((t) => t.status === "completed" && t.result && t.id !== undefined
      && t.requiresWritePermission === false
      && !isLowValueAutonomousFailure(t)
      && t.result.length > 100)  // only substantive analyses
    .slice(-1)
    .map((t) => `**Prior analysis (from analyze-problem task ${t.id})**:\n${t.result}`);

  const recentAnalyses = [...recentImproveResults, ...recentAnalyzeResults].join("\n\n");

  // Project context
  const projectContext = (ego.projectContexts ?? []).find((context) =>
    context.root.toLowerCase() === target.dir.toLowerCase());
  const projectContinuityText = projectContext
    ? `**Host-agent project continuity**:
- Last observed: ${new Date(projectContext.lastObservedAt).toISOString()}
- Recently modified files: ${projectContext.modifiedFiles.join(", ") || "none recorded"}
- Recently observed files: ${projectContext.observedFiles.join(", ") || "none recorded"}
- Verification commands already used: ${projectContext.verificationCommands.join(" | ") || "none recorded"}`
    : "";

  const handoffText = typeof thought.actionParams?.workHandoffId === "string"
    ? `**Durable work handoff**:
- Handoff: ${thought.actionParams.workHandoffId}
- Intention: ${thought.actionParams.intentionId ?? "unknown"}
- Objective: ${String(thought.actionParams.objective ?? thought.motivation)}
- Prior phase: ${String(thought.actionParams.priorWorkPhase ?? "unknown")}
- Acceptance criteria: ${Array.isArray(thought.actionParams.acceptanceCriteria) ? thought.actionParams.acceptanceCriteria.join("; ") : "not recorded"}
- Prior modified files: ${Array.isArray(thought.actionParams.priorModifiedFiles) ? thought.actionParams.priorModifiedFiles.join(", ") : "none recorded"}
- Prior verification: ${Array.isArray(thought.actionParams.priorVerificationCommands) ? thought.actionParams.priorVerificationCommands.join(" | ") : "none recorded"}
- Prior failed tools: ${Array.isArray(thought.actionParams.priorFailedTools) ? thought.actionParams.priorFailedTools.join(", ") : "none"}`
    : "";

  const taskId = randomBytes(4).toString("hex");
  const resultDir = join(resolveSoulDir(), "results");
  mkdirSync(resultDir, { recursive: true });
  const resultFilePath = join(resultDir, `${taskId}.md`);

  const readOnlyInstruction = readOnlyMode
    ? "\n\nIMPORTANT: You are in READ-ONLY mode. Only READ files and RUN diagnostic commands. Do NOT edit, write, or modify any files."
    : "";
  const maintenanceFocusText = formatMaintenanceFocus(thought);

  const projectDesc = target.isSelf
    ? "This is the Soul plugin itself — an autonomous AI agent with ego, thoughts, and actions."
    : `This is project at ${target.dir}.`;

  const agentMessage = `[Soul Autonomous Improvement Task]
${thought.content}

**IMPORTANT**: This is an AUTONOMOUS task. No one will reply to you. Do NOT ask for confirmation or permission — start working immediately.

You have a hard ${AUTONOMOUS_AGENT_WORK_BUDGET_SECONDS}s work budget. Do one bounded iteration, then stop and finalize.

${langInstruction}

Context:
- Target project: ${target.dir} (${target.name})
- ${projectDesc}
- User profile: ${userContext || "limited"}
- Recent user messages:
${recentUserMessages || "none"}
- Active goals:
${activeGoals || "none"}
- Trigger: ${thought.triggerDetail}${readOnlyInstruction}
${projectContinuityText ? `- ${projectContinuityText}` : ""}
${handoffText ? `- ${handoffText}` : ""}
${options.workspaceContext ? `- Workspace rules:\n${options.workspaceContext}` : ""}
${maintenanceFocusText ? `- Maintenance focus:\n${maintenanceFocusText}` : ""}

**Previous findings**:
${recentAnalyses || "None."}

${recentAnalyzeResults.length > 0 ? "**IMPORTANT**: A prior analysis identified a specific issue. Implement the fix directly — do NOT re-analyze or re-discover the same problem. Go straight to editing the relevant file(s)." : ""}

${autonomousShellInstruction()}

Work like the main OpenClaw agent would when the user directly asks for a focused improvement:
1. Inspect only the most relevant source files, scripts, and recent logs.
2. Identify exactly ONE concrete, high-value improvement that can finish within this run.
3. ${readOnlyMode ? "Propose the fix with exact oldCode/newCode, but do NOT write any files." : "Apply the fix directly by editing the file(s)."}
4. Run the most relevant verification command (build, test, typecheck, compile) to confirm the fix works.
5. If verification fails, revert the change and report the failure.
6. Do not ask for confirmation, do not stop at a proposal, and do not invent results.
7. Do NOT restart the OpenClaw gateway yourself. Soul persists the final report first and coordinates restart from the parent process so the task cannot be orphaned.

**Editing tips**:
- If the \`edit\` tool fails with a matching error, the file may use CRLF line endings. Do NOT retry edit repeatedly — instead use \`node -e\` with \`fs.readFileSync\`/\`fs.writeFileSync\` to do string replacement, or use the \`write\` tool to rewrite the entire file.
- If you cannot edit after 2 attempts, switch to \`exec\` with a \`node -e\` script immediately.

**CRITICAL: Write your result file INCREMENTALLY.**
1. FIRST — as soon as you have initial findings, write an intermediate report to the result path with Status: partial and what you have found so far.
2. THEN — do your fix/verification work.
3. FINALLY — update the file with your complete report and change Status to completed/failed.

This ensures partial progress is saved even if your budget runs out.

Write your final report to the result file using the write tool:
${resultFilePath}

The first line of the final report MUST be exactly one explicit terminal status: \`Status: completed\`, \`Status: partial\`, \`Status: blocked\`, or \`Status: failed\`.
Write your final report as markdown with these sections:
## Outcome
What you investigated and the final result.
## Changes
Files changed and why. If no files changed, say why.
## Verification
Commands run and their results.
## Metrics
Before/after metrics if applicable.
## Next
Remaining risk or a sensible next improvement.`;

  const task: AutonomousTask = {
    id: taskId,
    title: `Subagent improvement: ${target.name}`,
    description: `Full tool-chain improvement for ${target.dir}`,
    status: "in-progress",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceThoughtId: thought.id,
    ...taskContinuityFields(thought),
    steps: [{ id: randomBytes(4).toString("hex"), timestamp: Date.now(), action: "spawn-subagent-improve", input: agentMessage.slice(0, 200), success: true }],
    resultFilePath,
    requiresWritePermission: options.autonomousActions,
    resultDelivered: false,
  };

  writeTaskReportFile(resultFilePath, buildInitialTaskReport({
    taskId,
    title: task.title,
    target: target.isSelf ? target.name : `${target.name} at ${target.dir}`,
    resultFilePath,
  }));
  await persistTask(task);

  const sessionKey = `agent:main:subagent:soul-improve-${taskId}`;
  const timeoutMs = AUTONOMOUS_AGENT_TIMEOUT_SECONDS * 1000;

  log.info(`Spawning subagent for subagent-improve ${taskId}: ${target.dir} (${target.name})`);

  let subResult: SubAgentRunResult;
  try {
    subResult = await options.subAgentRunner!({
      sessionKey,
      message: agentMessage,
      timeoutMs,
    });
  } catch (err) {
    subResult = { runId: "", success: false, output: "", error: String(err) };
  }

  // Use the same final-report recovery logic as run-agent-task so both
  // maintenance paths converge on the same completion behavior.
  let report = await resolveSubagentFinalReport(task, resultFilePath, subResult, false);
  const requiresActivation = target.isSelf && options.autonomousActions && reportShowsVerifiedCodeChange(report);
  if (requiresActivation) report = markReportAwaitingRestart(report);
  writeTaskReportFile(resultFilePath, report);

  // Determine task status from the report's Status: line.
  // "completed" → completed; "partial"/"blocked" → also completed (did useful work,
  //   should NOT trigger failure backoff); everything else → failed.
  const taskStatus: TaskStatus = reportStatusToTaskStatus(report);

  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      t.status = taskStatus;
      t.result = report;
      t.completedAt = taskStatus === "awaiting-restart" ? undefined : Date.now();
      t.updatedAt = Date.now();
      t.resultDelivered = false;
      if (taskStatus === "awaiting-restart") t.activationRequestedAt = Date.now();
    }
    return e;
  });

  // Success if the report indicates a terminal state (completed/partial/blocked),
  // regardless of whether subResult.success was false (e.g. timeout — the subagent
  // may have finished writing during the grace period).
  const success = reportRepresentsSuccessfulCompletion(report);
  log.info(`Subagent-improve ${taskId}: status=${taskStatus}, success=${success}`);

  if (taskStatus === "awaiting-restart") await requestGatewayRestart(taskId);

  return {
    result: {
      type: "subagent-improve",
      success,
      result: report.slice(0, 500),
      data: {
        taskId,
        resultFilePath,
        status: taskStatus,
        runId: subResult.runId,
        fixApplied: reportShowsVerifiedCodeChange(report),
        readOnly: readOnlyMode,
      },
    },
    metricsChanged: [
      { need: "growth", delta: success ? 20 : 3, reason: success ? "completed subagent improvement with full tool-chain verification" : "subagent improvement did not fully complete" },
      { need: "meaning", delta: success ? 10 : 2, reason: "reported verifiable autonomous improvement with tool-chain verification" },
    ],
  };
}

async function completeTask(
  taskId: string,
  result: string,
  status: "completed" | "failed" | "awaiting-restart" = "completed",
  resultDelivered = false,
): Promise<void> {
  let linkedIntentionId: string | undefined;
  let linkedAcceptanceMet = true;
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    const t = (e.activeTasks ?? []).find((at) => at.id === taskId);
    if (t) {
      linkedIntentionId = t.intentionId;
      const finalResult = isFinalTaskReport(result)
        ? result
        : `Status: ${status}
Task: ${taskId}
Finished: ${new Date().toISOString()}

## Outcome
${result}

## Changes
See outcome. If no file was changed, the task produced an analysis or recommendation only.

## Verification
The local observe-and-improve path completed its bounded analysis. No separate verification command was recorded by this helper.

## Metrics
No before/after benchmark metrics were recorded.

## Next
Run a focused verification command or a smaller follow-up improvement if the result needs implementation confirmation.`;
      const unmetCriteria = unmetAcceptanceCriteria(t, finalResult);
      linkedAcceptanceMet = unmetCriteria.length === 0;
      t.status = status === "failed" || !linkedAcceptanceMet
        ? "failed"
        : reportStatusToTaskStatus(finalResult);
      t.result = finalResult;
      t.completedAt = status === "awaiting-restart" ? undefined : Date.now();
      t.updatedAt = Date.now();
      t.resultDelivered = resultDelivered;
      if (status === "awaiting-restart") t.activationRequestedAt = Date.now();
    }
    return e;
  });
  if (linkedIntentionId) {
    const intentionStore = new IntentionStore(resolveIntentionStorePath(resolveEgoStorePath()));
    let intentionFulfilled = false;
    await intentionStore.update(linkedIntentionId, (intention) => {
      const requiresChange = intention.evidenceNeeded.includes("concrete changed files");
      const requiresVerification = intention.evidenceNeeded.some((item) => /verification command/i.test(item));
      const reportsNoChange = /No files were changed|没有修改任何文件|Files modified:\s*0|修改文件：0/i.test(result);
      const reportsNoVerification = /Verification:\s*not run|验证：未执行|没有执行验证|No verification was run/i.test(result);
      intention.status = status === "awaiting-restart"
        ? "active"
        : status === "failed"
        || !linkedAcceptanceMet
        || (requiresChange && reportsNoChange)
        || (requiresVerification && reportsNoVerification)
        ? "blocked"
        : "fulfilled";
      intentionFulfilled = intention.status === "fulfilled";
    });
    const handoffStore = new WorkHandoffStore(resolveWorkHandoffStorePath(resolveEgoStorePath()));
    await handoffStore.updateForIntention(linkedIntentionId, (handoff) => {
      handoff.phase = status === "awaiting-restart" ? "implementing" : intentionFulfilled ? "verified" : "blocked";
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkippedStep(action: string, reason: string): TaskStep {
  return {
    id: randomBytes(4).toString("hex"),
    timestamp: Date.now(),
    action,
    input: reason,
    success: false,
  };
}

/**
 * Try to extract the sub-agent's final report from recent session files.
 * This is a fallback when the agent doesn't write the result file. It returns
 * partial/failed status explicitly when the session timed out or only produced
 * interim narration.
 * Looks for sessions created after `sinceMs` that contain "Soul-Autonomous" or "[Soul Autonomous".
 */
function extractResultFromSessions(task: AutonomousTask, sinceMs: number, zh: boolean): { status: "completed" | "failed"; result: string } | null {
  const sessionsDir = join(homedir(), ".openclaw/agents/main/sessions");
  try {
    const markers = [task.resultFilePath, task.id, `${task.id}.md`].filter((value): value is string => Boolean(value));
    const files = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, fp: join(sessionsDir, name), mtimeMs: statSync(join(sessionsDir, name)).mtimeMs }))
      .filter((file) => file.mtimeMs >= sinceMs - 60_000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const name of files) {
      const content = readFileSync(name.fp, "utf-8");
      if (!content.includes("Soul-Autonomous") && !content.includes("[Soul Autonomous")) continue;
      if (markers.length > 0 && !markers.some((marker) => content.includes(marker))) continue;
      const entries: any[] = [];
      for (const line of content.split("\n")) {
        try {
          entries.push(JSON.parse(line.trim()));
        } catch {
          // Skip malformed or partially flushed JSONL lines.
        }
      }
      const taskStartIndex = entries.findIndex((obj) => {
        if (obj.type !== "message" || obj.message?.role !== "user") return false;
        const userText = extractSessionText(obj.message.content);
        const isAutonomousPrompt = /Soul-Autonomous|\[Soul Autonomous/i.test(userText);
        return isAutonomousPrompt && (markers.length === 0 || markers.some((marker) => userText.includes(marker)));
      });
      if (taskStartIndex < 0) continue;

      // A session file can contain many later turns. Scope recovery strictly to
      // this autonomous user turn so a subsequent heartbeat or unrelated task
      // cannot become the missing task's "last output".
      const taskEntries: any[] = [];
      for (let index = taskStartIndex + 1; index < entries.length; index++) {
        const obj = entries[index];
        if (obj.type === "message" && obj.message?.role === "user") break;
        taskEntries.push(obj);
      }

      let lastAssistantText = "";
      let promptError = "";
      let toolFailure = "";
      const reportCandidates: string[] = [];
      const allAssistantTexts: string[] = [];
      for (const obj of taskEntries) {
        if (obj.type === "custom" && obj.customType === "openclaw:prompt-error") {
          promptError = String(obj.data?.error ?? "prompt error");
        }
        if (obj.type === "message" && obj.message?.role === "assistant") {
          const assistantText = extractSessionText(obj.message.content);
          if (assistantText.length > 20) {
            lastAssistantText = assistantText;
            reportCandidates.push(assistantText);
            if (assistantText.length > 50) allAssistantTexts.push(assistantText);
          }
        }
        if (obj.type === "message" && obj.message?.role === "toolResult") {
          const toolText = extractSessionText(obj.message.content);
          // Tool output often contains source documents or reports from older
          // tasks. It is a candidate for this task only when it carries this
          // task's durable identity.
          if (toolText.length > 0 && markers.some((marker) => toolText.includes(marker))) {
            reportCandidates.push(toolText);
          }
          if (/ParserError|Command exited with code [1-9]|EnvironmentLocationNotFound|timed out|timeout|error/i.test(toolText)) {
            toolFailure = toolText.slice(0, 600);
          }
        }
        if (obj.type === "tool.result" || obj.type === "toolResult") {
          const toolText = extractSessionText(obj.data?.output ?? obj.data?.result?.output ?? obj.output ?? obj.result?.output ?? obj.message?.content);
          if (toolText.length > 0 && markers.some((marker) => toolText.includes(marker))) {
            reportCandidates.push(toolText);
          }
          if (/ParserError|Command exited with code [1-9]|EnvironmentLocationNotFound|timed out|timeout|error/i.test(toolText)) {
            toolFailure = toolText.slice(0, 600);
          }
        }
      }
      for (const candidate of reportCandidates.reverse()) {
        if (isCompleteTaskReport(candidate)) {
          return { status: reportStatusToTaskStatus(candidate) === "failed" ? "failed" : "completed", result: candidate };
        }
      }
      // A prompt/tool error can occur before a later recovery write. Only turn
      // it into a failure after scanning the whole session for a final report.
      if (promptError) {
        const detail = [
          `Agent session ${name.name} failed before writing the required result file.`,
          `Error: ${promptError}`,
          toolFailure ? `Last tool failure: ${toolFailure}` : "",
          lastAssistantText ? `Last assistant text: ${lastAssistantText.slice(0, 600)}` : "",
        ].filter(Boolean).join("\n");
        return { status: "failed", result: buildFailureTaskReport(task, detail) };
      }
      if (lastAssistantText) {
        // Try to find the most informative assistant text by scanning all
        // assistant messages. The last message is often a brief transition
        // ("Let me look at where X occurs") while earlier messages contain
        // the actual analysis. Use the longest substantive message for
        // both the hasUsefulPartial check and the detail output.
        // Sort by length descending, pick the longest substantive message
        // or fall back to the lastAssistantText
        const bestText = allAssistantTexts.length > 0
          ? allAssistantTexts.sort((a, b) => b.length - a.length)[0]
          : lastAssistantText;
        const detail = `Agent session ${name.name} stopped before producing a final result file${task.resultFilePath ? ` (${task.resultFilePath})` : ""}.${
          bestText !== lastAssistantText
            ? ` Best analysis excerpt (${bestText.length} chars): ${bestText.slice(0, 1600)}`
            : ` Last partial output: ${lastAssistantText.slice(0, 1200)}`
        }`;
        const hasUsefulPartial = /\b(done|fail(?:ed|ure)?|passes|improved?|worse|bug|root cause|clear|metric|result|verified?|fixed?|applied|completed|error|issue|analysis|identified?|found|discovered|root|stream|connection|timeout|disconnect)\b/i.test(bestText);
        return {
          status: "failed",
          result: hasUsefulPartial ? buildPartialTaskReport(task, detail) : buildFailureTaskReport(task, detail),
        };
      }
    }
  } catch { /* sessions dir not accessible */ }
  return null;
}

export function __testOnlyExtractResultFromSessions(task: AutonomousTask, sinceMs: number, zh: boolean): { status: "completed" | "failed"; result: string } | null {
  return extractResultFromSessions(task, sinceMs, zh);
}

export async function __testOnlyResolveSubagentFinalReport(
  task: AutonomousTask,
  resultFilePath: string,
  subResult: SubAgentRunResult,
  zh: boolean,
): Promise<string> {
  return resolveSubagentFinalReport(task, resultFilePath, subResult, zh);
}

export function __testOnlyReportShowsVerifiedCodeChange(result: string): boolean {
  return reportShowsVerifiedCodeChange(result);
}

export function __testOnlyScheduleGatewayRestart(taskId: string): GatewayRestartScheduleResult {
  return scheduleGatewayRestart(taskId);
}

async function readLocalFile(actionName: string, filePath: string): Promise<TaskStep> {
  const id = randomBytes(4).toString("hex");
  const start = Date.now();
  try {
    // Resolve bare filenames (no directory component) against the Soul directory
    // instead of process.cwd() (which is C:\Windows\System32 for the gateway service).
    let resolvedPath = filePath;
    if (!isAbsolute(filePath) && !filePath.includes("/") && !filePath.includes("\\")) {
      const soulDir = resolveSoulDir();
      const candidate = join(soulDir, filePath);
      try {
        await accessFile(candidate);
        resolvedPath = candidate;
      } catch {
        // Not in soul dir; fall through and let readFile attempt the original path
      }
    }
    const buf = await readFile(resolvedPath, "utf-8");
    // Keep last 8000 chars to avoid blowing up LLM context
    const content = buf.length > 8000 ? buf.slice(-8000) : buf;
    return {
      id,
      timestamp: Date.now(),
      action: actionName,
      input: filePath,
      output: content,
      success: true,
      duration: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.info(`File read failed: ${filePath} → ${msg}`);
    return {
      id,
      timestamp: Date.now(),
      action: actionName,
      input: filePath,
      output: undefined,
      success: false,
      duration: Date.now() - start,
    };
  }
}

async function runToolStep(
  actionName: string,
  tool: string,
  args: Record<string, unknown>,
  options: AutonomousActionOptions,
): Promise<TaskStep> {
  const start = Date.now();
  const result = await invokeGatewayTool({
    tool,
    args,
    gatewayPort: options.gatewayPort,
    authToken: options.authToken,
    timeoutMs: 60_000,
  });
  return {
    id: randomBytes(4).toString("hex"),
    timestamp: Date.now(),
    action: actionName,
    input: JSON.stringify(args).slice(0, 200),
    output: result.result,
    success: result.ok,
    duration: Date.now() - start,
  };
}

async function persistTask(task: AutonomousTask): Promise<void> {
  await updateEgoStore(resolveEgoStorePath(), (e) => {
    if (!e.activeTasks) e.activeTasks = [];
    e.activeTasks.push(task);
    return e;
  });
}

/**
 * Poll active tasks: check result files, mark stale ones as completed.
 * Returns list of newly completed tasks (with results from file capture).
 */
type PollActiveTaskOptions = {
  now?: () => number;
  processStartedAt?: number;
  restartScheduler?: GatewayRestartScheduler;
};

export async function pollActiveTasks(
  storePath: string,
  options: PollActiveTaskOptions = {},
): Promise<AutonomousTask[]> {
  // Allow the hook timeout, the report-write grace period, and a small settle
  // window before another polling cycle can declare the task stale.
  const STALE_MS = AUTONOMOUS_AGENT_TIMEOUT_SECONDS * 1000
    + SUBAGENT_GRACE_PERIOD_MS
    + SUBAGENT_STALE_SETTLE_MS;
  const MAX_TASKS = 20;
  const newlyCompleted: AutonomousTask[] = [];
  const retryActivationTaskIds: string[] = [];
  const now = options.now?.() ?? Date.now();
  const processStartedAt = options.processStartedAt ?? PROCESS_STARTED_AT;

  await updateEgoStore(storePath, (e) => {
    if (!e.activeTasks) e.activeTasks = [];

    for (const task of e.activeTasks) {
      if (task.status === "awaiting-restart") {
        if (task.activationRequestedAt && task.activationRequestedAt < processStartedAt) {
          task.status = "completed";
          task.result = markReportActivated(task.result ?? "Status: awaiting-restart", processStartedAt);
          writeTaskReportFile(task.resultFilePath, task.result);
          task.activatedAt = processStartedAt;
          task.activationError = undefined;
          task.completedAt = now;
          task.updatedAt = now;
          newlyCompleted.push({ ...task });
        } else if (task.activationRequestedAt) {
          // Older state files predate activationAttempts. Such tasks already
          // issued one restart request when entering awaiting-restart.
          const attempts = task.activationAttempts ?? 1;
          const lastAttemptAt = task.lastActivationAttemptAt ?? task.activationRequestedAt;
          const activationAge = now - task.activationRequestedAt;
          if (attempts < MAX_ACTIVATION_ATTEMPTS && now - lastAttemptAt >= ACTIVATION_RETRY_INTERVAL_MS) {
            retryActivationTaskIds.push(task.id);
          } else if (attempts >= MAX_ACTIVATION_ATTEMPTS && activationAge >= ACTIVATION_TIMEOUT_MS) {
            const detail = `Gateway activation was not confirmed after ${attempts} restart attempts over ${Math.round(activationAge / 60_000)} minutes.${
              task.activationError ? ` Last scheduling error: ${task.activationError}` : ""
            } The verified change report above was preserved for diagnosis.`;
            task.status = "failed";
            task.result = markReportActivationFailed(task.result ?? "Status: awaiting-restart", detail);
            writeTaskReportFile(task.resultFilePath, task.result);
            task.completedAt = now;
            task.updatedAt = now;
            newlyCompleted.push({ ...task });
          }
        }
        continue;
      }
      if (task.status !== "in-progress") continue;

      // Check result file first — re-read even if task.result exists but
      // the file was updated after task.updatedAt (the subagent may have
      // written a complete report slightly after the settle window closed).
      if (task.resultFilePath) {
        const fileIsNewer = !!task.result && (() => {
          try {
            return statSync(task.resultFilePath).mtimeMs > task.updatedAt;
          } catch { return false; }
        })();
        if (!task.result || fileIsNewer) {
          try {
            const content = readFileSync(task.resultFilePath, "utf-8").trim();
            if (content && isFinalTaskReport(content)) {
              task.result = content;
              task.status = reportStatusToTaskStatus(content);
              task.completedAt = Date.now();
              task.updatedAt = Date.now();
              newlyCompleted.push({ ...task });
              continue;
            }
          } catch { /* file not ready yet */ }
        }
      }

      // Fallback: try to extract result from session files — but only after
      // the stale timeout has elapsed. Running this while the session is still
      // within its timeout window causes false-positive failures: the session
      // is still actively running and hasn't had a chance to write its final
      // report yet.
      if (!task.result && task.requiresWritePermission && Date.now() - task.updatedAt > STALE_MS) {
        const sessionResult = extractResultFromSessions(task, task.createdAt, false);
        if (sessionResult) {
          task.result = sessionResult.result;
          task.status = sessionResult.status;
          writeTaskReportFile(task.resultFilePath, task.result);
          task.completedAt = Date.now();
          task.updatedAt = Date.now();
          newlyCompleted.push({ ...task });
          continue;
        }
      }

      // Final fallback: stale timeout.
      if (Date.now() - task.updatedAt > STALE_MS) {
        // But check if the subagent session is still being actively written to
        // before marking the task as failed. A long-running verification command
        // or slow report write can keep `task.updatedAt` old even though the
        // subagent is actively working.
        if (isSubagentSessionRecentlyActive(task)) {
          continue;
        }
        const detail = task.result ?? `Task timed out (stale >${Math.round(STALE_MS / 60000)} min). Required final result file was not produced${task.resultFilePath ? `: ${task.resultFilePath}` : ""}.`;
        task.status = "failed";
        task.result = buildFailureTaskReport(task, detail);
        writeTaskReportFile(task.resultFilePath, task.result);
        task.completedAt = Date.now();
        task.updatedAt = Date.now();
        newlyCompleted.push({ ...task });
      }
    }

    // Prune old completed tasks (keep last MAX_TASKS)
    if (e.activeTasks.length > MAX_TASKS) {
      // Before pruning from ego, clean up orphaned result files for tasks
      // being evicted — prevents results/ directory from growing unbounded.
      const sorted = [...e.activeTasks].sort((a, b) => b.updatedAt - a.updatedAt);
      const evicted = sorted.slice(MAX_TASKS);
      for (const t of evicted) {
        if (t.resultFilePath) {
          try { unlinkSync(t.resultFilePath); } catch { /* already gone */ }
        }
      }
      e.activeTasks = sorted.slice(0, MAX_TASKS);
    }

    // Shrink step outputs for delivered terminal tasks — the full log
    // text was only needed during result extraction, not for history.
    for (const t of e.activeTasks) {
      if ((t.status === "completed" || t.status === "failed") && t.resultDelivered) {
        for (const s of (t.steps ?? [])) {
          if (typeof s.output === "string" && s.output.length > 200) {
            s.output = s.output.slice(0, 200) + "... [pruned]";
          }
        }
      }
    }

    // Clean up orphaned result files not referenced by any task
    const resultDir = join(resolveSoulDir(), "results");
    try {
      const knownResultFiles = new Set(e.activeTasks.map((t) => t.resultFilePath?.toLowerCase()).filter(Boolean));
      const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h retention
      for (const name of readdirSync(resultDir)) {
        if (!name.endsWith(".md")) continue;
        const filePath = join(resultDir, name).toLowerCase();
        if (knownResultFiles.has(filePath)) continue;
        try {
          if (statSync(filePath).mtimeMs < cutoff) {
            unlinkSync(filePath);
          }
        } catch { /* gone */ }
      }
    } catch { /* result dir not accessible */ }

    return e;
  });

  for (const taskId of retryActivationTaskIds) {
    const result = await requestGatewayRestart(
      taskId,
      storePath,
      options.restartScheduler ?? scheduleGatewayRestart,
      now,
    );
    log.info(`Gateway activation retry for ${taskId}: ${result.ok ? "scheduled" : `failed (${result.error ?? "unknown error"})`}`);
  }

  if (newlyCompleted.length > 0) {
    log.info(`Tasks finished: ${newlyCompleted.map((t) => `${t.id}(${t.status}${t.result ? ",has-result" : ",no-result"})`).join(", ")}`);
  }
  return newlyCompleted;
}
