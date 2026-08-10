// Read-only comparison harness for the capped category-seeding pilot.
//
// Answers the two questions the pilot exists to answer, from real scraped
// data, with the OLD product-specific seeds as the measured baseline:
//   (a) entities surfaced PER KEYWORD — normalised so a capped pilot (3
//       queries) is still comparable to the full old sweep (14 queries).
//   (b) share of entities appearing on 2+ PLATFORMS — the thing the gate's
//       source-breadth check actually measures, and the reason genuine finds
//       (seitan, coxinha, iced coffee) were being held at 0.00 bits.
//
// Also prints the scrape CONDITIONS on each side (runs per platform, records
// per run) because the old and new sweeps ran under different caps — that is
// a real confound and it should be visible, not buried.
//
// No writes, no Apify, no OpenAI. Safe to run any time.
//   COMPANY_ID=2 pnpm exec tsx --env-file=../../.env src/scripts/pilot-compare.ts
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "2");
// Seeds committed on/after this timestamp are the PILOT (category-level)
// cohort; everything before is the OLD (product-specific) baseline.
const PILOT_CUTOFF = process.env.PILOT_CUTOFF ?? "2026-08-01";
// ARM assignment uses the QUERY's creation date (old product seed vs new
// category seed). Which DATA counts is a separate axis: SWEEP_SINCE restricts
// every measurement to signals from actor runs started at or after this
// timestamp.
//
// Both are needed. Re-firing the old seeds is what makes the comparison valid
// (identical caps on both arms), but their fresh signals still hang off
// queries created in July — so cohorting on query date alone would label new
// data "OLD" and silently pool two scrapes taken under different caps. That
// would make the seeding result unmeasurable in exactly the way this script
// exists to prevent.
const SWEEP_SINCE = process.env.SWEEP_SINCE ?? null;
const runWindow = SWEEP_SINCE
  ? sql`and ar.started_at >= ${SWEEP_SINCE}`
  : sql``;

async function rows(s: any): Promise<any[]> {
  return (await db.execute(s)).rows as any[];
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : "n/a";
}

// (a) Entities surfaced per keyword, per seed.
const breadth = await rows(sql`
  select tsq.id,
         tsq.topic_label,
         tsq.watch_topic,
         tsq.geography,
         tsq.created_at,
         jsonb_array_length(coalesce(tsq.keywords,'[]'::jsonb)) as kw,
         count(distinct tse.entity_id) as entities,
         count(distinct trs.id) as signals
  from tp_scout_queries tsq
  left join tp_actor_runs ar on ar.scout_query_id = tsq.id ${runWindow}
  left join tp_raw_signals trs on trs.actor_run_id = ar.id
  left join tp_signal_entities tse on tse.raw_signal_id = trs.id
  where tsq.company_id = ${COMPANY_ID}
    and tsq.topic_label not like 'BENCH:%'
  group by tsq.id, tsq.topic_label, tsq.watch_topic, tsq.geography, tsq.created_at, tsq.keywords
  order by tsq.created_at, tsq.id
`);

const cohort = (r: any) => (new Date(r.created_at) >= new Date(PILOT_CUTOFF) ? "PILOT" : "OLD");
const perKw = (r: any) => (Number(r.kw) > 0 ? Number(r.entities) / Number(r.kw) : NaN);

console.log(
  `=== (a) ENTITIES PER KEYWORD — company ${COMPANY_ID} ===\n` +
    `data window: ${SWEEP_SINCE ? `runs started >= ${SWEEP_SINCE}` : "ALL runs (set SWEEP_SINCE to isolate one sweep)"}`
);
console.log(
  `${"cohort".padEnd(7)} ${"seed".padEnd(32)} ${"geo".padEnd(4)} ${"kw".padStart(4)} ${"entities".padStart(9)} ${"signals".padStart(8)} ${"ent/kw".padStart(7)}`
);
for (const r of breadth) {
  console.log(
    `${cohort(r).padEnd(7)} ${String(r.topic_label).slice(0, 32).padEnd(32)} ${String(r.geography).padEnd(4)} ` +
      `${String(r.kw).padStart(4)} ${String(r.entities).padStart(9)} ${String(r.signals).padStart(8)} ${fmt(perKw(r)).padStart(7)}`
  );
}

function summary(label: string, set: any[]): void {
  const vals = set.map(perKw).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (vals.length === 0) {
    console.log(`  ${label.padEnd(7)} (no scraped seeds yet)`);
    return;
  }
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2;
  console.log(
    `  ${label.padEnd(7)} n=${String(vals.length).padStart(2)}  min ${fmt(vals[0]!)}  median ${fmt(median)}  mean ${fmt(mean)}  max ${fmt(vals[vals.length - 1]!)}`
  );
}
console.log(`\nent/kw summary (seeds with scraped data only):`);
summary("OLD", breadth.filter((r) => cohort(r) === "OLD" && Number(r.signals) > 0));
summary("PILOT", breadth.filter((r) => cohort(r) === "PILOT" && Number(r.signals) > 0));

// Matched pairs: same watch topic + same geography on both sides. This is the
// controlled part of the comparison — the category seed and the product seed
// are aimed at the same client question in the same market.
console.log(`\n=== MATCHED PAIRS (same watch topic + geography, category vs product seed) ===`);
const old = breadth.filter((r) => cohort(r) === "OLD" && Number(r.signals) > 0);
const pilot = breadth.filter((r) => cohort(r) === "PILOT" && Number(r.signals) > 0);
for (const p of pilot) {
  const match = old.filter((o) => o.watch_topic === p.watch_topic && o.geography === p.geography);
  for (const m of match) {
    const lift = perKw(p) / perKw(m);
    console.log(
      `  ${String(m.topic_label).slice(0, 28).padEnd(28)} ${fmt(perKw(m)).padStart(6)} /kw  ->  ` +
        `${String(p.topic_label).slice(0, 28).padEnd(28)} ${fmt(perKw(p)).padStart(6)} /kw   ` +
        `${lift >= 1 ? "+" : ""}${fmt((lift - 1) * 100, 1)}%`
    );
  }
}

// (b) Platform breadth — the prize. Split by cohort via the scout query that
// produced each signal, so pilot entities are measured on pilot data only.
console.log(`\n=== (b) PLATFORM BREADTH — entities appearing on N platforms ===`);
for (const [label, op] of [
  ["OLD", sql`tsq.created_at < ${PILOT_CUTOFF}`],
  ["PILOT", sql`tsq.created_at >= ${PILOT_CUTOFF}`],
] as const) {
  const dist = await rows(sql`
    select platforms, count(*) as entities from (
      select tse.entity_id, count(distinct trs.platform) as platforms
      from tp_signal_entities tse
      join tp_raw_signals trs on trs.id = tse.raw_signal_id
      join tp_actor_runs ar on ar.id = trs.actor_run_id ${runWindow}
      join tp_scout_queries tsq on tsq.id = trs.scout_query_id
      where trs.company_id = ${COMPANY_ID}
        and tsq.topic_label not like 'BENCH:%'
        and ${op}
      group by tse.entity_id
    ) t group by platforms order by platforms
  `);
  const total = dist.reduce((s, r) => s + Number(r.entities), 0);
  const multi = dist.filter((r) => Number(r.platforms) >= 2).reduce((s, r) => s + Number(r.entities), 0);
  console.log(
    `  ${label.padEnd(6)} ${dist.map((r) => `${r.platforms}p:${r.entities}`).join("  ")}` +
      `   |  ${multi}/${total} on 2+ platforms = ${total ? fmt((100 * multi) / total, 1) : "n/a"}%`
  );
}

// Scrape CONDITIONS on each side — the confound, made visible.
console.log(`\n=== SCRAPE CONDITIONS (the confound: old and new ran under different caps) ===`);
const conds = await rows(sql`
  select case when tsq.created_at >= ${PILOT_CUTOFF} then 'PILOT' else 'OLD' end as cohort,
         ar.platform,
         count(*) as runs,
         sum(ar.records_fetched) as records,
         round(avg(ar.records_fetched)::numeric, 1) as avg_records_per_run
  from tp_actor_runs ar
  join tp_scout_queries tsq on tsq.id = ar.scout_query_id
  where ar.company_id = ${COMPANY_ID}
    and tsq.topic_label not like 'BENCH:%'
  group by 1, 2 order by 1, runs desc
`);
for (const c of conds) {
  console.log(
    `  ${String(c.cohort).padEnd(6)} ${String(c.platform).padEnd(11)} ${String(c.runs).padStart(4)} runs  ` +
      `${String(c.records).padStart(7)} records  avg ${String(c.avg_records_per_run).padStart(6)}/run`
  );
}
for (const label of ["OLD", "PILOT"]) {
  const set = conds.filter((c) => c.cohort === label);
  const totalRuns = set.reduce((s, c) => s + Number(c.runs), 0);
  const tt = set.find((c) => c.platform === "tiktok");
  if (totalRuns > 0) {
    console.log(
      `  -> ${label}: ${totalRuns} runs total, TikTok share ${fmt((100 * Number(tt?.runs ?? 0)) / totalRuns, 1)}% of runs`
    );
  }
}

process.exit(0);
