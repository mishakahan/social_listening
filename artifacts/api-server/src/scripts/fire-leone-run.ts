// Fire the Leone scrape in small batches.
//
// Firing every query in one call creates ~506 Apify runs inside a single loop,
// which times out partway and leaves the batch half-created (observed: only one
// query's runs made it). Launch a couple of queries at a time instead, pausing
// between so Neon connections and the Apify API both stay happy.
//
// BENCH:* queries are excluded: they are the Schedule B fixture and re-scraping
// them would move the backtest baseline.
//
// Requires the API server to be running — webhooks are disabled on localhost, so
// ingestion happens via the server's 2-minute poll.
import { db, tpScoutQueries } from "@workspace/db";
import { eq } from "drizzle-orm";
import { launchBatch } from "../services/launch-batch.js";

const COMPANY_ID = 1;
const BATCH_SIZE = Number(process.env.FIRE_BATCH_SIZE ?? "2") || 2;
const PAUSE_MS = Number(process.env.FIRE_PAUSE_MS ?? "20000") || 20000;
const DRY_RUN = process.env.FIRE_DRY_RUN === "true";

async function main() {
  const all = (await db
    .select()
    .from(tpScoutQueries)
    .where(eq(tpScoutQueries.companyId, COMPANY_ID))) as any[];
  const leone = all.filter((q) => !String(q.topicLabel).startsWith("BENCH:"));

  console.log(`${leone.length} Leone queries to fire (BENCH excluded: ${all.length - leone.length})`);
  const kwTotal = leone.reduce((s, q) => s + (q.keywords || []).length, 0);
  console.log(`${kwTotal} keywords total -> ~${kwTotal + leone.length * 4} actor runs`);
  console.log(`batch size ${BATCH_SIZE}, ${PAUSE_MS / 1000}s pause between\n`);

  if (DRY_RUN) {
    console.log("DRY RUN — nothing fired.");
    process.exit(0);
  }

  const batchIds: string[] = [];
  let launched = 0;
  for (let i = 0; i < leone.length; i += BATCH_SIZE) {
    const chunk = leone.slice(i, i + BATCH_SIZE);
    const labels = chunk.map((q) => `${q.topicLabel}[${q.language}]`).join(", ");
    try {
      const res = await launchBatch(COMPANY_ID, {
        kind: "manual",
        queryIds: chunk.map((q) => q.id),
      });
      batchIds.push(res.batchId);
      launched += res.actorRunIds.length;
      console.log(`[${i / BATCH_SIZE + 1}] ${labels}`);
      console.log(`    ${res.actorRunIds.length} runs created (batch ${res.batchId}) | total so far: ${launched}`);
    } catch (err: any) {
      // Keep going: a failed chunk should not strand the ones still unfired.
      console.error(`[${i / BATCH_SIZE + 1}] FAILED ${labels}: ${err?.message ?? err}`);
    }
    if (i + BATCH_SIZE < leone.length) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }

  console.log(`\nDONE — ${launched} runs across ${batchIds.length} batches.`);
  console.log("Apify is now scraping. The server polls every 2 min and ingests as runs finish.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
