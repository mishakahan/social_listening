// GATE VARIANT SWEEP — measure candidate gate configurations against the
// holdout, so a fix is chosen from evidence instead of argument.
//
// The holdout established that the shipped gate's edge comes entirely from
// the breadth check, and that requiring significance on top costs both
// coverage (151 surfaced -> 70) and quality (1.65x -> 1.43x). This runs the
// same evaluation across several candidate configurations at once and ranks
// them, so "can we fix it" gets a measured answer.
//
// Free: one DB read, no scrape, no LLM, no writes. Loads each entity's
// timeseries ONCE and evaluates every variant in memory.
//
//   COMPANY_ID=1 pnpm exec tsx --env-file=../../.env src/scripts/gate-variants.ts
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  buildGateInput,
  significanceTest,
  sourceBreadth,
  type GateConfig,
  type GateInput,
} from "../services/confirmation-gate.js";
import type { TpEntityTimeseries } from "@workspace/db";
import { mannWhitney, median } from "./holdout-validate.js";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "1");
const HORIZON_DAYS = Number(process.env.HORIZON_DAYS ?? "56");
const MIN_PRE_MENTIONS = Number(process.env.MIN_PRE_MENTIONS ?? "3");
const MIN_COHORT = 20;

const baseCfg: GateConfig = {
  significanceAlpha: 0.05,
  permutations: 1000,
  minSourceEntropyBits: 1.0,
  minUniqueAuthors: 3,
  enabled: true,
  // Current shipped behaviour: significance is required. Set explicitly so
  // this baseline never drifts if the default changes.
  requireSignificance: true,
};

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (iso: string, n: number) =>
  new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400_000)
    .toISOString()
    .slice(0, 10);

// CANDIDATE REPLACEMENT STATISTIC.
// Hypothesis for why the shipped permutation test carries no signal: it
// compares the last 7 days against shuffles of a series that, at a median of
// 5-7 mentions over up to 180 days, is almost entirely zeros. Shuffling a
// sparse series produces a null that is either trivially beaten or impossible
// to beat, so the test ends up measuring sparsity rather than acceleration.
// This variant widens the window (28d vs the preceding 28d) so both sides
// have enough mass to compare, and works on the ratio rather than a shuffle.
function recentVsPriorWindow(dailyMentions: number[], windowDays: number): number {
  if (dailyMentions.length < windowDays * 2) return 0;
  const recent = dailyMentions.slice(-windowDays).reduce((s, v) => s + v, 0);
  const prior = dailyMentions
    .slice(-windowDays * 2, -windowDays)
    .reduce((s, v) => s + v, 0);
  return (recent + 1) / (prior + 1);
}

type Variant = {
  name: string;
  note: string;
  decide: (input: GateInput, entityId: number) => boolean;
};

const variants: Variant[] = [
  {
    name: "SHIPPED (sig AND breadth)",
    note: "what production runs today",
    decide: (i, id) =>
      significanceTest(i.dailyMentions, baseCfg, seeded(id)).pass &&
      sourceBreadth(i.sources, baseCfg).pass,
  },
  {
    name: "breadth only",
    note: "drop the significance requirement entirely",
    decide: (i) => sourceBreadth(i.sources, baseCfg).pass,
  },
  {
    name: "significance only",
    note: "drop breadth instead — the opposite trade",
    decide: (i, id) => significanceTest(i.dailyMentions, baseCfg, seeded(id)).pass,
  },
  {
    name: "breadth >= 0.5 bits",
    note: "looser breadth: does it still hold up, and how much more surfaces",
    decide: (i) => sourceBreadth(i.sources, { ...baseCfg, minSourceEntropyBits: 0.5 }).pass,
  },
  {
    name: "breadth >= 1.5 bits",
    note: "stricter breadth: is the edge stronger if we demand more diversity",
    decide: (i) => sourceBreadth(i.sources, { ...baseCfg, minSourceEntropyBits: 1.5 }).pass,
  },
  {
    name: "breadth + 28d/28d growth >= 1.2",
    note: "replacement statistic instead of the permutation test",
    decide: (i) =>
      sourceBreadth(i.sources, baseCfg).pass &&
      recentVsPriorWindow(i.dailyMentions, 28) >= 1.2,
  },
  {
    name: "breadth + >=5 unique authors",
    note: "swap the statistical check for a plain evidence-volume floor",
    decide: (i) =>
      sourceBreadth(i.sources, baseCfg).pass &&
      i.sources.reduce((s, x) => s + x.uniqueAuthors, 0) >= 5,
  },
];

async function main() {
  const bounds = await db.execute(sql`
    select max(bucket_date)::text as last_day
    from tp_entity_timeseries where company_id = ${COMPANY_ID}
  `);
  const lastDay = (bounds.rows as any[])[0]?.last_day;
  if (!lastDay) throw new Error(`No timeseries for company ${COMPANY_ID}`);
  const cutoff = process.env.CUTOFF ?? addDays(lastDay, -HORIZON_DAYS);
  const preStart = addDays(cutoff, -HORIZON_DAYS);
  const horizonEnd = addDays(cutoff, HORIZON_DAYS);

  console.log(`=== GATE VARIANT SWEEP — company ${COMPANY_ID} ===`);
  console.log(`cutoff T=${cutoff}, horizon ${HORIZON_DAYS}d, min pre-mentions ${MIN_PRE_MENTIONS}\n`);

  const rowsRes = await db.execute(sql`
    select ts.entity_id, ts.platform, ts.bucket_date::text as bucket_date,
           ts.mentions, ts.unique_authors, e.canonical_label
    from tp_entity_timeseries ts
    join tp_entities e on e.id = ts.entity_id
    where ts.company_id = ${COMPANY_ID} and ts.bucket_date <= ${horizonEnd}
    order by ts.entity_id, ts.bucket_date
  `);
  const byEntity = new Map<number, any[]>();
  for (const r of rowsRes.rows as any[]) {
    const list = byEntity.get(r.entity_id) ?? [];
    list.push(r);
    byEntity.set(r.entity_id, list);
  }

  // Build each entity's gate input and outcome ONCE; variants are pure
  // functions of that input, so nothing below re-reads the database.
  type Case = { entityId: number; label: string; input: GateInput; ratio: number; post: number };
  const cases: Case[] = [];
  for (const [entityId, rows] of byEntity) {
    const preRows = rows.filter((r) => r.bucket_date <= cutoff);
    if (preRows.length === 0) continue;
    const preWindow = rows.filter((r) => r.bucket_date > preStart && r.bucket_date <= cutoff);
    const pre = preWindow.reduce((s: number, r: any) => s + r.mentions, 0);
    if (pre < MIN_PRE_MENTIONS) continue;
    const post = rows
      .filter((r) => r.bucket_date > cutoff && r.bucket_date <= horizonEnd)
      .reduce((s: number, r: any) => s + r.mentions, 0);
    const input = buildGateInput(
      preRows.map((r) => ({
        bucketDate: r.bucket_date,
        platform: r.platform,
        mentions: r.mentions,
        uniqueAuthors: r.unique_authors,
      })) as unknown as TpEntityTimeseries[]
    );
    if (input.dailyMentions.length < 14) continue; // gate cannot judge these
    cases.push({ entityId, label: rows[0]!.canonical_label, input, ratio: (post + 1) / (pre + 1), post });
  }
  console.log(`${cases.length} entities evaluated by every variant\n`);

  console.log(
    `${"variant".padEnd(32)} ${"surfaced".padStart(8)} ${"growth".padStart(7)} ${"vs rest".padStart(8)} ${"edge".padStart(6)} ${"p".padStart(9)}`
  );
  console.log("-".repeat(78));

  const scored: { name: string; surfaced: number; edge: number; p: number }[] = [];
  for (const v of variants) {
    const yes = cases.filter((c) => v.decide(c.input, c.entityId));
    const no = cases.filter((c) => !v.decide(c.input, c.entityId));
    if (yes.length < MIN_COHORT || no.length < MIN_COHORT) {
      console.log(
        `${v.name.padEnd(32)} ${String(yes.length).padStart(8)} ${"—".padStart(7)} ${"—".padStart(8)} ${"—".padStart(6)} underpowered`
      );
      continue;
    }
    const ym = median(yes.map((c) => c.ratio));
    const nm = median(no.map((c) => c.ratio));
    const mw = mannWhitney(yes.map((c) => c.ratio), no.map((c) => c.ratio));
    const edge = ym / nm;
    scored.push({ name: v.name, surfaced: yes.length, edge, p: mw.p });
    console.log(
      `${v.name.padEnd(32)} ${String(yes.length).padStart(8)} ${ym.toFixed(2).padStart(7)} ${nm.toFixed(2).padStart(8)} ${edge.toFixed(2).padStart(6)}x ${(mw.p < 0.0001 ? "<0.0001" : mw.p.toFixed(4)).padStart(9)}`
    );
  }

  console.log(`\n--- ranked by edge (only variants significant at p<0.05) ---`);
  const sig = scored.filter((s) => s.p < 0.05).sort((a, b) => b.edge - a.edge);
  if (sig.length === 0) {
    console.log(`  none reached significance — no variant is demonstrably better than chance.`);
  } else {
    for (const s of sig) {
      console.log(
        `  ${s.edge.toFixed(2)}x  ${s.name.padEnd(32)} surfaces ${s.surfaced} entities (p=${s.p < 0.0001 ? "<0.0001" : s.p.toFixed(4)})`
      );
    }
    console.log(
      `\n  Note: edge and coverage trade off. A variant that surfaces 20 items at a high\n` +
        `  edge is not automatically better than one surfacing 150 at a slightly lower\n` +
        `  edge — the radar needs enough items to be useful to a client. Read both columns.`
    );
  }
  for (const v of variants) console.log(`\n  ${v.name}: ${v.note}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
