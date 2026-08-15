// Read-only check: does the new APIFY_MAX_BATCH_USD=$25 default block a
// REALISTIC launchBatch() call for company 2 under the new defaults? Real
// operation chunks queries (fire-company-run.ts, BATCH_SIZE=2) rather than
// firing all 14 at once in a single launchBatch call, both because a
// single loop of ~500 runs times out partway (fire-company-run.ts's own
// comment) and because the untouched-since 828-run TikTok fan-out. This
// simulates that exact chunking and estimates each chunk's cost with the
// real, exported estimateBatchCostUsd — no Apify call, no DB write.
import * as storage from "../storage/index.js";
import {
  planPlatformsForQuery,
  estimateBatchCostUsd,
} from "../services/launch-batch.js";

const COMPANY_ID = Number(process.env.CHECK_COMPANY_ID ?? "2");
const CHUNK_SIZE = Number(process.env.CHECK_CHUNK_SIZE ?? "2");
const CEILING = Number(process.env.APIFY_MAX_BATCH_USD ?? "25");

const all = await storage.getScoutQueries(COMPANY_ID);
const queries = [...all].sort((a, b) => a.id - b.id);

console.log(`company ${COMPANY_ID}: ${queries.length} queries, chunk size ${CHUNK_SIZE}, ceiling $${CEILING}\n`);

let anyOverCeiling = false;
let grandTotal = 0;
for (let i = 0; i < queries.length; i += CHUNK_SIZE) {
  const chunk = queries.slice(i, i + CHUNK_SIZE);
  const plans = chunk.flatMap((q) => planPlatformsForQuery(q));
  const estimate = estimateBatchCostUsd(plans);
  grandTotal += estimate.totalUsd;
  const overCeiling = estimate.totalUsd > CEILING;
  if (overCeiling) anyOverCeiling = true;
  const labels = chunk.map((q) => q.topicLabel).join(", ");
  console.log(
    `chunk ${i / CHUNK_SIZE + 1} [${labels}]: $${estimate.totalUsd.toFixed(2)}` +
      (overCeiling ? "  <-- OVER CEILING" : "")
  );
}
console.log(`\ngrand total across all chunks: $${grandTotal.toFixed(2)}`);
console.log(anyOverCeiling ? "\nAT LEAST ONE CHUNK WOULD BE BLOCKED" : "\nEvery chunk fits under the ceiling.");
