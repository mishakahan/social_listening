// Offline recompute: timeseries -> state machine (which calls the gate).
// No API server needed; this ingests nothing.
//
// Pass --bust-specificity to clear the cached specificity verdicts first.
// They live on tp_entity_state.specificity_verdict and are keyed by label, so
// after a change to services/specificity.ts the state machine would otherwise
// happily reuse verdicts from the OLD prompt.
//
//   pnpm exec tsx --env-file=../../.env src/scripts/rerun-recompute.ts --bust-specificity

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { runTimeseriesAggregation } from "../services/timeseries.js";
import { runStateMachine } from "../services/state-machine.js";

const COMPANY_ID = Number(process.env.REGEN_COMPANY_ID ?? "1");
const BUST = process.argv.includes("--bust-specificity");

const started = Date.now();
const mins = () => `${((Date.now() - started) / 60000).toFixed(1)}m`;

if (BUST) {
  const res: any = await db.execute(sql`
    UPDATE tp_entity_state SET specificity_verdict = NULL
    WHERE company_id = ${COMPANY_ID} AND specificity_verdict IS NOT NULL
  `);
  console.log(`[${mins()}] cleared ${res.rowCount ?? "?"} cached specificity verdicts`);
} else {
  console.log("NOTE: reusing cached specificity verdicts (pass --bust-specificity to clear)");
}

// Entity RENAMES don't change any bucket (timeseries keys on entity_id), so a
// label-only repair can skip the 2-hour aggregation and go straight to verdicts.
if (process.argv.includes("--skip-timeseries")) {
  console.log(`[${mins()}] skipping timeseries; state machine...`);
  const smOnly = await runStateMachine(COMPANY_ID);
  console.log(`[${mins()}] state machine done — ${smOnly.processed} processed, ${smOnly.transitions} transitions`);
  process.exit(0);
}

console.log(`[${mins()}] timeseries...`);
const ts = await runTimeseriesAggregation(COMPANY_ID);
console.log(`[${mins()}] timeseries done — ${ts.bucketsWritten} buckets, ${ts.bucketsFailed} failed`);
if (ts.bucketsFailed > 0) {
  console.error(
    `ABORT: ${ts.bucketsFailed} buckets lost after retries. The state machine would compute ` +
      `verdicts on an incomplete series. Rerun timeseries before trusting any verdict.`
  );
  process.exit(1);
}

console.log(`[${mins()}] state machine...`);
const sm = await runStateMachine(COMPANY_ID);
console.log(`[${mins()}] state machine done — ${sm.processed} processed, ${sm.transitions} transitions`);

process.exit(0);
