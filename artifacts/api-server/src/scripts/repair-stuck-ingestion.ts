// Repair actor runs wedged at ingestion_status='processing'.
//
// WHAT HAPPENED. Ingestion is claimed with a compare-and-set (storage.
// claimIngestion flips pending -> processing), the signals are written, and
// then storage.markIngestionDone writes back ingestion_status='done' PLUS
// records_usable / records_dropped. If the process stops between the write and
// that final bookkeeping, the run is left saying "processing / 0 usable"
// forever even though its signals are safely in the database.
//
// Measured on company 2: 161 such runs, 43,297 records fetched, 0 usable
// reported — and 23,095 real signals sitting in tp_raw_signals against them.
// 28,236 (done) + 23,095 (stuck) = 51,331, which is exactly the company's
// total signal count, so nothing was lost. This is a reporting failure, not a
// data failure.
//
// WHY IT MATTERS BEYOND THE DISPLAY. claimIngestion only claims rows whose
// status is 'pending', so a run stuck at 'processing' can never be re-ingested
// automatically. These runs are wedged out of the pipeline until repaired.
//
// TWO OUTCOMES, decided per run by whether signals actually exist:
//   signals > 0  -> the work was done. Backfill the counters from the real
//                   signal count and mark it done.
//   signals == 0 -> the work was NOT done. Reset to 'pending' so the normal
//                   ingestion path can pick it up again. Marking these "done"
//                   would permanently bury runs we have paid for.
//
// DRY RUN BY DEFAULT. Prints the plan and changes nothing. Set APPLY=1 to
// write. (A previous repair script in this repo was saved by exactly this
// default — its first heuristic would have renamed 499 entities.)
//
//   cd artifacts/api-server
//   pnpm exec tsx --env-file=../../.env src/scripts/repair-stuck-ingestion.ts
//   APPLY=1 COMPANY_ID=2 pnpm exec tsx --env-file=../../.env src/scripts/repair-stuck-ingestion.ts
//
// NOTE the env var is COMPANY_ID here. Other scripts in this repo use
// REGEN_COMPANY_ID / PROJECT_COMPANY_ID; passing the wrong one has silently
// operated on the wrong company before. It is echoed below so you can check.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const APPLY = process.env.APPLY === "1";
const COMPANY_ID = Number(process.env.COMPANY_ID ?? 2);

interface StuckRun {
  id: number;
  platform: string;
  records_fetched: number;
  signal_count: number;
}

async function main() {
  console.log(
    `\nrepair-stuck-ingestion — company ${COMPANY_ID} — ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`
  );

  const res = await db.execute(sql`
    SELECT r.id,
           r.platform,
           r.records_fetched,
           (SELECT count(*) FROM tp_raw_signals s WHERE s.actor_run_id = r.id)::int AS signal_count
      FROM tp_actor_runs r
     WHERE r.company_id = ${COMPANY_ID}
       AND r.ingestion_status = 'processing'
     ORDER BY r.id
  `);
  const rows = (res as any).rows as StuckRun[];

  if (rows.length === 0) {
    console.log("No runs stuck at 'processing'. Nothing to do.");
    process.exit(0);
  }

  const toComplete = rows.filter((r) => Number(r.signal_count) > 0);
  const toReset = rows.filter((r) => Number(r.signal_count) === 0);

  const byPlatform = new Map<string, { runs: number; signals: number }>();
  for (const r of toComplete) {
    const e = byPlatform.get(r.platform) ?? { runs: 0, signals: 0 };
    e.runs += 1;
    e.signals += Number(r.signal_count);
    byPlatform.set(r.platform, e);
  }

  console.log(`Stuck runs: ${rows.length}`);
  console.log(
    `  -> mark done (signals exist):   ${toComplete.length} runs, ` +
      `${toComplete.reduce((s, r) => s + Number(r.signal_count), 0).toLocaleString()} signals to credit`
  );
  console.log(`  -> reset to pending (no signals): ${toReset.length} runs\n`);
  console.table(
    [...byPlatform.entries()].map(([platform, v]) => ({
      platform,
      runs: v.runs,
      signals: v.signals,
    }))
  );

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with APPLY=1 to make these changes.");
    process.exit(0);
  }

  let completed = 0;
  for (const r of toComplete) {
    const usable = Number(r.signal_count);
    // records_dropped is what the scraper returned minus what we kept. Floor at
    // 0: a run can report fewer fetched than we hold signals for if it was
    // re-ingested, and a negative "dropped" would be nonsense.
    const dropped = Math.max(0, Number(r.records_fetched) - usable);
    await db.execute(sql`
      UPDATE tp_actor_runs
         SET ingestion_status = 'done',
             ingestion_completed_at = now(),
             records_usable = ${usable},
             records_dropped = ${dropped}
       WHERE id = ${r.id} AND ingestion_status = 'processing'
    `);
    completed += 1;
  }

  let reset = 0;
  for (const r of toReset) {
    await db.execute(sql`
      UPDATE tp_actor_runs
         SET ingestion_status = 'pending'
       WHERE id = ${r.id} AND ingestion_status = 'processing'
    `);
    reset += 1;
  }

  // Read back rather than trusting the writes — the whole reason this script
  // exists is a status field that did not match reality.
  const after = await db.execute(sql`
    SELECT ingestion_status, count(*)::int AS runs, sum(records_usable)::int AS usable
      FROM tp_actor_runs WHERE company_id = ${COMPANY_ID}
     GROUP BY 1 ORDER BY 2 DESC
  `);
  console.log(`\nMarked done: ${completed}   Reset to pending: ${reset}`);
  console.log("\nActor runs by ingestion_status after repair:");
  console.table((after as any).rows);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
