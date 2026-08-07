// Read-only projection: for a company's committed scout queries, print the
// PLANNED per-platform run counts under the new chunked fan-out logic
// (launch-batch.ts planPlatformsForQuery) versus a given historical actual
// mix, with a projected cost line. Does NOT call Apify and does NOT write to
// the DB — it only reads scout queries and runs the same pure planning
// function the real launch path uses, so the counts are what launchBatch()
// would actually produce, without starting anything.
import * as storage from "../storage/index.js";
import { planPlatformsForQuery } from "../services/launch-batch.js";

const COMPANY_ID = Number(process.env.PROJECT_COMPANY_ID ?? "2");

// Real measured per-run cost (the DB cost_usd column undercounts by ~4x, so
// these are hardcoded from measured figures, not read from the DB).
const COST_PER_RUN: Record<string, number> = {
  tiktok: 0.1,
  instagram: 1.0,
  reddit: 0.5,
  youtube: 1.5,
  x: 0.02,
};

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
let totalKeywords = 0;

for (const q of queries) {
  totalKeywords += (q.keywords ?? []).length;
  const platforms = planPlatformsForQuery(q);
  for (const p of platforms) {
    plannedByPlatform[p.platform] = (plannedByPlatform[p.platform] ?? 0) + 1;
  }
}

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
  "current $".padEnd(12),
  "planned $"
);

let currentTotalRuns = 0;
let plannedTotalRuns = 0;
let currentTotalCost = 0;
let plannedTotalCost = 0;

for (const platform of allPlatforms) {
  const current = CURRENT_ACTUAL[platform] ?? 0;
  const planned = plannedByPlatform[platform] ?? 0;
  const costPerRun = COST_PER_RUN[platform] ?? 0;
  const currentCost = current * costPerRun;
  const plannedCost = planned * costPerRun;
  currentTotalRuns += current;
  plannedTotalRuns += planned;
  currentTotalCost += currentCost;
  plannedTotalCost += plannedCost;
  console.log(
    platform.padEnd(12),
    String(current).padEnd(18),
    String(planned).padEnd(14),
    String(planned - current).padEnd(8),
    ("$" + currentCost.toFixed(2)).padEnd(12),
    "$" + plannedCost.toFixed(2)
  );
}

console.log("\n--- totals ---");
console.log(`current runs: ${currentTotalRuns}, planned runs: ${plannedTotalRuns}`);
console.log(
  `current cost: $${currentTotalCost.toFixed(2)}, planned cost: $${plannedTotalCost.toFixed(2)}`
);
const delta = plannedTotalCost - currentTotalCost;
const pct = currentTotalCost > 0 ? (delta / currentTotalCost) * 100 : 0;
console.log(
  `delta: ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`
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
