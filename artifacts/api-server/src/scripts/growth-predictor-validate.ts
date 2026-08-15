// DOES THE STATE MACHINE'S GROWTH THRESHOLD PREDICT ANYTHING?
//
// The confirmation gate has been validated against outcomes (holdout-validate.ts:
// breadth 1.65x, significance 1.00x). The STATE MACHINE's promotion threshold
// never has. It gates candidate -> emerging on raw week-over-week mention
// growth (state-machine.ts computeMetrics), which is the same raw measure the
// radar display stopped using, because raw counts are inflated by how hard we
// happened to scrape. On live data it passes 84% of entities, which is barely
// a threshold at all.
//
// Before swapping it for share-of-voice, measure whether either predicts.
// Same method as the gate holdout: pick a cutoff in the past, compute each
// predictor from data available AT that cutoff only, then look at what
// actually happened afterwards.
//
// PREDICTORS COMPARED (all computed at the cutoff, no lookahead):
//   wow      raw last-7d vs prior-7d          <- what the state machine uses now
//   mom      raw last-30d vs the 30d before   <- the state machine's other input
//   sov      per-platform share-of-voice      <- the candidate replacement
//   volume   raw mentions in last 30d         <- dumb baseline, must be beaten
//
// The SOV combination rule is IMPORTED from services/share-of-voice.ts, not
// reimplemented, so this measures the shipped rule.
//
// WHAT THIS CANNOT SHOW: the same caveat as the gate holdout. Pre-cutoff data
// was retrieved by a later scrape, so recency skew inflates both cohorts.
// Read the RATIO between cohorts, never the absolute growth.
//
//   COMPANY_ID=2 pnpm exec tsx --env-file=../../.env \
//     src/scripts/growth-predictor-validate.ts

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { combinePlatformGrowths } from "../services/share-of-voice.js";
import { mannWhitney, median } from "./holdout-validate.js";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "2");
const HORIZON_DAYS = Number(process.env.HORIZON_DAYS ?? "56");
const SOV_WINDOW = Number(process.env.SOV_WINDOW_DAYS ?? "60");
const MIN_PRE_MENTIONS = Number(process.env.MIN_PRE_MENTIONS ?? "3");
// The live production value of candidateToEmergingMinWowGrowth.
const WOW_THRESHOLD = Number(process.env.WOW_THRESHOLD ?? "0.3");

const addDays = (iso: string, n: number) =>
  new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400_000)
    .toISOString()
    .slice(0, 10);

function growthRate(a: number, b: number): number {
  if (a === 0) return b > 0 ? 1 : 0;
  return (b - a) / a;
}

interface Row {
  entity_id: number;
  platform: string;
  bucket_date: string;
  mentions: number;
  canonical_label: string;
}

interface Scored {
  entityId: number;
  label: string;
  wow: number;
  mom: number;
  sov: number | null;
  volume30: number;
  preMentions: number;
  postMentions: number;
  /** Forward outcome: post-horizon mentions relative to pre-window mentions. */
  ratio: number;
}

/** Sum mentions in (start, end]. */
function sumBetween(rows: Row[], start: string, end: string): number {
  let n = 0;
  for (const r of rows) if (r.bucket_date > start && r.bucket_date <= end) n += r.mentions;
  return n;
}

async function main() {
  const bounds: any = await db.execute(sql`
    select min(bucket_date)::text as first_day, max(bucket_date)::text as last_day
    from tp_entity_timeseries where company_id = ${COMPANY_ID}`);
  const { first_day, last_day } = bounds.rows[0];
  if (!last_day) throw new Error(`No timeseries for company ${COMPANY_ID}`);
  const cutoff = process.env.CUTOFF ?? addDays(last_day, -HORIZON_DAYS);
  const horizonEnd = addDays(cutoff, HORIZON_DAYS);

  console.log(`\ngrowth-predictor-validate — company ${COMPANY_ID}`);
  console.log(`data ${first_day} .. ${last_day}`);
  console.log(`cutoff ${cutoff}, horizon ${HORIZON_DAYS}d -> ${horizonEnd}`);
  console.log(`wow threshold ${WOW_THRESHOLD} (live production value)\n`);

  const res: any = await db.execute(sql`
    select ts.entity_id, ts.platform, ts.bucket_date::text as bucket_date,
           ts.mentions, e.canonical_label
      from tp_entity_timeseries ts
      join tp_entities e on e.id = ts.entity_id
     where ts.company_id = ${COMPANY_ID} and ts.bucket_date <= ${horizonEnd}
     order by ts.entity_id, ts.bucket_date`);
  const rows = res.rows as Row[];

  const byEntity = new Map<number, Row[]>();
  for (const r of rows) {
    const l = byEntity.get(r.entity_id) ?? [];
    l.push(r);
    byEntity.set(r.entity_id, l);
  }

  // Platform totals per window, needed to turn raw counts into SHARE. This is
  // the whole point of share-of-voice: an entity growing slower than its
  // platform is not growing.
  const sovRecentStart = addDays(cutoff, -SOV_WINDOW);
  const sovPriorStart = addDays(cutoff, -SOV_WINDOW * 2);
  const platformRecentTotal = new Map<string, number>();
  const platformPriorTotal = new Map<string, number>();
  for (const r of rows) {
    if (r.bucket_date > sovRecentStart && r.bucket_date <= cutoff) {
      platformRecentTotal.set(r.platform, (platformRecentTotal.get(r.platform) ?? 0) + r.mentions);
    } else if (r.bucket_date > sovPriorStart && r.bucket_date <= sovRecentStart) {
      platformPriorTotal.set(r.platform, (platformPriorTotal.get(r.platform) ?? 0) + r.mentions);
    }
  }

  const scored: Scored[] = [];
  for (const [entityId, erows] of byEntity) {
    const preWindowStart = addDays(cutoff, -HORIZON_DAYS);
    const preMentions = sumBetween(erows, preWindowStart, cutoff);
    if (preMentions < MIN_PRE_MENTIONS) continue;

    // --- predictors, computed from pre-cutoff data only ---
    const thisWeek = sumBetween(erows, addDays(cutoff, -7), cutoff);
    const prevWeek = sumBetween(erows, addDays(cutoff, -14), addDays(cutoff, -7));
    const wow = growthRate(prevWeek, thisWeek);

    const last30 = sumBetween(erows, addDays(cutoff, -30), cutoff);
    const prev30 = sumBetween(erows, addDays(cutoff, -60), addDays(cutoff, -30));
    const mom = growthRate(prev30, last30);

    const perPlatform = new Map<string, { recentN: number; priorN: number }>();
    for (const r of erows) {
      if (r.bucket_date > sovRecentStart && r.bucket_date <= cutoff) {
        const e = perPlatform.get(r.platform) ?? { recentN: 0, priorN: 0 };
        e.recentN += r.mentions;
        perPlatform.set(r.platform, e);
      } else if (r.bucket_date > sovPriorStart && r.bucket_date <= sovRecentStart) {
        const e = perPlatform.get(r.platform) ?? { recentN: 0, priorN: 0 };
        e.priorN += r.mentions;
        perPlatform.set(r.platform, e);
      }
    }
    const sovInput = [...perPlatform.entries()].map(([platform, v]) => ({
      platform,
      recentN: v.recentN,
      priorN: v.priorN,
      recentTotal: platformRecentTotal.get(platform) ?? 0,
      priorTotal: platformPriorTotal.get(platform) ?? 0,
    }));
    const sov = combinePlatformGrowths(sovInput).growthPct;

    const postMentions = sumBetween(erows, cutoff, horizonEnd);
    scored.push({
      entityId,
      label: erows[0]!.canonical_label,
      wow,
      mom,
      sov,
      volume30: last30,
      preMentions,
      postMentions,
      ratio: postMentions / preMentions,
    });
  }

  console.log(`entities evaluated: ${scored.length}\n`);

  // --- compare each predictor's "would promote" cohort against the rest ---
  function report(
    name: string,
    predicate: (s: Scored) => boolean | null,
    note = ""
  ) {
    const yes: number[] = [];
    const no: number[] = [];
    let skipped = 0;
    for (const s of scored) {
      const v = predicate(s);
      if (v === null) { skipped++; continue; }
      (v ? yes : no).push(s.ratio);
    }
    if (yes.length < 20 || no.length < 20) {
      console.log(
        `${name.padEnd(26)} UNDERPOWERED (${yes.length} vs ${no.length})${note ? "  " + note : ""}`
      );
      return;
    }
    const my = median(yes);
    const mn = median(no);
    const edge = mn > 0 ? my / mn : NaN;
    const { p } = mannWhitney(yes, no);
    const stars = p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "   ";
    console.log(
      `${name.padEnd(26)} ${String(yes.length).padStart(5)} vs ${String(no.length).padStart(5)}` +
        `   median ${my.toFixed(2)} vs ${mn.toFixed(2)}` +
        `   edge ${edge.toFixed(2)}x   p=${p.toFixed(4)} ${stars}` +
        (skipped ? `   (${skipped} unscorable)` : "") +
        (note ? `   ${note}` : "")
    );
  }

  console.log("predictor                    cohort sizes      forward growth        edge / significance");
  console.log("-".repeat(104));
  report(`wow >= ${WOW_THRESHOLD} (SHIPPED)`, (s) => s.wow >= WOW_THRESHOLD);
  report(`mom >= ${WOW_THRESHOLD}`, (s) => s.mom >= WOW_THRESHOLD);
  report("sov > 0 (scorable only)", (s) => (s.sov === null ? null : s.sov > 0));
  report("sov > 0 (null counts as no)", (s) => s.sov !== null && s.sov > 0);
  report("volume30 >= 9 (baseline)", (s) => s.volume30 >= 9);

  // How much of the population each predictor actually separates. A threshold
  // that passes almost everything cannot be doing much work regardless of p.
  const passRate = (f: (s: Scored) => boolean) =>
    ((scored.filter(f).length / scored.length) * 100).toFixed(1) + "%";
  console.log("\npass rates (a threshold passing ~everything is not a threshold):");
  console.log(`  wow >= ${WOW_THRESHOLD}        ${passRate((s) => s.wow >= WOW_THRESHOLD)}`);
  console.log(`  mom >= ${WOW_THRESHOLD}        ${passRate((s) => s.mom >= WOW_THRESHOLD)}`);
  console.log(`  sov > 0            ${passRate((s) => s.sov !== null && s.sov > 0)}`);
  console.log(`  sov scorable       ${passRate((s) => s.sov !== null)}`);
  console.log(`  volume30 >= 9      ${passRate((s) => s.volume30 >= 9)}`);

  // ---------------------------------------------------------------------
  // CONFOUND CHECK. The outcome is post/pre, and every growth predictor
  // selects for entities whose PRE window ends high — which inflates the
  // denominator and mechanically depresses the ratio. So a negative edge on a
  // growth predictor may be arithmetic, not mean reversion.
  //
  // Two controls, the same way the gate holdout handled it:
  //   1. an outcome that has no pre-window denominator (raw post mentions)
  //   2. the ratio outcome stratified WITHIN pre-volume bands
  // An effect that survives both is real.
  // ---------------------------------------------------------------------
  console.log("\n\nCONFOUND CHECK 1 — outcome = raw post-horizon mentions (no denominator)");
  console.log("-".repeat(104));
  function reportRaw(name: string, predicate: (s: Scored) => boolean | null) {
    const yes: number[] = []; const no: number[] = [];
    for (const s of scored) {
      const v = predicate(s);
      if (v === null) continue;
      (v ? yes : no).push(s.postMentions);
    }
    if (yes.length < 20 || no.length < 20) {
      console.log(`${name.padEnd(26)} UNDERPOWERED`); return;
    }
    const my = median(yes), mn = median(no);
    const { p } = mannWhitney(yes, no);
    const stars = p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "   ";
    console.log(
      `${name.padEnd(26)} ${String(yes.length).padStart(5)} vs ${String(no.length).padStart(5)}` +
      `   median ${my.toFixed(1)} vs ${mn.toFixed(1)}` +
      `   edge ${(mn>0?my/mn:NaN).toFixed(2)}x   p=${p.toFixed(4)} ${stars}`);
  }
  reportRaw(`wow >= ${WOW_THRESHOLD} (SHIPPED)`, (s) => s.wow >= WOW_THRESHOLD);
  reportRaw(`mom >= ${WOW_THRESHOLD}`, (s) => s.mom >= WOW_THRESHOLD);
  reportRaw("sov > 0 (scorable only)", (s) => (s.sov === null ? null : s.sov > 0));
  reportRaw("volume30 >= 9 (baseline)", (s) => s.volume30 >= 9);

  console.log("\n\nCONFOUND CHECK 2 — ratio outcome, stratified within pre-volume bands");
  console.log("-".repeat(104));
  const bands: [string, (n: number) => boolean][] = [
    ["pre 3-5", (n) => n >= 3 && n <= 5],
    ["pre 6-10", (n) => n >= 6 && n <= 10],
    ["pre 11-30", (n) => n >= 11 && n <= 30],
    ["pre 31+", (n) => n >= 31],
  ];
  for (const [bandName, inBand] of bands) {
    const band = scored.filter((s) => inBand(s.preMentions));
    const line: string[] = [];
    for (const [pname, pred] of [
      ["wow", (s: Scored) => (s.wow >= WOW_THRESHOLD ? true : false)],
      ["sov", (s: Scored) => (s.sov === null ? null : s.sov > 0)],
    ] as [string, (s: Scored) => boolean | null][]) {
      const yes: number[] = []; const no: number[] = [];
      for (const s of band) {
        const v = pred(s);
        if (v === null) continue;
        (v ? yes : no).push(s.ratio);
      }
      if (yes.length < 15 || no.length < 15) { line.push(`${pname}: n/a`); continue; }
      const e = median(no) > 0 ? median(yes) / median(no) : NaN;
      const { p } = mannWhitney(yes, no);
      line.push(`${pname}: ${e.toFixed(2)}x p=${p.toFixed(3)} (${yes.length}v${no.length})`);
    }
    console.log(`${bandName.padEnd(12)} n=${String(band.length).padStart(4)}   ${line.join("   ")}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
