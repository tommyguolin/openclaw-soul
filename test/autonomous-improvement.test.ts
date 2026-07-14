import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IntentionStore } from "../src/intention/store.js";
import { WorkHandoffStore } from "../src/handoff/store.js";

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

    const [{ executeAutonomousAction, executeObserveAndImprove }, { createDefaultEgoState }] = await Promise.all([
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
    let ambiguousPromptCalled = false;
    const ambiguousThought = {
      ...thought,
      id: "ambiguous-container-test",
      content: `Improve ${containerDir}`,
      createdAt: Date.now() + 2,
    };
    const ambiguous = await executeObserveAndImprove(ambiguousThought, ego, {
      autonomousActions: false,
      gatewayPort: 18789,
      llmGenerator: async () => {
        ambiguousPromptCalled = true;
        return "{}";
      },
    });
    assert.equal(ambiguous.result.success, false);
    assert.equal(ambiguousPromptCalled, false);
    assert.match(ambiguous.result.error ?? "", /ambiguous|does not resolve/i);

    ego.projectContexts = [{
      root: projectDir,
      name: "sample-project",
      source: "agent-tool",
      confidence: 1,
      sessionKey: "agent:main:feishu:direct:user",
      lastObservedAt: Date.now(),
      lastModifiedAt: Date.now(),
      observedFiles: ["app.js"],
      modifiedFiles: ["app.js"],
      verificationCommands: ["npm run typecheck"],
    }];
    ego.activeProjectRoot = projectDir;
    const intentionStore = new IntentionStore(path.join(stateDir, "soul", "intentions.json"));
    const linkedIntention = (await intentionStore.add({
      desiredState: "Improve the project and verify the change",
      origin: "user-directive",
      originId: "bridge-directive",
      commitment: 1,
      urgency: 0.8,
      confidence: 0.95,
      evidenceNeeded: ["concrete changed files", "relevant verification command passes"],
      constraints: ["preserve user scope"],
      status: "active",
    })).intention;
    const workHandoffStore = new WorkHandoffStore(path.join(stateDir, "soul", "work-handoffs.json"));
    const linkedHandoff = await workHandoffStore.upsert({
      intentionId: linkedIntention.id,
      objective: linkedIntention.desiredState,
      targetProjectRoot: projectDir,
      phase: "implementing",
      acceptanceCriteria: linkedIntention.evidenceNeeded,
      observedFiles: ["app.js"],
      modifiedFiles: ["app.js"],
      verificationCommands: [],
      failedTools: [],
    });
    let bridgedPrompt = "";
    const bridgedThought = {
      ...thought,
      id: "project-context-bridge-test",
      content: "Improve the project the main agent just edited",
      createdAt: Date.now() + 3,
      actionParams: {
        intentionId: linkedIntention.id,
        workHandoffId: linkedHandoff.id,
        projectRoot: projectDir,
        objective: "Improve the project and verify the change",
        priorWorkPhase: "implementing",
        acceptanceCriteria: ["concrete changed files", "relevant verification command passes"],
        priorModifiedFiles: ["app.js"],
        priorVerificationCommands: ["npm run typecheck"],
        priorFailedTools: [],
      },
    };
    const bridged = await executeObserveAndImprove(bridgedThought, ego, {
      autonomousActions: false,
      gatewayPort: 18789,
      llmGenerator: async (prompt: string) => {
        bridgedPrompt = prompt;
        return JSON.stringify({
          problem: "No grounded issue found.",
          file: "",
          oldCode: "",
          newCode: "",
          explanation: "No safe recommendation.",
        });
      },
    });
    assert.equal(bridged.result.success, true);
    assert.match(bridgedPrompt, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(bridgedPrompt, /Recently modified files: app\.js/);
    assert.match(bridgedPrompt, /Verification commands already used: npm run typecheck/);
    assert.match(bridgedPrompt, /Durable work handoff/);
    assert.match(bridgedPrompt, new RegExp(`Handoff: ${linkedHandoff.id}`));
    assert.doesNotMatch(bridgedPrompt, /Soul plugin itself/);
    store = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    const bridgedTask = store.ego.activeTasks.find((task: any) => task.sourceThoughtId === bridgedThought.id);
    assert.equal(bridgedTask.intentionId, linkedIntention.id);
    assert.equal(bridgedTask.workHandoffId, linkedHandoff.id);
    assert.equal(bridgedTask.targetProjectRoot, projectDir);
    assert.deepEqual(bridgedTask.acceptanceCriteria, ["concrete changed files", "relevant verification command passes"]);
    assert.match(bridgedTask.result, /## Acceptance/);
    assert.match(bridgedTask.result, /\[ \] concrete changed files/);
    assert.equal((await intentionStore.load()).intentions[0].status, "blocked");
    assert.equal((await workHandoffStore.load()).handoffs[0].phase, "blocked");

    const analysisThought = {
      ...thought,
      id: "analysis-cannot-complete-implementation-test",
      content: "Please fix it",
      motivation: "act on the implementation directive",
      actionType: "analyze-problem",
      actionParams: {
        intentionId: linkedIntention.id,
        workHandoffId: linkedHandoff.id,
        projectRoot: projectDir,
        acceptanceCriteria: ["concrete changed files", "relevant verification command passes"],
      },
    };
    const analysis = await executeAutonomousAction("analyze-problem", analysisThought, ego, {
      autonomousActions: true,
      gatewayPort: 18789,
    });
    assert.equal(analysis.result.success, false);
    store = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    const analysisTask = store.ego.activeTasks.find((task: any) => task.sourceThoughtId === analysisThought.id);
    assert.equal(analysisTask.status, "failed");
    assert.match(analysisTask.result, /Status: blocked/);
    assert.match(analysisTask.result, /acceptance-criteria-not-met/);
    assert.match(analysisTask.result, /concrete changed files/);
    assert.match(analysisTask.result, /verification command passes/);

    // This mirrors a fresh Soul state: no host-agent project handoff is
    // available, only an explicit reference to the linked Soul project.
    ego.projectContexts = [];
    ego.activeProjectRoot = null;
    let namedSoulPrompt = "";
    const namedSoulThought = {
      ...thought,
      id: "named-soul-project-test",
      content: "Improve openclaw-soul after reviewing /src and K:\\test_code",
      actionParams: {
        objective: "Continue improving the openclaw-soul project and verify one bounded change.",
      },
    };
    const namedSoul = await executeObserveAndImprove(namedSoulThought, ego, {
      autonomousActions: false,
      gatewayPort: 18789,
      llmGenerator: async (prompt: string) => {
        namedSoulPrompt = prompt;
        return JSON.stringify({
          problem: "No grounded issue found.",
          file: "",
          oldCode: "",
          newCode: "",
          explanation: "No safe recommendation.",
        });
      },
    });
    assert.equal(namedSoul.result.success, true);
    assert.match(namedSoulPrompt, /This is the Soul plugin itself/);
    assert.doesNotMatch(namedSoulPrompt, /This is project at K:\\test_code/);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
