// Fire a company's scout queries in small batches (generic version of
// fire-leone-run.ts). Firing everything in one call creates hundreds of Apify
// runs in a single loop and times out partway, so we launch a couple of queries
// at a time with a pause.
//
// Caps MUST be set on this process (they're read at module load):
//   BACKFILL_RESULT_CAP=40 TIKTOK_MAX_KEYWORD_RUNS=30 \
//     COMPANY_ID=2 FIRE_MAX_QUERIES=1 \
//     pnpm exec tsx --env-file=../../.env src/scripts/fire-company-run.ts
//
// FIRE_MAX_QUERIES limits how many queries to fire (for a cheap verify pass).
// FIRE_DRY_RUN=true plans without firing.
import { db, tpScoutQueries, tpActorRuns } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  launchBatch,
  planPlatformsForQuery,
  effectiveRunFor,
  estimateBatchCostUsd,
} from "../services/launch-batch.js";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "2") || 2;
const BATCH_SIZE = Number(process.env.FIRE_BATCH_SIZE ?? "2") || 2;
const PAUSE_MS = Number(process.env.FIRE_PAUSE_MS ?? "20000") || 20000;
const MAX_QUERIES = Number(process.env.FIRE_MAX_QUERIES ?? "0") || 0; // 0 = all
const DRY_RUN = process.env.FIRE_DRY_RUN === "true";

// HARD CUMULATIVE SPEND CEILING FOR THE WHOLE RUN.
//
// APIFY_MAX_BATCH_USD (services/launch-batch.ts) is a PER-BATCH gate. Firing
// 26 queries in 13 batches of ~$5 each never trips a $25 per-batch ceiling, so
// it cannot stop a total overrun — it was never designed to. This is the cap
// on the whole sweep.
//
// Enforced two ways, because an estimate and reality are different things and
// this project has been burned by trusting the estimate:
//   1. PRE-FLIGHT: the batch's projected cost is added to a running total and
//      the batch is refused if it would cross the ceiling. Nothing half-fires.
//   2. ACTUAL: real spend is read from Apify's own usage endpoint between
//      batches and compared against a baseline snapshot taken before the first
//      launch. If REAL spend crosses the ceiling, firing stops immediately,
//      whatever the estimate said.
// Unset means no cap (previous behaviour); set it for any real sweep.
const MAX_TOTAL_USD = Number(process.env.FIRE_MAX_TOTAL_USD ?? "0") || 0;

// Real cycle-to-date spend from Apify, the only ground truth for actual money.
async function fetchCycleSpendUsd(): Promise<number | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch("https://api.apify.com/v2/users/me/usage/monthly", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const v = j?.data?.totalUsageCreditsUsdAfterVolumeDiscount;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

async function main() {
  const all = (await db
    .select()
    .from(tpScoutQueries)
    .where(eq(tpScoutQueries.companyId, COMPANY_ID))) as any[];
  // Never touch the Schedule B fixture.
  let queries = all.filter((q) => !String(q.topicLabel).startsWith("BENCH:"));
  queries.sort((a, b) => a.id - b.id);

  // Idempotent: skip any query that already has actor runs, so re-running never
  // double-fires (and double-spends) a query. FIRE_FORCE=true overrides.
  if (process.env.FIRE_FORCE !== "true") {
    const fired = new Set(
      (
        (await db
          .select({ qid: tpActorRuns.scoutQueryId })
          .from(tpActorRuns)
          .where(eq(tpActorRuns.companyId, COMPANY_ID))) as any[]
      ).map((r) => r.qid)
    );
    const before = queries.length;
    queries = queries.filter((q) => !fired.has(q.id));
    if (before !== queries.length) {
      console.log(`skipping ${before - queries.length} already-fired query(ies)`);
    }
  }
  if (MAX_QUERIES > 0) queries = queries.slice(0, MAX_QUERIES);

  const kwTotal = queries.reduce((s, q) => s + (q.keywords || []).length, 0);
  console.log(
    `company ${COMPANY_ID}: ${queries.length} queries, ${kwTotal} keywords`
  );
  console.log(
    `caps: BACKFILL_RESULT_CAP=${process.env.BACKFILL_RESULT_CAP ?? "(default 200)"} ` +
      `TIKTOK_MAX_KEYWORD_RUNS=${process.env.TIKTOK_MAX_KEYWORD_RUNS ?? "(default 8)"} ` +
      `YOUTUBE_MAX_KEYWORDS=${process.env.YOUTUBE_MAX_KEYWORDS ?? "(default 8)"} ` +
      `IG_MAX_VARIANT_TAGS=${process.env.IG_MAX_VARIANT_TAGS ?? "(default 4)"}`
  );
  console.log(`batch size ${BATCH_SIZE}, ${PAUSE_MS / 1000}s pause\n`);

  if (DRY_RUN) {
    console.log("DRY RUN — nothing fired.");
    process.exit(0);
  }

  let launched = 0;
  let projectedSoFar = 0;
  const batchIds: string[] = [];

  const baselineSpend = await fetchCycleSpendUsd();
  if (MAX_TOTAL_USD > 0) {
    console.log(
      `budget ceiling $${MAX_TOTAL_USD.toFixed(2)} for this run. ` +
        `Apify cycle spend before firing: ${baselineSpend === null ? "unreadable" : "$" + baselineSpend.toFixed(2)}`
    );
    if (baselineSpend === null) {
      console.warn(
        "  WARNING: could not read real spend from Apify. The ceiling will be " +
          "enforced on ESTIMATES only for this run."
      );
    }
  }

  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const chunk = queries.slice(i, i + BATCH_SIZE);
    const labels = chunk.map((q) => `${q.topicLabel}[${q.language}]`).join(", ");

    if (MAX_TOTAL_USD > 0) {
      // (2) ACTUAL spend check first — it beats the estimate when they disagree.
      const nowSpend = await fetchCycleSpendUsd();
      if (nowSpend !== null && baselineSpend !== null) {
        const realUsed = nowSpend - baselineSpend;
        if (realUsed >= MAX_TOTAL_USD) {
          console.error(
            `\nSTOPPED: real Apify spend for this run is $${realUsed.toFixed(2)}, ` +
              `at or over the $${MAX_TOTAL_USD.toFixed(2)} ceiling. ` +
              `${queries.length - i} query(ies) NOT fired.`
          );
          break;
        }
      }
      // (1) PRE-FLIGHT: would this batch cross the ceiling?
      const batchRuns = chunk.flatMap((q) =>
        planPlatformsForQuery(q).map((p) => effectiveRunFor(p, q))
      );
      const batchEst = estimateBatchCostUsd(batchRuns).totalUsd;
      if (projectedSoFar + batchEst > MAX_TOTAL_USD) {
        console.error(
          `\nSTOPPED: next batch would take the projection to ` +
            `$${(projectedSoFar + batchEst).toFixed(2)}, over the ` +
            `$${MAX_TOTAL_USD.toFixed(2)} ceiling. ${queries.length - i} query(ies) NOT fired.`
        );
        break;
      }
      projectedSoFar += batchEst;
    }

    try {
      const res = await launchBatch(COMPANY_ID, {
        kind: "manual",
        queryIds: chunk.map((q) => q.id),
      });
      batchIds.push(res.batchId);
      launched += res.actorRunIds.length;
      console.log(`[batch ${i / BATCH_SIZE + 1}] ${labels}`);
      console.log(`    ${res.actorRunIds.length} runs (batch ${res.batchId}) | total ${launched}`);
    } catch (err: any) {
      console.error(`[batch ${i / BATCH_SIZE + 1}] FAILED ${labels}: ${err?.message ?? err}`);
    }
    if (i + BATCH_SIZE < queries.length) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }
  const finalSpend = await fetchCycleSpendUsd();
  console.log(`\nDONE: ${launched} runs across ${batchIds.length} batches.`);
  if (MAX_TOTAL_USD > 0) {
    console.log(`  projected spend for what was fired: $${projectedSoFar.toFixed(2)} (ceiling $${MAX_TOTAL_USD.toFixed(2)})`);
  }
  if (finalSpend !== null && baselineSpend !== null) {
    console.log(
      `  Apify cycle spend: $${baselineSpend.toFixed(2)} -> $${finalSpend.toFixed(2)} ` +
        `(+$${(finalSpend - baselineSpend).toFixed(2)} so far)`
    );
    console.log(
      `  NOTE: runs are still executing; billing accrues after launch. Re-check the ` +
        `usage endpoint once every run is terminal for the true total.`
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
