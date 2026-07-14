import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("autonomous improvement reports concrete verified changes and never completes a no-change write run", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-improvement-"));
  const projectDir = path.join(directory, "sample-project");
  const stateDir = path.join(directory, "state");
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  try {
    await fs.promises.mkdir(projectDir, { recursive: true });
    await fs.promises.writeFile(path.join(projectDir, "package.json"), JSON.stringify({
      scripts: { typecheck: "node --check app.js" },
    }), "utf8");
    await fs.promises.writeFile(
      path.join(projectDir, "app.js"),
      "const retries = 0;\nconsole.log(retries);\n",
      "utf8",
    );

    const [{ executeObserveAndImprove }, { createDefaultEgoState }] = await Promise.all([
      import(`../src/autonomous-actions.js?improvement=${Date.now()}`),
      import("../src/ego-store.js"),
    ]);
    const ego = createDefaultEgoState();
    ego.userLanguage = "zh-CN";
    const thought = {
      id: "improvement-test",
      type: "self-improvement-monitor",
      content: `Improve ${projectDir}`,
      motivation: "apply one bounded fix",
      targetMetrics: [],
      priority: 90,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      actionType: "observe-and-improve",
    } as any;

    const applied = await executeObserveAndImprove(thought, ego, {
      autonomousActions: true,
      gatewayPort: 18789,
      llmGenerator: async () => JSON.stringify({
        problem: "The retry default prevents one initial retry.",
        file: "app.js",
        oldCode: "const retries = 0;",
        newCode: "const retries = 1;",
        explanation: "Enable one retry by default for transient failures.",
      }),
    });

    assert.equal(applied.result.success, true);
    assert.equal(applied.result.data?.fixApplied, true);
    assert.match(await fs.promises.readFile(path.join(projectDir, "app.js"), "utf8"), /retries = 1/);

    const storePath = path.join(stateDir, "soul", "ego.json");
    let store = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    const completed = store.ego.activeTasks.find((task: any) => task.sourceThoughtId === thought.id);
    assert.equal(completed.status, "completed");
    assert.match(completed.title, /sample-project/);
    assert.match(completed.result, /修改文件：app\.js/);
    assert.match(completed.result, /功能优化：Enable one retry/);
    assert.match(completed.result, /npm run typecheck passed/);
    assert.match(completed.result, /修改文件：1/);

    const noChangeThought = {
      ...thought,
      id: "no-change-test",
      content: `Improve ${projectDir}`,
      createdAt: Date.now() + 1,
    };
    const noChange = await executeObserveAndImprove(noChangeThought, ego, {
      autonomousActions: true,
      gatewayPort: 18789,
      llmGenerator: async () => JSON.stringify({
        problem: "No grounded issue found.",
        file: "",
        oldCode: "",
        newCode: "",
        explanation: "The inspected code does not justify another change.",
      }),
    });

    assert.equal(noChange.result.success, false);
    assert.equal(noChange.result.data?.fixApplied, false);
    store = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    const failed = store.ego.activeTasks.find((task: any) => task.sourceThoughtId === noChangeThought.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.result, /没有修改任何文件/);
    assert.match(failed.result, /不能把本次任务汇报成已完成的代码优化/);

    const containerDir = path.join(directory, "project-container");
    await fs.promises.mkdir(path.join(containerDir, "nested-project"), { recursive: true });
    await fs.promises.writeFile(
      path.join(containerDir, "nested-project", "package.json"),
      JSON.stringify({ name: "nested" }),
      "utf8",
    );
    let fallbackPrompt = "";
    const fallbackThought = {
      ...thought,
      id: "container-fallback-test",
      content: `Improve ${containerDir}`,
      createdAt: Date.now() + 2,
    };
    const fallback = await executeObserveAndImprove(fallbackThought, ego, {
      autonomousActions: false,
      gatewayPort: 18789,
      llmGenerator: async (prompt: string) => {
        fallbackPrompt = prompt;
        return JSON.stringify({
          problem: "No grounded issue found.",
          file: "",
          oldCode: "",
          newCode: "",
          explanation: "No safe recommendation.",
        });
      },
    });
    assert.equal(fallback.result.success, true);
    assert.match(fallbackPrompt, /Soul plugin itself/);
    assert.doesNotMatch(fallback.result.error ?? "", /No source files found/);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
