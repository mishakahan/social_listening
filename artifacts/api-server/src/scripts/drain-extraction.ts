// Drain the entity-extraction backlog to completion, surviving transient
// network failures.
//
// WHY THIS EXISTS: the API server crashed mid-extraction with
// `InformationalError: socket idle timeout` — an unhandled 'error' event from
// undici's HTTP/2 client, thrown when a long-lived idle connection to OpenAI
// drops. An unhandled error event terminates the Node process, so a single
// dropped socket abandoned a 12,000-signal backlog. Running extraction inside
// the API server also couples it to everything else the server does.
//
// This runs the SAME production extraction path (runEntityExtraction), in a
// loop, catching per-iteration failures so one dropped connection costs one
// batch rather than the whole run. It exits when the backlog is empty or when
// no progress is being made, so it cannot spin forever.
//
//   COMPANY_ID=2 pnpm exec tsx --env-file=../../.env src/scripts/drain-extraction.ts
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { runEntityExtraction } from "../services/entity-extraction.js";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "2");
const CONCURRENCY = Number(process.env.EXTRACT_CONCURRENCY ?? "6");
const BATCH_SIZE = Number(process.env.EXTRACT_BATCH_SIZE ?? "20");
// maxBatches per call; the outer loop repeats until the backlog is drained.
const MAX_BATCHES = Number(process.env.EXTRACT_MAX_BATCHES ?? "50");
// Give up after this many consecutive iterations that process nothing, so a
// permanent failure (bad key, schema drift) stops rather than looping.
const MAX_STALLS = 3;

async function pendingCount(): Promise<number> {
  const r = await db.execute(sql`
    select count(*) as n from tp_raw_signals
    where company_id = ${COMPANY_ID} and entity_extraction_status = 'pending'
  `);
  return Number((r.rows as any[])[0]?.n ?? 0);
}

async function main() {
  const started = Date.now();
  let stalls = 0;
  let totalProcessed = 0;
  let iteration = 0;

  let pending = await pendingCount();
  console.log(`company ${COMPANY_ID}: ${pending} signals pending extraction\n`);

  while (pending > 0 && stalls < MAX_STALLS) {
    iteration++;
    try {
      const res = await runEntityExtraction(COMPANY_ID, {
        batchSize: BATCH_SIZE,
        maxBatches: MAX_BATCHES,
        concurrency: CONCURRENCY,
      });
      totalProcessed += res.processed;
      const before = pending;
      pending = await pendingCount();
      const mins = (Date.now() - started) / 60000;
      const rate = totalProcessed / Math.max(mins, 0.01);
      console.log(
        `[${iteration}] processed ${res.processed} (${res.entityLinks} links) | ` +
          `pending ${before} -> ${pending} | ${totalProcessed} total | ` +
          `${rate.toFixed(0)}/min | eta ${(pending / Math.max(rate, 1)).toFixed(0)}min`
      );
      // No forward progress despite no error: count it as a stall rather than
      // looping on a backlog that cannot be drained (e.g. rows that always fail).
      stalls = res.processed === 0 ? stalls + 1 : 0;
    } catch (err: any) {
      // The exact failure mode that killed the server. One batch is lost; the
      // signals stay `pending` and are retried on the next iteration.
      stalls++;
      console.error(
        `[${iteration}] batch failed (${stalls}/${MAX_STALLS}): ${err?.message ?? err}`
      );
      await new Promise((r) => setTimeout(r, 5000));
      pending = await pendingCount();
    }
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  if (pending === 0) {
    console.log(`\nDONE: backlog drained. ${totalProcessed} signals in ${mins} min.`);
  } else {
    console.log(
      `\nSTOPPED with ${pending} still pending after ${MAX_STALLS} stalled iterations ` +
        `(${totalProcessed} processed in ${mins} min). Investigate before re-running.`
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
