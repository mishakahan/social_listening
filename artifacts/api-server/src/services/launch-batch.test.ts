import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkKeywords } from "./launch-batch.js";

function keywordList(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `keyword-${i}`);
}

test("828-keyword list at the default YouTube chunk size (40) produces 21 runs", () => {
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
  // 828 keywords at chunk size 40 -> 21 chunks, but capped to 10 runs
  // (the YOUTUBE_MAX_KEYWORD_RUNS default).
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
