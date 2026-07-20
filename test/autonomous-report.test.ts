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

test("Chinese task reports preserve their fields and do not present blocked work as complete", async () => {
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
    });

    assert.equal(result.result.success, true);
    assert.match(sent, /⚠️ 自主任务未完成/);
    assert.match(sent, /结果:\n外部服务仍不可用/);
    assert.match(sent, /变更说明:[\s\S]*src\/example\.ts/);
    assert.match(sent, /验证:[\s\S]*服务连接持续失败/);
    assert.match(sent, /指标:[\s\S]*成功请求：0/);
    assert.doesNotMatch(sent, /✅ 自主任务已完成/);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
