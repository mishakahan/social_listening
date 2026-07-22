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
import { launchBatch } from "../services/launch-batch.js";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "2") || 2;
const BATCH_SIZE = Number(process.env.FIRE_BATCH_SIZE ?? "2") || 2;
const PAUSE_MS = Number(process.env.FIRE_PAUSE_MS ?? "20000") || 20000;
const MAX_QUERIES = Number(process.env.FIRE_MAX_QUERIES ?? "0") || 0; // 0 = all
const DRY_RUN = process.env.FIRE_DRY_RUN === "true";

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
      `TIKTOK_MAX_KEYWORD_RUNS=${process.env.TIKTOK_MAX_KEYWORD_RUNS ?? "(default 80)"}`
  );
  console.log(`batch size ${BATCH_SIZE}, ${PAUSE_MS / 1000}s pause\n`);

  if (DRY_RUN) {
    console.log("DRY RUN — nothing fired.");
    process.exit(0);
  }

  let launched = 0;
  const batchIds: string[] = [];
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const chunk = queries.slice(i, i + BATCH_SIZE);
    const labels = chunk.map((q) => `${q.topicLabel}[${q.language}]`).join(", ");
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
  console.log(`\nDONE: ${launched} runs across ${batchIds.length} batches.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
