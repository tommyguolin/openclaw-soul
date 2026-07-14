import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveEgoStorePath } from "../src/ego-store.js";
import { resolveKnowledgeStorePath } from "../src/knowledge-store.js";

test("state directory overrides remain isolated even after modules are imported", () => {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const isolated = path.join(os.tmpdir(), `soul-state-isolation-${process.pid}`);
  try {
    process.env.OPENCLAW_STATE_DIR = isolated;
    assert.equal(resolveEgoStorePath(), path.join(isolated, "soul", "ego.json"));
    assert.equal(resolveKnowledgeStorePath(), path.join(isolated, "soul", "knowledge.json"));
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous;
  }
});
