import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkKeywords,
  estimateBatchCostUsd,
  estimateRunRecords,
  enforceBatchCostCeiling,
  effectiveRunFor,
  planPlatformsForQuery,
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

// Each planned run needs the keyword list it will actually be launched with,
// because record-billed actors' record counts are a function of that list.
function platformRuns(
  counts: Record<string, number>,
  keywordsPerRun = 1
): { platform: string; keywords: string[] }[] {
  return Object.entries(counts).flatMap(([platform, n]) =>
    Array.from({ length: n }, () => ({
      platform,
      keywords: keywordList(keywordsPerRun),
    }))
  );
}

const close = (actual: number, expected: number, tol = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < tol,
    `expected ~${expected}, got ${actual}`
  );

// ---------------------------------------------------------------------------
// The record-billing model. Every expectation below is pinned to a figure
// measured from real tp_actor_runs rows (2026-08-07), not to a chosen number.
// ---------------------------------------------------------------------------

test("a YouTube run's records are keywords x cap, not the cap — the per-query billing rule", () => {
  // The exact shape of company 2's single real YouTube run: 38 keywords, cap
  // 40 (the default YOUTUBE_RESULT_CAP), which fetched 1,520 records.
  assert.equal(
    estimateRunRecords({ platform: "youtube", keywords: keywordList(38) }),
    1520
  );
  // Doubling the keyword list doubles the records, and therefore the bill.
  assert.equal(
    estimateRunRecords({ platform: "youtube", keywords: keywordList(76) }),
    3040
  );
});

test("YouTube cost scales with the keyword list — the bug that priced 38 keywords at $1.50", () => {
  const estimate = estimateBatchCostUsd([
    { platform: "youtube", keywords: keywordList(38) },
  ]);
  assert.equal(estimate.byPlatform.youtube!.runs, 1);
  assert.equal(estimate.byPlatform.youtube!.records, 1520);
  // This is company 2's real YouTube run. Apify billed it $4.56, and
  // tp_actor_runs.cost_usd recorded exactly that. 1,520 x $0.003 = $4.56, so
  // the estimator must reproduce the actual invoice, not approximate it.
  close(estimate.totalUsd, 4.56, 1e-6);
  assert.ok(
    estimate.totalUsd > 3 * 1.5,
    "the corrected estimate must exceed the old flat $1.50/run for this run"
  );
});

test("single-keyword actors are unaffected by the keyword list (TikTok bills the run cap)", () => {
  // TikTok takes one keyword per run and caps the whole run, so its record
  // count must NOT scale with a longer list handed to the batch.
  const one = estimateRunRecords({ platform: "tiktok", keywords: ["a"] });
  const many = estimateRunRecords({ platform: "tiktok", keywords: keywordList(50) });
  assert.equal(one, many);
});

test("a run's cost never falls below its measured empty-run floor", () => {
  // TikTok's zero-record runs bill $0.0276 — MORE than a typical 39-record
  // run ($0.0113) — because a search that finds nothing spends longer
  // looking. A pure per-record model would price a thin run near zero and
  // systematically underestimate a sweep full of fruitless keywords.
  const thin = estimateBatchCostUsd([
    { platform: "tiktok", keywords: ["a"], hashtags: [] },
  ]);
  assert.ok(
    thin.totalUsd >= 0.0276,
    `a TikTok run must cost at least its $0.0276 floor, got $${thin.totalUsd}`
  );
});

test("cost is max(floor, records x marginal), not the sum of the two", () => {
  // An additive floor would overprice every normal run. At cap 200 TikTok is
  // 200 x $0.000296 = $0.0592, which is above the $0.0276 floor, so the
  // marginal term must win outright rather than stack on top of it.
  const est = estimateBatchCostUsd([{ platform: "tiktok", keywords: ["a"] }]);
  close(est.totalUsd, Math.max(0.0276, est.byPlatform.tiktok!.records * 0.000296), 1e-9);
  assert.ok(
    est.totalUsd < 0.0276 + est.byPlatform.tiktok!.records * 0.000296,
    "floor and marginal must not be added together"
  );
});

test("estimates reproduce real invoices rather than applying a fudge factor", () => {
  // cost_usd was verified equal to Apify's own usageTotalUsd (1.00x on 20
  // runs, all five actors), so there is no multiplier to apply. A YouTube run
  // of 4 keywords at cap 40 = 160 records really billed $0.48.
  const yt = estimateBatchCostUsd([{ platform: "youtube", keywords: keywordList(4) }]);
  close(yt.totalUsd, 160 * 0.003, 1e-9);
});

test("Instagram records scale with hashtag variants, capped, and never fall to zero", () => {
  // Company 2's IG runs peaked at exactly 160 records = 4 variants x cap 40.
  assert.equal(
    estimateRunRecords({
      platform: "instagram",
      keywords: [],
      hashtags: ["a", "b", "c", "d"],
    }),
    160
  );
  // More hashtags than IG_MAX_VARIANT_TAGS must not inflate the estimate.
  assert.equal(
    estimateRunRecords({
      platform: "instagram",
      keywords: [],
      hashtags: keywordList(20),
    }),
    160
  );
  // A query with no hashtags still launches an IG run, so it must be costed
  // as at least one variant rather than free.
  assert.ok(
    estimateRunRecords({ platform: "instagram", keywords: [], hashtags: [] }) > 0
  );
});

test("estimateBatchCostUsd reports records alongside runs for every platform", () => {
  const estimate = estimateBatchCostUsd(
    platformRuns({ tiktok: 10, instagram: 2, reddit: 3, youtube: 1, x: 5 })
  );
  for (const [platform, entry] of Object.entries(estimate.byPlatform)) {
    assert.ok(entry.records > 0, `${platform} should report a record count`);
    assert.ok(entry.usd > 0, `${platform} should report a cost`);
  }
  const summed = Object.values(estimate.byPlatform).reduce((s, e) => s + e.usd, 0);
  close(estimate.totalUsd, summed);
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
  const estimate = estimateBatchCostUsd(platformRuns({ tiktok: 10 }));
  assert.ok(estimate.totalUsd < 25);
  assert.doesNotThrow(() => enforceBatchCostCeiling(estimate, 25));
});

test("enforceBatchCostCeiling throws a plan over the ceiling, naming estimate/ceiling/breakdown", () => {
  // One uncapped YouTube run over a 250-keyword list: 250 x 40 = 10,000
  // records x $0.003 = $30.00. This is the shape the gate exists to catch —
  // a single run whose cost hides inside a long keyword list.
  const estimate = estimateBatchCostUsd([
    { platform: "youtube", keywords: keywordList(250) },
  ]);
  close(estimate.totalUsd, 30.0, 1e-6);
  assert.throws(
    () => enforceBatchCostCeiling(estimate, 25),
    (err: Error) => {
      assert.match(err.message, /\$30\.00/); // the estimate
      assert.match(err.message, /\$25\.00/); // the ceiling
      // The breakdown must surface RECORDS, since that is what drives cost.
      assert.match(err.message, /youtube: 1 runs \/ 10,000 records = \$30\.00/);
      return true;
    }
  );
});

test("a batch over budget is never partially approved — the whole batch is refused", () => {
  // Mixed plan where most platforms are cheap but one pushes it over: the
  // gate must refuse the WHOLE estimate, not silently drop the expensive
  // platform and approve the rest.
  const estimate = estimateBatchCostUsd([
    ...platformRuns({ tiktok: 50, x: 50 }),
    { platform: "youtube", keywords: keywordList(250) },
  ]);
  assert.ok(estimate.totalUsd > 25);
  assert.throws(() => enforceBatchCostCeiling(estimate, 25));
});

// ---------------------------------------------------------------------------
// The missing YouTube keyword cap
// ---------------------------------------------------------------------------

test("YOUTUBE_MAX_KEYWORDS bounds a query's YouTube spend regardless of keyword count", () => {
  // The real pilot query that projected to ~$190 of YouTube spend before the
  // cap existed: 79 keywords, which the old plan sent to YouTube in full.
  const plan = planPlatformsForQuery({
    keywords: keywordList(79),
    hashtags: ["a", "b"],
    language: "es",
    geography: "CO",
    topicLabel: "Apps de Entrega CO",
  });
  const ytRuns = plan.filter((p) => p.platform === "youtube");
  const ytKeywords = ytRuns.flatMap((p) => p.keywordsOverride ?? []);
  // The default cap is 8, mirroring TIKTOK_MAX_KEYWORD_RUNS.
  assert.equal(ytKeywords.length, 8);
  assert.ok(
    ytKeywords.length < 79,
    "YouTube must not receive the full keyword list — that is the unbounded cost path"
  );
});

test("the whole-query estimate uses the keywords each run actually fires with", () => {
  const query = {
    keywords: keywordList(79),
    hashtags: ["a", "b"],
    language: "es",
    geography: "CO",
    topicLabel: "Apps de Entrega CO",
  };
  const plan = planPlatformsForQuery(query);
  const estimate = estimateBatchCostUsd(
    plan.map((p) => effectiveRunFor(p, query))
  );
  // YouTube is capped at 8 keywords x 40 = 320 records, not 79 x 40 = 3,160.
  assert.equal(estimate.byPlatform.youtube!.records, 320);
  // And the query as a whole now sits inside a sane per-batch budget.
  assert.ok(
    estimate.totalUsd < 25,
    `a single query should fit under the batch ceiling, got $${estimate.totalUsd.toFixed(2)}`
  );
});

test("effectiveRunFor resolves each run to its real keyword list", () => {
  const query = {
    keywords: keywordList(30),
    hashtags: ["tag"],
    language: "es",
    geography: "MX",
    topicLabel: "t",
  };
  const plan = planPlatformsForQuery(query);
  // TikTok runs are one keyword each (keywordOverride).
  const tiktok = plan.filter((p) => p.platform === "tiktok");
  for (const p of tiktok) {
    assert.equal(effectiveRunFor(p, query).keywords!.length, 1);
  }
  // Reddit gets the full list (no override).
  const reddit = plan.find((p) => p.platform === "reddit")!;
  assert.equal(effectiveRunFor(reddit, query).keywords!.length, 30);
});
