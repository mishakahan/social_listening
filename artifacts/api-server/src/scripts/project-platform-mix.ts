// Read-only projection: for a company's committed scout queries, print the
// PLANNED per-platform run counts under the new chunked fan-out logic
// (launch-batch.ts planPlatformsForQuery) versus a given historical actual
// mix, with a projected cost line. Does NOT call Apify and does NOT write to
// the DB — it only reads scout queries and runs the same pure planning
// function the real launch path uses, so the counts are what launchBatch()
// would actually produce, without starting anything.
import * as storage from "../storage/index.js";
import {
  planPlatformsForQuery,
  effectiveRunFor,
  estimateBatchCostUsd,
  type PlannedRun,
} from "../services/launch-batch.js";

const COMPANY_ID = Number(process.env.PROJECT_COMPANY_ID ?? "2");

// Cost now comes from the SAME estimator launchBatch gates on
// (estimateBatchCostUsd), rather than a second copy of a per-run rate table
// maintained here. The old local table priced actors flat per RUN; measured
// 2026-08-07, they bill per RECORD, and a YouTube run's records are
// (keywords x cap) — which is why this script previously reported company 2's
// sweep as $62.42 when the real figure is an order of magnitude higher. Two
// cost tables meant the projection and the gate could disagree; now they
// cannot.

// The historical actual run counts observed for company 2 before this fix.
// Override via env if projecting for a different company/baseline.
const CURRENT_ACTUAL: Record<string, number> = {
  tiktok: Number(process.env.BASELINE_TIKTOK ?? "419"),
  instagram: Number(process.env.BASELINE_INSTAGRAM ?? "14"),
  x: Number(process.env.BASELINE_X ?? "14"),
  reddit: Number(process.env.BASELINE_REDDIT ?? "13"),
  youtube: Number(process.env.BASELINE_YOUTUBE ?? "1"),
};

const queries = await storage.getScoutQueries(COMPANY_ID);
console.log(`company ${COMPANY_ID}: ${queries.length} committed scout queries`);

const plannedByPlatform: Record<string, number> = {};
const plannedRuns: PlannedRun[] = [];
let totalKeywords = 0;

for (const q of queries) {
  totalKeywords += (q.keywords ?? []).length;
  const platforms = planPlatformsForQuery(q);
  for (const p of platforms) {
    plannedByPlatform[p.platform] = (plannedByPlatform[p.platform] ?? 0) + 1;
    plannedRuns.push(effectiveRunFor(p, q));
  }
}

const plannedEstimate = estimateBatchCostUsd(plannedRuns);

console.log(`total keywords across all committed queries: ${totalKeywords}\n`);

const allPlatforms = new Set([
  ...Object.keys(plannedByPlatform),
  ...Object.keys(CURRENT_ACTUAL),
]);

console.log(
  "platform".padEnd(12),
  "current(actual)".padEnd(18),
  "planned(new)".padEnd(14),
  "delta".padEnd(8),
  "planned records".padEnd(17),
  "planned $"
);

let currentTotalRuns = 0;
let plannedTotalRuns = 0;

for (const platform of allPlatforms) {
  const current = CURRENT_ACTUAL[platform] ?? 0;
  const planned = plannedByPlatform[platform] ?? 0;
  const entry = plannedEstimate.byPlatform[platform];
  currentTotalRuns += current;
  plannedTotalRuns += planned;
  console.log(
    platform.padEnd(12),
    String(current).padEnd(18),
    String(planned).padEnd(14),
    String(planned - current).padEnd(8),
    (entry?.records ?? 0).toLocaleString().padEnd(17),
    "$" + (entry?.usd ?? 0).toFixed(2)
  );
}

console.log("\n--- totals ---");
console.log(`current runs: ${currentTotalRuns}, planned runs: ${plannedTotalRuns}`);
const plannedRecords = Object.values(plannedEstimate.byPlatform).reduce(
  (s, e) => s + e.records,
  0
);
console.log(
  `planned: ${plannedRecords.toLocaleString()} records = $${plannedEstimate.totalUsd.toFixed(2)} projected REAL spend`
);
console.log(
  `\nNo "current cost" column: the historical figure it used to print came from the\n` +
    `same flat per-run table that was wrong. For real past spend read the Apify console,\n` +
    `or multiply tp_actor_runs.cost_usd by ~4 (company 2: $15.03 in-DB vs ~$60 billed).`
);

const tiktokShareCurrent =
  currentTotalRuns > 0 ? ((CURRENT_ACTUAL.tiktok ?? 0) / currentTotalRuns) * 100 : 0;
const tiktokSharePlanned =
  plannedTotalRuns > 0 ? ((plannedByPlatform.tiktok ?? 0) / plannedTotalRuns) * 100 : 0;
console.log(
  `\nTikTok run-count share: ${tiktokShareCurrent.toFixed(1)}% (current) -> ${tiktokSharePlanned.toFixed(1)}% (planned)`
);

// Capacity = runs * RESULT_CAP (200), the shared per-run cap every platform's
// actor input is built with. This is closer to what the fan-out fix targets
// (the entity/signal imbalance) than run count alone, since a TikTok run and
// a YouTube run cover very different keyword breadth per 200-item cap.
console.log("\ncapacity (runs * 200 cap) comparison:");
for (const platform of allPlatforms) {
  const current = CURRENT_ACTUAL[platform] ?? 0;
  const planned = plannedByPlatform[platform] ?? 0;
  console.log(
    `  ${platform.padEnd(10)} current capacity=${(current * 200).toLocaleString()}`.padEnd(45),
    `planned capacity=${(planned * 200).toLocaleString()}`
  );
}
