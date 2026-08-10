// Pre-flight projection for the exact queries fire-company-run.ts would fire.
//
// Selects the same set fire-company-run.ts does — non-BENCH queries for the
// company that have NO actor runs yet — and prices them through the SAME
// estimator launchBatch gates on, under whatever caps are set in this
// process's environment. Read-only: no Apify call, no DB write.
//
// Run it with the caps you intend to fire with, so the number you approve is
// the number that fires:
//   COMPANY_ID=2 BACKFILL_RESULT_CAP=40 YOUTUBE_MAX_KEYWORDS=8 \
//     pnpm exec tsx --env-file=../../.env src/scripts/pilot-project.ts
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  planPlatformsForQuery,
  effectiveRunFor,
  estimateBatchCostUsd,
  type PlannedRun,
} from "../services/launch-batch.js";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "2");
const BATCH_SIZE = Number(process.env.FIRE_BATCH_SIZE ?? "2") || 2;
const CEILING = Number(process.env.APIFY_MAX_BATCH_USD ?? "25") || 25;

const r = await db.execute(sql`
  select tsq.id, tsq.topic_label, tsq.language, tsq.geography,
         tsq.keywords, tsq.hashtags
  from tp_scout_queries tsq
  left join tp_actor_runs ar on ar.scout_query_id = tsq.id
  where tsq.company_id = ${COMPANY_ID}
    and tsq.topic_label not like 'BENCH:%'
    and ar.id is null
  group by tsq.id, tsq.topic_label, tsq.language, tsq.geography, tsq.keywords, tsq.hashtags
  order by tsq.id
`);

const queries = (r.rows as any[]).map((row) => ({
  id: Number(row.id),
  topicLabel: String(row.topic_label),
  language: String(row.language),
  geography: String(row.geography),
  keywords: (row.keywords ?? []) as string[],
  hashtags: (row.hashtags ?? []) as string[],
}));

console.log(
  `company ${COMPANY_ID}: ${queries.length} UNFIRED non-BENCH query(ies) — exactly what fire-company-run.ts would launch\n`
);
if (queries.length === 0) {
  console.log("Nothing to fire.");
  process.exit(0);
}

const allRuns: PlannedRun[] = [];
const perQuery: { label: string; runs: number; usd: number }[] = [];

for (const q of queries) {
  const plan = planPlatformsForQuery(q);
  const runs = plan.map((p) => effectiveRunFor(p, q));
  const est = estimateBatchCostUsd(runs);
  const byPlat: Record<string, number> = {};
  for (const p of plan) byPlat[p.platform] = (byPlat[p.platform] ?? 0) + 1;
  console.log(
    `  #${String(q.id).padEnd(4)} ${q.topicLabel.slice(0, 28).padEnd(28)} [${q.language}] ` +
      `${String(q.keywords.length).padStart(3)} kw -> ${String(plan.length).padStart(3)} runs ` +
      `${JSON.stringify(byPlat)} = $${est.totalUsd.toFixed(2)}`
  );
  allRuns.push(...runs);
  perQuery.push({ label: q.topicLabel, runs: plan.length, usd: est.totalUsd });
}

const est = estimateBatchCostUsd(allRuns);
console.log(`\n--- TOTAL ---`);
for (const [platform, e] of Object.entries(est.byPlatform).sort((a, b) => b[1].usd - a[1].usd)) {
  console.log(
    `  ${platform.padEnd(11)} ${String(e.runs).padStart(3)} runs ${e.records.toLocaleString().padStart(8)} records = $${e.usd.toFixed(2)}`
  );
}
const totalRecords = Object.values(est.byPlatform).reduce((s, e) => s + e.records, 0);
console.log(
  `  ${"TOTAL".padEnd(11)} ${String(allRuns.length).padStart(3)} runs ${totalRecords.toLocaleString().padStart(8)} records = $${est.totalUsd.toFixed(2)}`
);

console.log(
  `\ncaps in effect: BACKFILL_RESULT_CAP=${process.env.BACKFILL_RESULT_CAP ?? "200 (default)"} ` +
    `TIKTOK_MAX_KEYWORD_RUNS=${process.env.TIKTOK_MAX_KEYWORD_RUNS ?? "8 (default)"} ` +
    `YOUTUBE_MAX_KEYWORDS=${process.env.YOUTUBE_MAX_KEYWORDS ?? "8 (default)"} ` +
    `YOUTUBE_RESULT_CAP=${process.env.YOUTUBE_RESULT_CAP ?? "40 (default)"} ` +
    `IG_MAX_VARIANT_TAGS=${process.env.IG_MAX_VARIANT_TAGS ?? "4 (default)"} ` +
    `X_KEYWORDS_PER_RUN=${process.env.X_KEYWORDS_PER_RUN ?? "10 (default)"}`
);

// fire-company-run.ts issues one launchBatch per FIRE_BATCH_SIZE queries, and
// the ceiling is enforced PER BATCH — so check the worst batch, not the total.
let worstBatch = 0;
for (let i = 0; i < perQuery.length; i += BATCH_SIZE) {
  const chunk = perQuery.slice(i, i + BATCH_SIZE);
  worstBatch = Math.max(worstBatch, chunk.reduce((s, q) => s + q.usd, 0));
}
console.log(
  `\npre-flight gate: batches of ${BATCH_SIZE} query(ies), worst batch $${worstBatch.toFixed(2)} ` +
    `vs APIFY_MAX_BATCH_USD $${CEILING.toFixed(2)} -> ${worstBatch > CEILING ? "WOULD ABORT" : "would pass"}`
);
console.log(
  `\nProjection only. The Apify console is the only ground truth for real spend.`
);

process.exit(0);
