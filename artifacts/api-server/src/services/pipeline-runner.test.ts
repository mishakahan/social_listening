import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIPELINE_STAGES,
  nextStage,
  startPipelineRun,
  getPipelineRun,
  __resetRunsForTest,
} from "./pipeline-runner.js";

function okDeps(calls: string[]) {
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
