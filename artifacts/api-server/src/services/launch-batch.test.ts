import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkKeywords,
  estimateBatchCostUsd,
  enforceBatchCostCeiling,
} from "./launch-batch.js";

function keywordList(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `keyword-${i}`);
}

test("an 828-keyword list at a chunk size of 40 produces 21 runs", () => {
  const result = chunkKeywords(keywordList(828), 40, /* maxRuns */ 1000);
  assert.equal(result.chunks.length, 21); // ceil(828 / 40)
  assert.equal(result.truncated, false);
  assert.deepEqual(result.droppedKeywords, []);
});

test("chunks partition the input exactly: no keyword dropped, none duplicated", () => {
  const input = keywordList(828);
  const result = chunkKeywords(input, 40, 1000);
  const flattened = result.chunks.flat();
  assert.equal(flattened.length, input.length);
  assert.deepEqual([...flattened].sort(), [...input].sort());
  assert.equal(new Set(flattened).size, input.length); // no duplicates
});

test("a keyword list smaller than one chunk yields exactly one run", () => {
  const result = chunkKeywords(["a", "b", "c"], 40, 1000);
  assert.equal(result.chunks.length, 1);
  assert.deepEqual(result.chunks[0], ["a", "b", "c"]);
  assert.equal(result.truncated, false);
});

test("an empty keyword list yields no runs", () => {
  const result = chunkKeywords([], 40, 1000);
  assert.deepEqual(result.chunks, []);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.droppedKeywords, []);
});

test("a keyword list of only whitespace entries yields no runs", () => {
  const result = chunkKeywords(["  ", "", "\t"], 40, 1000);
  assert.deepEqual(result.chunks, []);
  assert.equal(result.truncated, false);
});

test("the per-platform run cap (maxRuns) is respected and truncation is visible", () => {
  // 828 keywords at chunk size 40 -> 21 chunks, but capped to 10 runs.
  const input = keywordList(828);
  const result = chunkKeywords(input, 40, 10);
  assert.equal(result.chunks.length, 10);
  assert.equal(result.truncated, true);
  // Every dropped keyword is accounted for and nothing was silently lost.
  assert.equal(result.droppedKeywords.length, input.length - 10 * 40);
  const kept = result.chunks.flat();
  assert.equal(kept.length + result.droppedKeywords.length, input.length);
  assert.deepEqual(
    [...kept, ...result.droppedKeywords].sort(),
    [...input].sort()
  );
});

test("maxRuns cap of exactly the chunk count does not mark truncated", () => {
  const result = chunkKeywords(keywordList(80), 40, 2); // exactly 2 chunks, cap 2
  assert.equal(result.chunks.length, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.droppedKeywords, []);
});

// ---------------------------------------------------------------------------
// Pre-flight cost gate
// ---------------------------------------------------------------------------

function platformRuns(counts: Record<string, number>): { platform: string }[] {
  return Object.entries(counts).flatMap(([platform, n]) =>
    Array.from({ length: n }, () => ({ platform }))
  );
}

test("estimateBatchCostUsd sums real per-run rates, not a flat count", () => {
  const estimate = estimateBatchCostUsd(
    platformRuns({ tiktok: 10, instagram: 2, reddit: 3, youtube: 1, x: 5 })
  );
  const close = (actual: number, expected: number) =>
    assert.ok(
      Math.abs(actual - expected) < 1e-9,
      `expected ~${expected}, got ${actual}`
    );
  assert.equal(estimate.byPlatform.tiktok!.runs, 10);
  close(estimate.byPlatform.tiktok!.usd, 1.0); // 10 * $0.10
  assert.equal(estimate.byPlatform.instagram!.runs, 2);
  close(estimate.byPlatform.instagram!.usd, 2.0); // 2 * $1.00
  close(estimate.byPlatform.reddit!.usd, 1.5); // 3 * $0.50
  close(estimate.byPlatform.youtube!.usd, 1.5); // 1 * $1.50
  close(estimate.byPlatform.x!.usd, 0.1); // 5 * $0.02
  const expectedTotal = 1.0 + 2.0 + 1.5 + 1.5 + 0.1;
  close(estimate.totalUsd, expectedTotal);
});

test("estimateBatchCostUsd refuses (throws) on a platform with no rate, not silently zero", () => {
  assert.throws(
    () => estimateBatchCostUsd(platformRuns({ tiktok: 1, xiaohongshu: 1 })),
    /xiaohongshu/
  );
});

test("an empty plan estimates to zero cost across the board", () => {
  const estimate = estimateBatchCostUsd([]);
  assert.equal(estimate.totalUsd, 0);
  assert.deepEqual(estimate.byPlatform, {});
});

test("enforceBatchCostCeiling passes a plan under the ceiling", () => {
  const estimate = estimateBatchCostUsd(platformRuns({ tiktok: 100 })); // $10.00
  assert.doesNotThrow(() => enforceBatchCostCeiling(estimate, 25));
});

test("enforceBatchCostCeiling passes a plan exactly at the ceiling", () => {
  const estimate = estimateBatchCostUsd(platformRuns({ instagram: 25 })); // $25.00
  assert.doesNotThrow(() => enforceBatchCostCeiling(estimate, 25));
});

test("enforceBatchCostCeiling throws a plan over the ceiling, naming estimate/ceiling/breakdown", () => {
  const estimate = estimateBatchCostUsd(
    platformRuns({ youtube: 20 }) // $30.00
  );
  assert.throws(
    () => enforceBatchCostCeiling(estimate, 25),
    (err: Error) => {
      assert.match(err.message, /\$30\.00/); // the estimate
      assert.match(err.message, /\$25\.00/); // the ceiling
      assert.match(err.message, /youtube: 20 runs = \$30\.00/); // the breakdown
      return true;
    }
  );
});

test("a batch over budget is never partially approved — the whole batch is refused", () => {
  // Mixed plan where most platforms are cheap but one pushes it over: the
  // gate must refuse the WHOLE estimate, not silently drop the expensive
  // platform and approve the rest.
  const estimate = estimateBatchCostUsd(
    platformRuns({ tiktok: 50, x: 50, youtube: 15 }) // 5 + 1 + 22.5 = $28.50
  );
  assert.ok(estimate.totalUsd > 25);
  assert.throws(() => enforceBatchCostCeiling(estimate, 25));
});
