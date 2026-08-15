// Read-only investigation: why does company 2's measured run history show
// YouTube = 1 run total (vs X = 14, Reddit = 13, Instagram = 14) even though
// all three are planned once per query in the same conditional block?
// No writes, no Apify calls — just SELECTs against tp_actor_runs.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMPANY_ID = Number(process.env.INVESTIGATE_COMPANY_ID ?? "2");

const byPlatform: any = await db.execute(sql`
  SELECT platform, status, COUNT(*)::int AS n,
         MIN(created_at) AS earliest, MAX(created_at) AS latest,
         COUNT(DISTINCT launch_batch_id)::int AS distinct_batches,
         COUNT(DISTINCT scout_query_id)::int AS distinct_queries
  FROM tp_actor_runs
  WHERE company_id = ${COMPANY_ID}
  GROUP BY platform, status
  ORDER BY platform, status
`);
console.log("=== runs by platform + status ===");
for (const r of byPlatform.rows ?? byPlatform) {
  console.log(
    `${r.platform.padEnd(10)} ${r.status.padEnd(10)} n=${String(r.n).padEnd(4)} batches=${r.distinct_batches} queries=${r.distinct_queries} span=${r.earliest} -> ${r.latest}`
  );
}

console.log("\n=== all YouTube rows in detail ===");
const yt: any = await db.execute(sql`
  SELECT id, scout_query_id, launch_batch_id, status, error_message,
         created_at, started_at, completed_at, apify_run_id
  FROM tp_actor_runs
  WHERE company_id = ${COMPANY_ID} AND platform = 'youtube'
  ORDER BY created_at
`);
for (const r of yt.rows ?? yt) {
  console.log(JSON.stringify(r));
}

console.log("\n=== per-batch platform breakdown ===");
const perBatch: any = await db.execute(sql`
  SELECT launch_batch_id, platform, COUNT(*)::int AS n, MIN(created_at) AS first_created
  FROM tp_actor_runs
  WHERE company_id = ${COMPANY_ID}
  GROUP BY launch_batch_id, platform
  ORDER BY first_created, platform
`);
for (const r of perBatch.rows ?? perBatch) {
  console.log(JSON.stringify(r));
}

console.log("\n=== query 108's rows (the one query with a youtube run) ===");
const q108: any = await db.execute(sql`
  SELECT id, platform, status, launch_batch_id, created_at
  FROM tp_actor_runs
  WHERE company_id = ${COMPANY_ID} AND scout_query_id = 108
  ORDER BY created_at
`);
for (const r of q108.rows ?? q108) {
  console.log(JSON.stringify(r));
}

console.log("\n=== per-query platform coverage (which queries are missing youtube) ===");
const perQuery: any = await db.execute(sql`
  SELECT scout_query_id,
         COUNT(*) FILTER (WHERE platform = 'youtube')::int AS youtube_runs,
         COUNT(*) FILTER (WHERE platform = 'x')::int AS x_runs,
         COUNT(*) FILTER (WHERE platform = 'reddit')::int AS reddit_runs,
         COUNT(*) FILTER (WHERE platform = 'instagram')::int AS ig_runs,
         MIN(created_at) AS first_row,
         MAX(created_at) AS last_row
  FROM tp_actor_runs
  WHERE company_id = ${COMPANY_ID}
  GROUP BY scout_query_id
  ORDER BY first_row
`);
for (const r of perQuery.rows ?? perQuery) {
  console.log(JSON.stringify(r));
}
