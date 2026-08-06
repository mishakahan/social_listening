import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIPELINE_STAGES,
  nextStage,
  startPipelineRun,
  getPipelineRun,
  resetPipelineRun,
  __resetRunsForTest,
  type StageDeps,
} from "./pipeline-runner.js";

function okDeps(calls: string[]): StageDeps {
  return {
    scrape: async () => { calls.push("scrape"); },
    ingest: async () => { calls.push("ingest"); },
    extract: async () => { calls.push("extract"); },
    timeseries: async () => { calls.push("timeseries"); },
    "state-machine": async () => { calls.push("state-machine"); },
  };
}

test("stages run in pipeline order", async () => {
  __resetRunsForTest();
  const calls: string[] = [];
  await startPipelineRun(1, okDeps(calls));
  assert.deepEqual(calls, [...PIPELINE_STAGES]);
});

test("a completed run reports done", async () => {
  __resetRunsForTest();
  await startPipelineRun(1, okDeps([]));
  const s = getPipelineRun(1);
  assert.equal(s?.status, "done");
  assert.equal(s?.stageIndex, PIPELINE_STAGES.length);
});

test("a failing stage halts the pipeline and records the error", async () => {
  __resetRunsForTest();
  const calls: string[] = [];
  const deps = okDeps(calls);
  deps.extract = async () => { throw new Error("extraction blew up"); };
  await startPipelineRun(1, deps);
  const s = getPipelineRun(1);
  assert.equal(s?.status, "failed");
  assert.equal(s?.stage, "extract");
  assert.match(s?.error ?? "", /extraction blew up/);
  assert.deepEqual(calls, ["scrape", "ingest"]);
});

test("a second run is refused while one is in flight", async () => {
  __resetRunsForTest();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const deps = okDeps([]);
  deps.scrape = async () => { await gate; };
  const first = startPipelineRun(2, deps);
  await assert.rejects(() => startPipelineRun(2, okDeps([])), /already running/i);
  release();
  await first;
});

test("nextStage walks the sequence and terminates", () => {
  assert.equal(nextStage("scrape"), "ingest");
  assert.equal(nextStage("state-machine"), null);
});

// --- Fix round 1: honest status when nothing was ingested -----------------

test("an ingest stage that finds nothing stops the run at 'awaiting-data', not 'done'", async () => {
  __resetRunsForTest();
  const calls: string[] = [];
  const deps = okDeps(calls);
  deps.ingest = async () => {
    calls.push("ingest");
    return { itemsProcessed: 0 };
  };
  const s = await startPipelineRun(3, deps);
  assert.equal(s.status, "awaiting-data");
  assert.equal(s.stage, "ingest");
  // extract/timeseries/state-machine must NOT have run against nothing.
  assert.deepEqual(calls, ["scrape", "ingest"]);
});

test("an ingest stage that reports work done proceeds to a genuine 'done'", async () => {
  __resetRunsForTest();
  const calls: string[] = [];
  const deps = okDeps(calls);
  deps.ingest = async () => {
    calls.push("ingest");
    return { itemsProcessed: 3 };
  };
  const s = await startPipelineRun(4, deps);
  assert.equal(s.status, "done");
  assert.deepEqual(calls, [...PIPELINE_STAGES]);
});

test("a stage returning void (no opinion) behaves exactly as before — proceeds to done", async () => {
  __resetRunsForTest();
  const calls: string[] = [];
  const s = await startPipelineRun(4, okDeps(calls));
  assert.equal(s.status, "done");
  assert.deepEqual(calls, [...PIPELINE_STAGES]);
});

// --- Fix round 1: stage timeout --------------------------------------------

test("a stage that never resolves is failed by the timeout instead of hanging forever", async () => {
  __resetRunsForTest();
  const deps = okDeps([]);
  deps.scrape = () => new Promise<void>(() => {}); // never settles
  const s = await startPipelineRun(5, deps, { stageTimeoutMs: 20 });
  assert.equal(s.status, "failed");
  assert.equal(s.stage, "scrape");
  assert.match(s.error ?? "", /timed out/i);
});

// --- Fix round 1: manual reset ---------------------------------------------

test("resetPipelineRun clears a running state so a new run can start immediately", async () => {
  __resetRunsForTest();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const deps = okDeps([]);
  deps.scrape = async () => {
    await gate;
  };
  const first = startPipelineRun(6, deps);

  const cleared = resetPipelineRun(6);
  assert.equal(cleared?.status, "failed");
  assert.equal(cleared?.error, "Manually reset");
  assert.equal(getPipelineRun(6)?.status, "failed");

  // A new run can start right away — no "already running" refusal.
  const secondCalls: string[] = [];
  const second = await startPipelineRun(6, okDeps(secondCalls));
  assert.equal(second.status, "done");

  // Letting the original, now-superseded run finally resolve must not
  // stomp the second run's outcome.
  release();
  await first;
  assert.equal(getPipelineRun(6)?.status, "done");
  assert.equal(getPipelineRun(6)?.runId, second.runId);
});

test("resetPipelineRun is a no-op when nothing is running", () => {
  __resetRunsForTest();
  assert.equal(resetPipelineRun(7), null);
});
