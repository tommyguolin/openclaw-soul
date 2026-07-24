import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultEgoState, saveEgoStore } from "../src/ego-store.js";

test("pollActiveTasks accepts a final Chinese report", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-chinese-report-"));
  try {
    const { pollActiveTasks } = await import(`../src/autonomous-actions.js?poll=${Date.now()}`);
    const storePath = path.join(directory, "ego.json");
    const resultFilePath = path.join(directory, "result.md");
    await fs.promises.writeFile(resultFilePath, `Status: completed

## 结果
已完成检查。

## 变更
没有修改文件。

## 验证
报告解析成功。`, "utf8");

    const ego = createDefaultEgoState();
    ego.activeTasks = [{
      id: "chinese-final-report",
      title: "中文报告",
      description: "验证多语言标题",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceThoughtId: "poll-test",
      steps: [],
      resultFilePath,
      requiresWritePermission: false,
      resultDelivered: false,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: Date.now(), updatedAt: Date.now() });

    const completed = await pollActiveTasks(storePath);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "completed");
    assert.match(completed[0].result ?? "", /## 结果/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("maintenance targets the linked Soul checkout instead of a generic workspace", async () => {
  const { __testOnlyResolveTargetProject } = await import(`../src/autonomous-actions.js?target-lock=${Date.now()}`);
  const ego = createDefaultEgoState();
  const workspace = path.join(os.tmpdir(), "generic-openclaw-workspace");
  const thought = {
    id: "maintenance-target",
    type: "self-improvement-monitor",
    content: "continue maintenance",
    trigger: "opportunity",
    source: "system-monitor",
    triggerDetail: "report reliability",
    motivation: "improve Soul",
    targetMetrics: [],
    priority: 80,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    executed: false,
    relatedNeeds: ["growth"],
    actionType: "subagent-improve",
    actionParams: { maintenanceFocus: "subagent-reliability" },
  } as any;

  const target = __testOnlyResolveTargetProject(ego, thought, `Workspace: ${workspace}`);
  assert.equal(target.name, "openclaw-soul");
  assert.equal(target.isSelf, true);
  assert.match(target.dir.replace(/\\/g, "/"), /openclaw-soul$/);
});

test("awaiting-restart tasks complete only after a later process start", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-activation-report-"));
  try {
    const storePath = path.join(directory, "ego.json");
    const resultFilePath = path.join(directory, "result.md");
    const report = `Status: awaiting-restart\n\n## Outcome\nApplied a verified runtime fix.\n\n## Changes\nChanged src/thought-service.ts.\n\n## Verification\nnpm test passed with 0 failures.`;
    await fs.promises.writeFile(resultFilePath, report, "utf8");
    const ego = createDefaultEgoState();
    ego.activeTasks = [{
      id: "activation-task",
      title: "Subagent improvement: openclaw-soul",
      description: "activate verified change",
      status: "awaiting-restart",
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 5_000,
      activationRequestedAt: Date.now() - 5_000,
      steps: [],
      result: report,
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: Date.now(), updatedAt: Date.now() });

    const { pollActiveTasks } = await import(`../src/autonomous-actions.js?activation=${Date.now()}`);
    const completed = await pollActiveTasks(storePath);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "completed");
    assert.match(completed[0].result ?? "", /^Status: completed/m);
    assert.match(completed[0].result ?? "", /## Activation/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("awaiting-restart tasks retry activation without discarding the verified report", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-activation-retry-"));
  try {
    const now = Date.now();
    const storePath = path.join(directory, "ego.json");
    const resultFilePath = path.join(directory, "result.md");
    const report = `Status: awaiting-restart

## Outcome
Applied a verified runtime fix.

## Changes
Changed src/autonomous-actions.ts.

## Verification
npm test passed with 0 failures.`;
    await fs.promises.writeFile(resultFilePath, report, "utf8");
    const ego = createDefaultEgoState();
    ego.activeTasks = [{
      id: "activation-retry-task",
      title: "Retry gateway activation",
      description: "retry a restart that was not observed",
      status: "awaiting-restart",
      createdAt: now - 20 * 60_000,
      updatedAt: now - 6 * 60_000,
      activationRequestedAt: now - 11 * 60_000,
      activationAttempts: 1,
      lastActivationAttemptAt: now - 6 * 60_000,
      steps: [],
      result: report,
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: now, updatedAt: now });

    let scheduledTaskId = "";
    const { pollActiveTasks } = await import(`../src/autonomous-actions.js?activation-retry=${Date.now()}`);
    const completed = await pollActiveTasks(storePath, {
      now: () => now,
      processStartedAt: now - 60 * 60_000,
      restartScheduler: (taskId: string) => {
        scheduledTaskId = taskId;
        return { ok: false, error: "simulated scheduler outage" };
      },
    });

    assert.equal(completed.length, 0);
    assert.equal(scheduledTaskId, "activation-retry-task");
    const stored = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    const task = stored.ego.activeTasks[0];
    assert.equal(task.status, "awaiting-restart");
    assert.equal(task.activationAttempts, 2);
    assert.equal(task.activationError, "simulated scheduler outage");
    assert.match(task.result, /Changed src\/autonomous-actions\.ts/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("activation exhaustion preserves change and verification evidence", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-activation-exhausted-"));
  try {
    const now = Date.now();
    const storePath = path.join(directory, "ego.json");
    const resultFilePath = path.join(directory, "result.md");
    const report = `Status: awaiting-restart

## Outcome
Applied a verified runtime fix.

## Changes
Changed src/autonomous-actions.ts without losing evidence.

## Verification
npm test passed with 0 failures.`;
    await fs.promises.writeFile(resultFilePath, report, "utf8");
    const ego = createDefaultEgoState();
    ego.activeTasks = [{
      id: "activation-exhausted-task",
      title: "Exhaust gateway activation",
      description: "preserve the original report after retries",
      status: "awaiting-restart",
      createdAt: now - 40 * 60_000,
      updatedAt: now - 10 * 60_000,
      activationRequestedAt: now - 31 * 60_000,
      activationAttempts: 3,
      lastActivationAttemptAt: now - 10 * 60_000,
      activationError: "access denied",
      steps: [],
      result: report,
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: now, updatedAt: now });

    const { pollActiveTasks } = await import(`../src/autonomous-actions.js?activation-exhausted=${Date.now()}`);
    const completed = await pollActiveTasks(storePath, {
      now: () => now,
      processStartedAt: now - 60 * 60_000,
      restartScheduler: () => { throw new Error("must not retry after exhaustion"); },
    });

    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "failed");
    assert.match(completed[0].result ?? "", /^Status: failed/m);
    assert.match(completed[0].result ?? "", /Changed src\/autonomous-actions\.ts without losing evidence/);
    assert.match(completed[0].result ?? "", /npm test passed with 0 failures/);
    assert.match(completed[0].result ?? "", /## Activation/);
    assert.match(completed[0].result ?? "", /access denied/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("self-change verification treats zero failures as success and nonzero failures as failure", async () => {
  const { __testOnlyReportShowsVerifiedCodeChange } = await import(`../src/autonomous-actions.js?verification-counts=${Date.now()}`);
  const report = (verification: string) => `## Outcome
Improved report settlement.

## Changes
- src/autonomous-actions.ts: fixed activation classification.

## Verification
${verification}`;

  assert.equal(__testOnlyReportShowsVerifiedCodeChange(report("npm test: 174/174 passed, 0 failed")), true);
  assert.equal(__testOnlyReportShowsVerifiedCodeChange(report("npm test: 173 passed, 1 failed")), false);
  assert.equal(__testOnlyReportShowsVerifiedCodeChange(report("npm test command failed before tests started")), false);
  assert.equal(__testOnlyReportShowsVerifiedCodeChange(report("TypeScript 编译通过，0 项错误")), true);
});

test("pollActiveTasks rejects placeholder reports that still contain pending sections", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-placeholder-report-"));
  try {
    const { pollActiveTasks } = await import(`../src/autonomous-actions.js?placeholder=${Date.now()}`);
    const storePath = path.join(directory, "ego.json");
    const resultFilePath = path.join(directory, "result.md");
    await fs.promises.writeFile(resultFilePath, `Status: completed

Task: placeholder-task
Finished: 2026-07-20T00:00:00.000Z

## Outcome
Autonomous work has started. This placeholder must be replaced with a final report before the task is considered done.

## Changes
Pending.

## Verification
Pending.

## Metrics
Pending.

## Next
Pending.`, "utf8");

    const ego = createDefaultEgoState();
    ego.activeTasks = [{
      id: "placeholder-task",
      title: "骨架报告",
      description: "验证占位稿不会被误判为最终报告",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceThoughtId: "poll-test",
      steps: [],
      resultFilePath,
      requiresWritePermission: false,
      resultDelivered: false,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: Date.now(), updatedAt: Date.now() });

    const completed = await pollActiveTasks(storePath);
    assert.equal(completed.length, 0);

    const store = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    const task = store.ego.activeTasks.find((item: any) => item.id === "placeholder-task");
    assert.equal(task.status, "in-progress");
    assert.equal(task.result, undefined);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("pollActiveTasks refreshes a stored placeholder result from the result file", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-refresh-final-report-"));
  try {
    const { pollActiveTasks } = await import(`../src/autonomous-actions.js?refresh-final=${Date.now()}`);
    const storePath = path.join(directory, "ego.json");
    const resultFilePath = path.join(directory, "result.md");
    const finalReport = `Status: completed

## Outcome
完整报告已经落盘。

## Changes
修复了父进程对非最终结果的短路读取。

## Verification
pollActiveTasks 会重新读取结果文件。`;
    await fs.promises.writeFile(resultFilePath, finalReport, "utf8");

    const now = Date.now();
    const ego = createDefaultEgoState();
    ego.activeTasks = [{
      id: "refresh-final-report-task",
      title: "刷新最终报告",
      description: "验证非最终存储结果不会挡住结果文件",
      status: "in-progress",
      createdAt: now - 10_000,
      updatedAt: now + 60_000,
      sourceThoughtId: "poll-test",
      steps: [],
      result: `Status: completed

Task: refresh-final-report-task
Finished: 2026-07-24T00:00:00.000Z

## Outcome
Autonomous work has started. This placeholder must be replaced with a final report before the task is considered done.

## Changes
Pending.

## Verification
Pending.

## Metrics
Pending.

## Next
Pending.`,
      resultFilePath,
      requiresWritePermission: false,
      resultDelivered: false,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: now, updatedAt: now });

    const completed = await pollActiveTasks(storePath, { now: () => now });
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "completed");
    assert.match(completed[0].result ?? "", /完整报告已经落盘/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("pollActiveTasks refreshes a completed stored placeholder result from the result file", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-refresh-completed-final-report-"));
  try {
    const { pollActiveTasks } = await import(`../src/autonomous-actions.js?refresh-completed-final=${Date.now()}`);
    const storePath = path.join(directory, "ego.json");
    const resultFilePath = path.join(directory, "result.md");
    const finalReport = `Status: completed

## Outcome
完成态任务在派发前被结果文件刷新。

## Changes
修复了已完成任务不再回读结果文件的短路。

## Verification
pollActiveTasks 会刷新 completed 任务的最终报告.`;
    await fs.promises.writeFile(resultFilePath, finalReport, "utf8");

    const now = Date.now();
    const ego = createDefaultEgoState();
    ego.activeTasks = [{
      id: "refresh-completed-final-report-task",
      title: "刷新完成态最终报告",
      description: "验证已完成但未派发的任务仍会回读结果文件",
      status: "completed",
      createdAt: now - 10_000,
      updatedAt: now,
      completedAt: now,
      sourceThoughtId: "poll-test",
      steps: [],
      result: `Status: partial

## Outcome
The task finished, but the complete report file was still settling when the parent wrote this fallback.

## Changes
No changes were confirmed in this fallback summary.

## Verification
No verification was captured in this fallback summary.

## Metrics
No metrics were captured in this fallback summary.

## Next
Re-read the result file once the child finishes flushing the final report.`,
      resultFilePath,
      requiresWritePermission: false,
      resultDelivered: false,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: now, updatedAt: now });

    const completed = await pollActiveTasks(storePath, { now: () => now });
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, "completed");
    assert.match(completed[0].result ?? "", /完成态任务在派发前被结果文件刷新/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("pollActiveTasks never treats an ordinary multi-section document as a final report", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-ordinary-document-"));
  try {
    const { pollActiveTasks } = await import(`../src/autonomous-actions.js?ordinary-document=${Date.now()}`);
    const storePath = path.join(directory, "ego.json");
    const resultFilePath = path.join(directory, "result.md");
    await fs.promises.writeFile(resultFilePath, `# Goal-Driven Soul System Design

## Purpose
Turn Soul into a strict goal-driven system.

## Current Baseline
The codebase already has goals, maintenance, and task execution.

## Design Goals
Each objective should be explicit and measurable.

## Verification Strategy
Run build and regression tests after implementation.`, "utf8");

    const ego = createDefaultEgoState();
    ego.activeTasks = [{
      id: "ordinary-document-task",
      title: "Do not classify source documents as reports",
      description: "require an explicit terminal status",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: Date.now(), updatedAt: Date.now() });

    const completed = await pollActiveTasks(storePath);
    assert.equal(completed.length, 0);
    const stored = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    assert.equal(stored.ego.activeTasks[0].status, "in-progress");
    assert.equal(stored.ego.activeTasks[0].result, undefined);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("session extraction recovers a final report even when it is not the last assistant chunk", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-session-recovery-"));
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  const previousHomedrive = process.env.HOMEDRIVE;
  const previousHomepath = process.env.HOMEPATH;
  process.env.USERPROFILE = directory;
  process.env.HOME = directory;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;

  try {
    const { __testOnlyExtractResultFromSessions } = await import(`../src/autonomous-actions.js?session-recovery=${Date.now()}`);
    const sessionsDir = path.join(directory, ".openclaw", "agents", "main", "sessions");
    await fs.promises.mkdir(sessionsDir, { recursive: true });

    const resultFilePath = path.join(directory, "result.md");
    const sessionPath = path.join(sessionsDir, "session.jsonl");
    const finalReport = `Status: completed
Task: recovered-task
Finished: 2026-07-20T00:00:00.000Z

## 结果
完整报告已回收。

## 变更
无文件变更。

## 验证
会话日志回收成功。`;
    const sessionLog = [
      {
        type: "message",
        message: {
          role: "user",
          content: "[Soul Autonomous Improvement Task]\nTask: recovered-task",
        },
      },
      {
        type: "tool.result",
        data: {
          output: finalReport,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Done." },
          ],
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    await fs.promises.writeFile(sessionPath, sessionLog, "utf8");

    const task = {
      id: "recovered-task",
      title: "会话回收测试",
      description: "验证非末尾报告块也能被识别",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceThoughtId: "poll-test",
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    } as any;

    const recovered = __testOnlyExtractResultFromSessions(task, task.createdAt, true);
    assert.equal(recovered?.status, "completed");
    assert.match(recovered?.result ?? "", /完整报告已回收/);
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousHomedrive === undefined) delete process.env.HOMEDRIVE;
    else process.env.HOMEDRIVE = previousHomedrive;
    if (previousHomepath === undefined) delete process.env.HOMEPATH;
    else process.env.HOMEPATH = previousHomepath;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("session extraction ignores terminal reports read from a different task", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-session-foreign-report-"));
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = directory;
  process.env.HOME = directory;

  try {
    const { __testOnlyExtractResultFromSessions } = await import(`../src/autonomous-actions.js?foreign-report=${Date.now()}`);
    const sessionsDir = path.join(directory, ".openclaw", "agents", "main", "sessions");
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    const resultFilePath = path.join(directory, "current-result.md");
    const foreignReport = `Status: completed
Task: older-task

## Outcome
An older task completed.

## Changes
Changed an unrelated file.

## Verification
The older task's tests passed.`;
    await fs.promises.writeFile(path.join(sessionsDir, "foreign.jsonl"), [
      JSON.stringify({ type: "message", message: { role: "user", content: `[Soul Autonomous Improvement Task]\nTask: current-task\n${resultFilePath}` } }),
      JSON.stringify({ type: "tool.result", data: { output: foreignReport } }),
    ].join("\n"), "utf8");

    const task = {
      id: "current-task",
      title: "Ignore foreign report",
      description: "Do not reuse a report merely read by a tool",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    } as any;
    const recovered = __testOnlyExtractResultFromSessions(task, task.createdAt, false);
    assert.equal(recovered, null);
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("session extraction stops at the next user turn instead of capturing a later heartbeat", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-session-boundary-"));
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = directory;
  process.env.HOME = directory;

  try {
    const { __testOnlyExtractResultFromSessions } = await import(`../src/autonomous-actions.js?session-boundary=${Date.now()}`);
    const sessionsDir = path.join(directory, ".openclaw", "agents", "main", "sessions");
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    const resultFilePath = path.join(directory, "boundary-result.md");
    const sessionLog = [
      { type: "message", message: { role: "user", content: `[Soul Autonomous Improvement Task]\nTask: boundary-task\n${resultFilePath}` } },
      { type: "message", message: { role: "assistant", content: "Analysis found a stream timeout root cause in the autonomous result writer, but verification was not completed before the run ended." } },
      { type: "message", message: { role: "user", content: "Read HEARTBEAT.md and respond with the current heartbeat status." } },
      { type: "message", message: { role: "assistant", content: "HEARTBEAT_OK" } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    await fs.promises.writeFile(path.join(sessionsDir, "boundary.jsonl"), sessionLog, "utf8");

    const task = {
      id: "boundary-task",
      title: "Session boundary test",
      description: "Do not attribute later turns to this task",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    } as any;
    const recovered = __testOnlyExtractResultFromSessions(task, task.createdAt, false);
    assert.equal(recovered?.status, "failed");
    assert.match(recovered?.result ?? "", /stream timeout root cause/);
    assert.doesNotMatch(recovered?.result ?? "", /HEARTBEAT_OK/);
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("successful subagent runs with only skeleton output are downgraded to partial reports", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-skeleton-output-"));
  try {
    const { __testOnlyResolveSubagentFinalReport } = await import(`../src/autonomous-actions.js?skeleton-output=${Date.now()}`);
    const resultFilePath = path.join(directory, "result.md");
    await fs.promises.writeFile(resultFilePath, `Status: completed\n\n## Outcome\nAutonomous work has started.\n\n## Changes\nPending.\n\n## Verification\nPending.`, "utf8");

    const task = {
      id: "skeleton-output-task",
      title: "骨架输出测试",
      description: "验证成功但未产出完整报告时不会直接回写骨架稿",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceThoughtId: "report-test",
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    } as any;

    const report = await __testOnlyResolveSubagentFinalReport(task, resultFilePath, {
      runId: "run-1",
      success: true,
      output: `Status: completed\n\n## Outcome\nAutonomous work has started.\n\n## Changes\nPending.\n\n## Verification\nPending.`,
      error: "",
    } as any, true);

    assert.match(report, /^Status: partial/m);
    assert.match(report, /did not produce a complete final report/);
    assert.match(report, /Autonomous work has started\./);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("heading-only reports are downgraded to partial reports", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-heading-only-report-"));
  try {
    const { __testOnlyResolveSubagentFinalReport } = await import(`../src/autonomous-actions.js?heading-only=${Date.now()}`);
    const resultFilePath = path.join(directory, "result.md");
    const headingOnly = `Status: completed\n\n## Outcome\n\n## Changes\n\n## Verification\n`;
    await fs.promises.writeFile(resultFilePath, headingOnly, "utf8");

    const task = {
      id: "heading-only-task",
      title: "标题空壳测试",
      description: "验证只有标题没有正文的报告不会被当作最终结果",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceThoughtId: "report-test",
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    } as any;

    const report = await __testOnlyResolveSubagentFinalReport(task, resultFilePath, {
      runId: "run-2",
      success: true,
      output: headingOnly,
      error: "",
    } as any, true);

    assert.match(report, /^Status: partial/m);
    assert.match(report, /did not produce a complete final report/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("successful subagent runs wait for a delayed final report write", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-delayed-success-report-"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { __testOnlyResolveSubagentFinalReport } = await import(`../src/autonomous-actions.js?delayed-success=${Date.now()}`);
    const resultFilePath = path.join(directory, "result.md");
    const finalReport = `Status: completed

## Outcome
最终报告在成功返回后稍晚落盘。

## Changes
已修复子代理收尾的竞态。

## Verification
会话与结果文件都能回收到完整报告。`;
    await fs.promises.writeFile(resultFilePath, `Status: completed\n\n## Outcome\nAutonomous work has started.\n\n## Changes\nPending.\n\n## Verification\nPending.`, "utf8");

    timer = setTimeout(() => {
      void fs.promises.writeFile(resultFilePath, finalReport, "utf8");
    }, 4_000);

    const task = {
      id: "delayed-success-task",
      title: "延迟落盘测试",
      description: "验证成功返回后稍晚写入的最终报告仍能被回收",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceThoughtId: "report-test",
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    } as any;

    const report = await __testOnlyResolveSubagentFinalReport(task, resultFilePath, {
      runId: "run-delayed",
      success: true,
      output: `Status: completed\n\n## Outcome\nAutonomous work has started.\n\n## Changes\nPending.\n\n## Verification\nPending.`,
      error: "",
    } as any, true);

    assert.match(report, /最终报告在成功返回后稍晚落盘/);
    assert.match(report, /^Status: completed/m);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("a session partial report does not preempt a delayed complete result file", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-partial-before-final-"));
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = directory;
  process.env.HOME = directory;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { __testOnlyResolveSubagentFinalReport } = await import(`../src/autonomous-actions.js?partial-before-final=${Date.now()}`);
    const resultFilePath = path.join(directory, "result.md");
    const sessionsDir = path.join(directory, ".openclaw", "agents", "main", "sessions");
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    await fs.promises.writeFile(resultFilePath, `Status: in-progress\n\n## Outcome\nWorking.\n\n## Changes\nPending.\n\n## Verification\nPending.`, "utf8");
    const partialReport = `Status: partial\n\n## Outcome\nThe runner stopped before the report file settled.\n\n## Changes\nA change may have been made.\n\n## Verification\nVerification output was not recovered.`;
    await fs.promises.writeFile(path.join(sessionsDir, "partial.jsonl"), [
      JSON.stringify({ type: "message", message: { role: "user", content: `[Soul Autonomous Improvement Task]\nTask: partial-before-final-task\n${resultFilePath}` } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: partialReport } }),
    ].join("\n"), "utf8");

    const completeReport = `Status: completed\n\n## Outcome\nThe delayed final report was recovered.\n\n## Changes\nFixed the settlement race.\n\n## Verification\nThe targeted regression test passed.`;
    timer = setTimeout(() => { void fs.promises.writeFile(resultFilePath, completeReport, "utf8"); }, 1_000);
    const task = {
      id: "partial-before-final-task",
      title: "Prefer delayed final report",
      description: "Do not settle on an early partial session summary",
      status: "in-progress",
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
      sourceThoughtId: "report-test",
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    } as any;

    const report = await __testOnlyResolveSubagentFinalReport(task, resultFilePath, {
      runId: "run-partial-before-final",
      success: true,
      output: partialReport,
      error: "",
    } as any, false);

    assert.match(report, /^Status: completed/m);
    assert.match(report, /delayed final report was recovered/);
    assert.doesNotMatch(report, /runner stopped before the report file settled/);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("session recovery prefers a complete report written after a prompt error", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-error-then-report-"));
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  const previousHomedrive = process.env.HOMEDRIVE;
  const previousHomepath = process.env.HOMEPATH;
  process.env.USERPROFILE = directory;
  process.env.HOME = directory;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  try {
    const { __testOnlyExtractResultFromSessions } = await import(`../src/autonomous-actions.js?error-then-report=${Date.now()}`);
    const sessionsDir = path.join(directory, ".openclaw", "agents", "main", "sessions");
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    const resultFilePath = path.join(directory, "result.md");
    const finalReport = `Status: completed\nTask: error-then-report-task\n\n## Outcome\nRecovered after a transient prompt error.\n\n## Changes\nKept the complete report.\n\n## Verification\nRecovery test passed.`;
    await fs.promises.writeFile(path.join(sessionsDir, "recovered.jsonl"), [
      JSON.stringify({ type: "message", message: { role: "user", content: `[Soul Autonomous Improvement Task]\nTask: error-then-report-task\n${resultFilePath}` } }),
      JSON.stringify({ type: "custom", customType: "openclaw:prompt-error", data: { error: "temporary timeout" } }),
      JSON.stringify({ type: "tool.result", data: { output: finalReport } }),
    ].join("\n"), "utf8");
    const task = {
      id: "error-then-report-task",
      title: "Recover after prompt error",
      description: "A later report is authoritative",
      status: "in-progress",
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now(),
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    } as any;

    const recovered = __testOnlyExtractResultFromSessions(task, task.createdAt, false);
    assert.equal(recovered?.status, "completed");
    assert.match(recovered?.result ?? "", /Recovered after a transient prompt error/);
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousHomedrive === undefined) delete process.env.HOMEDRIVE;
    else process.env.HOMEDRIVE = previousHomedrive;
    if (previousHomepath === undefined) delete process.env.HOMEPATH;
    else process.env.HOMEPATH = previousHomepath;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("timed out subagent output can still recover a complete final report", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-timeout-output-report-"));
  try {
    const { __testOnlyResolveSubagentFinalReport } = await import(`../src/autonomous-actions.js?timeout-output=${Date.now()}`);
    const resultFilePath = path.join(directory, "result.md");
    await fs.promises.writeFile(resultFilePath, `Status: completed\n\n## Outcome\nAutonomous work has started.\n\n## Changes\nPending.\n\n## Verification\nPending.`, "utf8");

    const finalReport = `Status: completed\n\n## Outcome\n子代理在超时前已经把完整终稿写进输出。\n\n## Changes\n已补上输出回收路径。\n\n## Verification\n即使 success=false，只要输出本身是完整报告也应被回收。`;
    const task = {
      id: "timeout-output-task",
      title: "超时输出回收测试",
      description: "验证非成功返回但输出本身完整时仍能恢复终稿",
      status: "in-progress",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceThoughtId: "report-test",
      steps: [],
      resultFilePath,
      requiresWritePermission: true,
      resultDelivered: false,
    } as any;

    const report = await __testOnlyResolveSubagentFinalReport(task, resultFilePath, {
      runId: "run-timeout",
      success: false,
      output: finalReport,
      error: "TimeoutError: subagent exceeded its budget",
    } as any, true);

    assert.match(report, /^Status: completed/m);
    assert.match(report, /输出回收路径/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("subagent improvement returns the full final report instead of a truncated summary", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-long-final-report-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(directory, "state");

  try {
    const { executeSubagentImprove } = await import(`../src/autonomous-actions.js?long-final-report=${Date.now()}`);
    const ego = createDefaultEgoState();
    ego.activeTasks = [];

    const tailMarker = "TAIL_MARKER_9f2d1c";
    const longBody = `${"长报告内容 ".repeat(1800)}${tailMarker}`;
    const finalReport = `Status: completed

## Outcome
${longBody}

## Changes
- src/autonomous-actions.ts: removed truncation from returned subagent reports.

## Verification
The long report reached the caller intact.`;

    const thought = {
      id: "long-final-report-thought",
      type: "self-improvement-monitor",
      content: "Preserve the entire final report when returning subagent improvement results.",
      motivation: "subagent reliability",
      targetMetrics: [],
      priority: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      actionType: "subagent-improve",
      actionParams: { maintenanceFocus: "subagent-reliability" },
    } as any;

    const result = await executeSubagentImprove(thought, ego, {
      autonomousActions: false,
      gatewayPort: 18789,
      workspaceContext: "K:\\test_code\\openclaw-soul",
      subAgentRunner: async () => ({
        runId: "long-report-run",
        success: true,
        output: finalReport,
        error: "",
      }),
    } as any);

    assert.equal(result.result.success, true);
    assert.equal(result.result.result, finalReport);
    assert.match(result.result.result ?? "", /TAIL_MARKER_9f2d1c/);
    assert.match(result.result.result ?? "", /## Verification/);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("completed placeholder reports are localized by the model instead of a fixed template", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-placeholder-summary-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(directory, "state");

  try {
    const { executeReportFindings } = await import(`../src/autonomous-actions.js?placeholder-summary=${Date.now()}`);
    const ego = createDefaultEgoState();
    ego.userLanguage = "zh-CN";
    ego.activeTasks = [{
      id: "placeholder-summary-task",
      title: "占位稿汇报",
      description: "确认完成态占位稿不会被误报为已完成",
      status: "completed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now(),
      sourceThoughtId: "report-test",
      steps: [],
      resultDelivered: false,
      result: `Status: completed
Task: placeholder-summary-task
Finished: 2026-07-20T00:00:00.000Z

## Outcome
Autonomous work has started. This placeholder must be replaced with a final report before the task is considered done.

## Changes
Pending.

## Verification
Pending.

## Metrics
Pending.

## Next
Pending.`,
    }] as any;

    let sent = "";
    let prompt = "";
    const result = await executeReportFindings({
      id: "report-thought-placeholder",
      type: "opportunity-detected",
      content: "report",
      motivation: "report",
      targetMetrics: [],
      priority: 1,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      actionType: "report-findings",
    } as any, ego, {
      autonomousActions: false,
      gatewayPort: 18789,
      channel: "test",
      target: "user",
      sendMessage: async ({ content }: { content: string }) => { sent = content; },
      llmGenerator: async (value: string) => { prompt = value; return "这项任务仍是占位报告，尚未完成验证。"; },
    });

    assert.equal(result.result.success, true);
    assert.match(prompt, /BCP-47 zh-CN/);
    assert.equal(sent, "这项任务仍是占位报告，尚未完成验证。");
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("Chinese task reports are passed to the model for a localized user-facing message", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-autonomous-report-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(directory, "state");

  try {
    const { executeReportFindings } = await import(`../src/autonomous-actions.js?report=${Date.now()}`);
    const ego = createDefaultEgoState();
    ego.userLanguage = "zh-CN";
    ego.activeTasks = [{
      id: "blocked-report",
      title: "检查中文报告",
      description: "验证报告状态和字段提取",
      status: "completed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now(),
      sourceThoughtId: "report-test",
      steps: [],
      resultDelivered: false,
      result: `Status: blocked

## 结果
外部服务仍不可用，因此没有完成修复。

## 变更
- src/example.ts：未修改，避免在缺少证据时提交风险改动。

## 验证
已确认服务连接持续失败。

## 指标
成功请求：0。

## 下一步
恢复服务后重试。`,
    }] as any;

    let sent = "";
    let prompt = "";
    const result = await executeReportFindings({
      id: "report-thought",
      type: "opportunity-detected",
      content: "report",
      motivation: "report",
      targetMetrics: [],
      priority: 1,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      actionType: "report-findings",
    } as any, ego, {
      autonomousActions: false,
      gatewayPort: 18789,
      channel: "test",
      target: "user",
      sendMessage: async ({ content }: { content: string }) => { sent = content; },
      llmGenerator: async (value: string) => { prompt = value; return "外部服务仍不可用，所以这次没有提交修改。"; },
    });

    assert.equal(result.result.success, true);
    assert.match(prompt, /BCP-47 zh-CN/);
    assert.match(prompt, /外部服务仍不可用/);
    assert.equal(sent, "外部服务仍不可用，所以这次没有提交修改。");
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("completed task reports use completion wording instead of investigation wording", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-completion-summary-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(directory, "state");

  try {
    const { executeReportFindings } = await import(`../src/autonomous-actions.js?completion-summary=${Date.now()}`);
    const ego = createDefaultEgoState();
    ego.userLanguage = "zh-CN";
    ego.activeTasks = [{
      id: "completed-report",
      title: "子代理报告可靠性修复",
      description: "避免成功任务被误报为 partial",
      status: "completed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now(),
      sourceThoughtId: "report-test",
      steps: [],
      resultDelivered: false,
      result: `Status: completed

## Outcome
修复了成功后报告落盘的竞态。

## Changes
- src/autonomous-actions.ts：增加成功后落盘等待窗口。

## Verification
- npm test -- autonomous-report 通过。`,
    }] as any;

    let sent = "";
    let prompt = "";
    const result = await executeReportFindings({
      id: "completed-report-thought",
      type: "opportunity-detected",
      content: "report",
      motivation: "report",
      targetMetrics: [],
      priority: 1,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      actionType: "report-findings",
    } as any, ego, {
      autonomousActions: false,
      gatewayPort: 18789,
      channel: "test",
      target: "user",
      sendMessage: async ({ content }: { content: string }) => { sent = content; },
      // Simulate the old, ambiguous opening; the delivery layer must still
      // make a completed task unmistakably look completed to the user.
      llmGenerator: async (value: string) => { prompt = value; return "我查了子代理报告可靠性问题，已经补上等待窗口并通过测试。"; },
    });

    assert.equal(result.result.success, true);
    assert.match(prompt, /Delivery status: COMPLETED/);
    assert.match(prompt, /completion notification/);
    assert.equal(sent, "已完成：子代理报告可靠性问题，已经补上等待窗口并通过测试。");
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("report composition failure leaves the durable task pending for retry", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-report-composition-retry-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(directory, "state");

  try {
    const { executeReportFindings } = await import(`../src/autonomous-actions.js?composition-retry=${Date.now()}`);
    const storePath = path.join(process.env.OPENCLAW_STATE_DIR, "soul", "ego.json");
    const ego = createDefaultEgoState();
    ego.userLanguage = "zh-CN";
    ego.activeTasks = [{
      id: "composition-retry-task",
      title: "报告重试",
      description: "模型过载时保留待投递状态",
      status: "completed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now(),
      steps: [],
      resultDelivered: false,
      result: `Status: completed

## Outcome
修复了投递状态。

## Changes
更新了报告重试逻辑。

## Verification
回归测试通过。`,
      requiresWritePermission: true,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: Date.now(), updatedAt: Date.now() });

    const result = await executeReportFindings({
      id: "composition-retry-thought",
      actionType: "report-findings",
    } as any, ego, {
      autonomousActions: false,
      gatewayPort: 18789,
      channel: "test",
      target: "user",
      sendMessage: async () => undefined,
      llmGenerator: async () => { throw new Error("503 overloaded"); },
    });

    assert.equal(result.result.success, false);
    const stored = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    assert.equal(stored.ego.activeTasks[0].resultDelivered, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("a failed send is retried and only marked delivered after confirmed delivery", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-report-send-retry-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(directory, "state");

  try {
    const { executeReportFindings } = await import(`../src/autonomous-actions.js?send-retry=${Date.now()}`);
    const storePath = path.join(process.env.OPENCLAW_STATE_DIR, "soul", "ego.json");
    const ego = createDefaultEgoState();
    ego.userLanguage = "zh-CN";
    ego.activeTasks = [{
      id: "send-retry-task",
      title: "发送重试",
      description: "通道短暂失败后重试",
      status: "completed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now(),
      steps: [],
      resultDelivered: false,
      result: `Status: completed

## Outcome
已产生一份有价值的报告。

## Changes
增加了可靠投递。

## Verification
发送重试测试通过。`,
      requiresWritePermission: true,
    }] as any;
    await saveEgoStore(storePath, { version: 3, ego, createdAt: Date.now(), updatedAt: Date.now() });

    let sendAttempts = 0;
    const options = {
      autonomousActions: false,
      gatewayPort: 18789,
      channel: "test",
      target: "user",
      sendMessage: async () => {
        sendAttempts++;
        if (sendAttempts === 1) throw new Error("temporary channel outage");
      },
      llmGenerator: async () => "已完成：报告投递可靠性修复，并通过发送重试测试。",
    };
    const thought = { id: "send-retry-thought", actionType: "report-findings" } as any;

    const first = await executeReportFindings(thought, ego, options);
    assert.equal(first.result.success, false);
    let stored = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    assert.equal(stored.ego.activeTasks[0].resultDelivered, false);

    const second = await executeReportFindings(thought, ego, options);
    assert.equal(second.result.success, true);
    assert.equal(sendAttempts, 2);
    stored = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    assert.equal(stored.ego.activeTasks[0].resultDelivered, true);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
