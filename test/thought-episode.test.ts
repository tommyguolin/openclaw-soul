import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThoughtEpisodeStore } from "../src/cognition/thought-store.js";

test("ThoughtEpisode evolves through support and revision instead of duplicate immutable thoughts", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-thought-episode-"));
  const store = new ThoughtEpisodeStore(path.join(dir, "thought-episodes.json"));
  const first = await store.integrate({
    workspaceId: "w1", content: "The timeout may be related to long embedding input.",
    epistemicNature: "claim", causalTraceIds: ["memory:m1"], stimulusId: "s1",
    evidence: [{ sourceId: "m1", relation: "context", grounded: true, strength: 0.7, observedAt: 1 }],
  });
  const support = await store.integrate({
    workspaceId: "w2", content: "The timeout may be related to long embedding input.",
    epistemicNature: "claim", causalTraceIds: ["memory:m2"], stimulusId: "s2",
    evidence: [{ sourceId: "m2", relation: "supports", grounded: true, strength: 0.8, observedAt: 2 }],
  });
  assert.equal(first.episode.id, support.episode.id);
  assert.equal(support.operation, "supported");
  assert.equal(support.episode.state, "stable");
  assert.equal(support.episode.distinctStimulusIds.length, 2);

  const revised = await store.integrate({
    workspaceId: "w3", content: "It is not retry timing but the embedding input length boundary.",
    epistemicNature: "reframing", causalTraceIds: ["memory:m2"], stimulusId: "s3",
    evidence: [{ sourceId: "m3", relation: "refines", grounded: true, strength: 0.9, observedAt: 3 }],
  });
  assert.equal(revised.episode.id, first.episode.id);
  assert.equal(revised.operation, "contradicted");
  assert.equal(revised.episode.state, "revised");
  assert.equal(revised.episode.revisions.length, 1);
});

test("explicit resolution supersedes a related active ThoughtEpisode", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "soul-thought-resolution-"));
  const store = new ThoughtEpisodeStore(path.join(dir, "thought-episodes.json"));
  const first = await store.integrate({
    workspaceId: "w1", content: "SSH access to the remote server may still be failing.",
    epistemicNature: "claim", causalTraceIds: ["memory:m1"], stimulusId: "s1", evidence: [],
  });
  const changed = await store.supersedeRelated("SSH access to the remote server is resolved and works now.", "resolution-1");
  assert.equal(changed[0]?.id, first.episode.id);
  assert.equal((await store.load()).episodes[0].state, "superseded");
});
