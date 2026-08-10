// GOOGLE TRENDS CROSS-CHECK — independent corroboration of the breadth check.
//
// The holdout showed the breadth check predicts continued mentions in OUR OWN
// scraped social data. That could just mean it predicts our own scraper. This
// asks a different data source, owned by a different company, measuring a
// different behaviour (search, not posting): do the entities breadth passes
// also show rising GOOGLE SEARCH interest?
//
// DESIGN — cohorts, not cherry-picking. Terms are drawn from the SAME holdout
// cohorts (imported, not reimplemented): breadth-PASS versus breadth-FAIL,
// matched on pre-window volume so the comparison is not secretly about size.
// Without the control group this would just be "look at our winners".
//
// STAGES (so one payment is never repeated):
//   STAGE=plan    pick terms, project cost, fire NOTHING          (free)
//   STAGE=fetch   call the actor, save raw items to disk          (spends)
//   STAGE=analyse parse the saved file, compare cohorts           (free)
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ApifyClient } from "apify-client";
import { computeHoldout, mannWhitney, median, type Result } from "./holdout-validate.js";
import { isWellFormed } from "../services/well-formedness.js";
import { judgeSpecificityBatch } from "../services/specificity.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// PRE-REGISTERED, declared before the run and applied to BOTH arms.
// Calendar-driven terms rise and fall with a date, not with a trend: Easter
// and Mother's Day both fall BEFORE the holdout cutoff, so their search
// interest necessarily collapses after it. Leaving them in would penalise
// whichever arm happens to contain them. The primary analysis keeps them
// (nothing is quietly dropped); a sensitivity analysis excludes them, and both
// numbers are reported.
const CALENDAR_TERMS = new Set([
  "pasqua", "mother's day", "father's day", "christmas", "natale",
  "easter", "halloween", "valentine's day", "san valentino", "black friday",
]);

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "1");
const STAGE = process.env.STAGE ?? "plan";
const PER_COHORT = Number(process.env.PER_COHORT ?? "20");
const TERMS_PER_RUN = 5; // the actor's own cap (buildActorInput slices to 5)
const GEO = process.env.GT_GEO ?? ""; // "" = worldwide
// The actor accepts ONLY these values (read from its published input schema,
// after "today 12-m" was rejected with HTTP 400 invalid-input — invented, not
// checked). There is no 12-month option.
const VALID_TIME_RANGES = [
  "", "now 1-H", "now 4-H", "now 1-d", "now 7-d",
  "today 1-m", "today 3-m", "today 5-y", "all",
];
// "today 5-y" is the only value that puts the holdout cutoff mid-window. v1
// used "today 3-m", whose window began 13 days before the cutoff — far too
// short a pre-period to measure a change against, which is one reason it
// found nothing. 5-y returns weekly points, giving ~8 pre and ~11 post around
// a 56-day horizon: enough on both sides.
const TIME_RANGE = process.env.GT_TIME_RANGE ?? "today 5-y";
if (!VALID_TIME_RANGES.includes(TIME_RANGE)) {
  throw new Error(
    `GT_TIME_RANGE "${TIME_RANGE}" is not accepted by apify/google-trends-scraper. ` +
      `Valid: ${VALID_TIME_RANGES.filter(Boolean).join(", ")}`
  );
}
const OUT = process.env.GT_RAW ?? "/tmp/claude-501/gt-crosscheck-raw.json";
// Cap runs so a probe can measure the REAL per-run cost before committing to
// the full set — GT record counts are not predictable from the plan, and the
// worst-case projection is 30x the likely one.
const MAX_RUNS = Number(process.env.GT_MAX_RUNS ?? "0") || 0;
// Skip runs already paid for by an earlier probe, so a staged fetch never
// re-buys the same terms.
const SKIP_RUNS = Number(process.env.GT_SKIP_RUNS ?? "0") || 0;

// Measured from tp_actor_runs: google_trends floor $0.3034/run, $0.1275/record.
const GT_FLOOR = 0.3034;
const GT_PER_RECORD = 0.1275;

// COHORT SELECTION — v2, and the fix for why v1 measured nothing.
//
// v1 drew both arms straight from the gate's breadth verdict. But
// confirmationVerdict is significance + breadth ONLY: well-formedness and
// specificity run afterwards, in the state machine. So v1's "passes" included
// milk, wine, tea, alcohol and ginger — exactly the generic staples the
// specificity check exists to remove. Google Trends on "milk" cannot say
// anything about a food trend, so the comparison was dead on arrival.
//
// v2 applies the FULL pipeline to both arms: well-formed AND specific, on the
// passes and on the controls alike. Holding "is this a sensible, specific food
// term" constant on both sides is what makes the remaining difference
// attributable to the gate's decision rather than to term quality.
// Dominant signal language per entity, straight from the scraped posts. Used
// to keep both arms English-only: v1 put three Italian terms in the CONTROL
// arm and none in the pass arm, and querying those worldwide yields a low,
// noisy series — an asymmetry between cohorts that has nothing to do with the
// gate. A data-driven rule applied to both arms beats guessing from spelling.
async function fetchDominantLanguage(companyId: number): Promise<Map<number, string>> {
  const r = await db.execute(sql`
    select tse.entity_id,
           mode() within group (order by trs.language) as dominant_lang
    from tp_signal_entities tse
    join tp_raw_signals trs on trs.id = tse.raw_signal_id
    where trs.company_id = ${companyId} and trs.language is not null
    group by tse.entity_id
  `);
  const m = new Map<number, string>();
  for (const row of r.rows as any[]) m.set(Number(row.entity_id), String(row.dominant_lang));
  return m;
}

async function matchedCohorts(results: Result[], perCohort: number) {
  const langs = await fetchDominantLanguage(COMPANY_ID);
  const evaluated = results
    .filter((r) => !r.insufficientHistory)
    .filter((r) => (langs.get(r.entityId) ?? "en") === "en");

  // 1. Well-formedness (free, pure).
  const wellFormed = evaluated.filter((r) => isWellFormed(r.label).wellFormed);

  // 2. Specificity (LLM, ~cents). Judged on the union up front so both arms
  //    are filtered by exactly the same call and the same prompt.
  const pool = wellFormed
    .filter((r) => r.breadthPass)
    .slice(0, perCohort * 3)
    .concat(wellFormed.filter((r) => !r.breadthPass).slice(0, perCohort * 6));
  const verdicts = await judgeSpecificityBatch([...new Set(pool.map((r) => r.label))]);
  const isSpecific = (r: Result) => verdicts.get(r.label)?.specific === true;

  const pass = wellFormed
    .filter((r) => r.breadthPass && isSpecific(r))
    .sort((a, b) => b.preMentions - a.preMentions);
  const failPool = wellFormed.filter((r) => !r.breadthPass && isSpecific(r));

  console.log(
    `cohort funnel: ${evaluated.length} English-dominant evaluated -> ${wellFormed.length} well-formed -> ` +
      `specific: ${pass.length} breadth-pass, ${failPool.length} breadth-fail`
  );

  // Spread across the volume range rather than taking the loudest N.
  const step = Math.max(1, Math.floor(pass.length / perCohort));
  const chosenPass = pass.filter((_, i) => i % step === 0).slice(0, perCohort);
  const used = new Set<number>();
  const chosenFail: Result[] = [];
  for (const p of chosenPass) {
    let best: Result | null = null;
    let bestDiff = Infinity;
    for (const f of failPool) {
      if (used.has(f.entityId)) continue;
      const d = Math.abs(f.preMentions - p.preMentions);
      if (d < bestDiff) {
        bestDiff = d;
        best = f;
      }
    }
    if (best) {
      used.add(best.entityId);
      chosenFail.push(best);
    }
  }
  return { chosenPass, chosenFail };
}

// Normalised trend slope of a 0-100 interest series: least-squares slope
// divided by the series mean, so a term with a high baseline is not
// automatically judged to be rising faster than a small one.
function normalisedSlope(series: { ts: number; value: number }[]): number | null {
  const pts = series.filter((p) => Number.isFinite(p.value));
  if (pts.length < 4) return null;
  const n = pts.length;
  const meanX = (n - 1) / 2;
  const meanY = pts.reduce((s, p) => s + p.value, 0) / n;
  if (meanY <= 0) return null;
  let num = 0;
  let den = 0;
  pts.forEach((p, i) => {
    num += (i - meanX) * (p.value - meanY);
    den += (i - meanX) ** 2;
  });
  if (den === 0) return null;
  return (num / den) / meanY;
}

async function main() {
  const { results, cutoff } = await computeHoldout(COMPANY_ID);
  const { chosenPass, chosenFail } = await matchedCohorts(results, PER_COHORT);
  const terms = [
    ...chosenPass.map((r) => ({ term: r.label, cohort: "breadth-pass" as const, pre: r.preMentions })),
    ...chosenFail.map((r) => ({ term: r.label, cohort: "breadth-fail" as const, pre: r.preMentions })),
  ];
  const runs = Math.ceil(terms.length / TERMS_PER_RUN);

  if (STAGE === "plan") {
    console.log(`=== GOOGLE TRENDS CROSS-CHECK — plan only, nothing fired ===`);
    console.log(`company ${COMPANY_ID}, holdout cutoff T=${cutoff}, geo="${GEO || "worldwide"}"\n`);
    console.log(`breadth-PASS terms (${chosenPass.length}):`);
    for (const r of chosenPass) console.log(`   ${r.label.slice(0, 32).padEnd(34)} pre=${r.preMentions}`);
    console.log(`\nbreadth-FAIL controls (${chosenFail.length}), volume-matched:`);
    for (const r of chosenFail) console.log(`   ${r.label.slice(0, 32).padEnd(34)} pre=${r.preMentions}`);
    console.log(
      `\nmedian pre-volume: PASS ${median(chosenPass.map((r) => r.preMentions))} vs FAIL ${median(chosenFail.map((r) => r.preMentions))}` +
        `  (matched, so this is not a size comparison)`
    );
    // Records per GT run are not fixed; historical average is ~1.8/run but a
    // run can return one row per weekly point per term. Price BOTH so the
    // number approved is the worst case, not the hoped-for one.
    const optimistic = runs * Math.max(GT_FLOOR, 1.8 * GT_PER_RECORD);
    const worst = runs * Math.max(GT_FLOOR, TERMS_PER_RUN * 14 * GT_PER_RECORD);
    console.log(
      `\n${terms.length} terms / ${TERMS_PER_RUN} per run = ${runs} runs` +
        `\n  likely cost  $${optimistic.toFixed(2)}   (historical ~1.8 records/run)` +
        `\n  worst case   $${worst.toFixed(2)}   (if it returns a row per weekly point per term)`
    );
    console.log(`\nRun with STAGE=fetch to execute. Raw items are saved to ${OUT} so parsing never re-pays.`);
    return;
  }

  if (STAGE === "fetch") {
    const token = process.env.APIFY_TOKEN;
    if (!token) throw new Error("APIFY_TOKEN not set");
    const client = new ApifyClient({ token });
    const all: any[] = [];
    const limit = MAX_RUNS > 0 ? (SKIP_RUNS + MAX_RUNS) * TERMS_PER_RUN : terms.length;
    let spent = 0;
    for (let i = SKIP_RUNS * TERMS_PER_RUN; i < Math.min(terms.length, limit); i += TERMS_PER_RUN) {
      const chunk = terms.slice(i, i + TERMS_PER_RUN);
      const searchTerms = chunk.map((t) => t.term);
      console.log(`run ${i / TERMS_PER_RUN + 1}/${runs}: ${searchTerms.join(", ")}`);
      const run = await client.actor("apify/google-trends-scraper").call(
        { searchTerms, geo: GEO, timeRange: TIME_RANGE },
        { memory: 1024 }
      );
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      const used = Number((run as any).usageTotalUsd ?? 0);
      spent += used;
      console.log(`   -> ${items.length} items, apify usageTotalUsd=$${used.toFixed(4)}, cumulative $${spent.toFixed(4)}`);
      all.push(...items);
    }
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ terms, items: all }, null, 2));
    console.log(`\nSaved ${all.length} raw items to ${OUT}. REAL spend this stage: $${spent.toFixed(4)}.`);
    console.log(`Run STAGE=analyse (free).`);
    return;
  }

  // analyse
  // GT_RAW may list several files (comma-separated) so a probe and a later
  // fetch analyse together instead of one overwriting the other.
  const files = OUT.split(",").map((f) => f.trim()).filter(Boolean);
  const merged: any[] = [];
  const savedTerms = new Map<string, (typeof terms)[number]>();
  for (const f of files) {
    if (!existsSync(f)) throw new Error(`No raw file at ${f} — run STAGE=fetch first`);
    const parsed = JSON.parse(readFileSync(f, "utf-8"));
    merged.push(...(parsed.items ?? []));
    // Read the term list that was ACTUALLY FETCHED rather than recomputing it.
    // Cohort selection calls an LLM specificity judge, which is not fully
    // deterministic — re-deriving here can silently disagree with what was
    // paid for, mismatching terms to items and quietly shrinking the cohorts.
    for (const t of parsed.terms ?? []) savedTerms.set(t.term, t);
  }
  const raw = { terms: [...savedTerms.values()], items: merged } as {
    terms: typeof terms;
    items: any[];
  };
  console.log(`=== GOOGLE TRENDS CROSS-CHECK — analysis (${raw.items.length} raw items) ===`);
  if (raw.items.length > 0) {
    console.log(`sample item keys: ${Object.keys(raw.items[0]).join(", ")}`);
  }

  // Real shape, confirmed from a probe run: one item per search term, with a
  // daily series under interestOverTime_timelineData ({formattedTime, value:
  // [n]}). Parsed against the observed structure rather than a guess.
  // Use the unix `time` field, NOT formattedTime. On a 5-year window
  // formattedTime is a week RANGE ("Aug 8 - 14, 2021") which Date.parse cannot
  // read — every point would silently drop out and the test would report
  // another meaningless null. `time` is unix seconds on every window length.
  const seriesByTerm = new Map<string, { ts: number; value: number }[]>();
  for (const it of raw.items) {
    const term = it.searchTerm ?? it.inputUrlOrTerm;
    const timeline = it.interestOverTime_timelineData;
    if (typeof term !== "string" || !Array.isArray(timeline)) continue;
    // The actor can return the same term twice in one run (observed on the
    // probe); last one wins rather than duplicating it into the cohort.
    const series = timeline
      .map((pt: any) => ({
        ts: Number(pt.time) * 1000,
        value: Array.isArray(pt.value) ? Number(pt.value[0]) : Number(pt.value),
      }))
      .filter((p: any) => Number.isFinite(p.value) && Number.isFinite(p.ts) && p.ts > 0)
      .sort((a: any, b: any) => a.ts - b.ts);
    if (series.length > 0) seriesByTerm.set(term, series);
  }
  console.log(`parsed series for ${seriesByTerm.size} of ${raw.terms.length} requested terms`);
  const missing = raw.terms.filter((t) => !seriesByTerm.has(t.term));
  if (missing.length > 0) {
    // Failures are NOT assumed random. If they land disproportionately in one
    // cohort the comparison is biased, so report the split explicitly rather
    // than silently analysing whatever came back.
    const mp = missing.filter((t) => t.cohort === "breadth-pass").length;
    const mf = missing.filter((t) => t.cohort === "breadth-fail").length;
    console.log(
      `  MISSING ${missing.length}: ${mp} breadth-pass, ${mf} breadth-fail` +
        `  ${mp !== mf ? "<- UNEVEN, treat any result as biased" : "(evenly split)"}`
    );
    console.log(`  terms: ${missing.map((t) => t.term).join(", ")}`);
  }
  console.log();

  // PRE/POST AROUND THE CUTOFF — the like-for-like metric.
  // The social holdout asks "did mentions rise after T". This asks the same
  // question of search interest, over the same T, so the two are comparable.
  // A 3-month window could not support this (it began after T); 12 months can.
  const cutoffMs = new Date(cutoff + "T00:00:00Z").getTime();
  // SYMMETRIC window around the cutoff. With a 5-year series, "every point
  // before T" would average five years of history against eleven weeks after
  // it — a comparison dominated by ancient data. Both sides get the same
  // HORIZON_DAYS span, mirroring the social holdout exactly.
  const HORIZON_MS = Number(process.env.HORIZON_DAYS ?? "56") * 86400_000;
  function prePostRatio(series: { ts: number; value: number }[]): number | null {
    const pre: number[] = [];
    const post: number[] = [];
    for (const p of series) {
      const t = p.ts;
      if (t <= cutoffMs && t > cutoffMs - HORIZON_MS) pre.push(p.value);
      else if (t > cutoffMs && t <= cutoffMs + HORIZON_MS) post.push(p.value);
    }
    if (pre.length < 4 || post.length < 4) return null;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const pm = mean(pre);
    if (pm <= 0) return null;
    return mean(post) / pm;
  }

  const slopes: { term: string; cohort: string; slope: number }[] = [];
  const ratios: { term: string; cohort: string; ratio: number }[] = [];
  for (const t of raw.terms) {
    const series = seriesByTerm.get(t.term);
    if (!series || series.length < 4) continue;
    const s = normalisedSlope(series);
    if (s !== null) slopes.push({ term: t.term, cohort: t.cohort, slope: s });
    const pp = prePostRatio(series);
    if (pp !== null) ratios.push({ term: t.term, cohort: t.cohort, ratio: pp });
  }

  // Report the pre/post metric FIRST — it is the one that mirrors the social
  // holdout and therefore the one the corroboration claim rests on.
  const rPass = ratios.filter((r) => r.cohort === "breadth-pass").map((r) => r.ratio);
  const rFail = ratios.filter((r) => r.cohort === "breadth-fail").map((r) => r.ratio);
  console.log(`--- search interest AFTER vs BEFORE the holdout cutoff (${cutoff}) ---`);
  console.log(`  breadth-PASS  n=${rPass.length}  median ${rPass.length ? median(rPass).toFixed(3) : "n/a"}x`);
  console.log(`  breadth-FAIL  n=${rFail.length}  median ${rFail.length ? median(rFail).toFixed(3) : "n/a"}x`);
  if (rPass.length >= 8 && rFail.length >= 8) {
    const mw = mannWhitney(rPass, rFail);
    const pm = median(rPass);
    const fm = median(rFail);
    console.log(`  rank test z=${mw.z.toFixed(2)}, p=${mw.p < 0.0001 ? "<0.0001" : mw.p.toFixed(4)}, ratio ${(pm / fm).toFixed(2)}x`);
    console.log(
      `  -> ${
        mw.p >= 0.05
          ? "NO independent corroboration on this metric at this sample size."
          : pm > fm
            ? "CORROBORATED — gate-passed entities also rose in Google search."
            : "INVERTED — gate-passed entities fell in search relative to controls."
      }`
    );
  } else {
    console.log(`  UNDERPOWERED (${rPass.length}/${rFail.length}, need >=8 each).`);
  }

  // Pre-registered sensitivity: same test with calendar-driven terms removed.
  const notCalendar = (t: string) => !CALENDAR_TERMS.has(t.toLowerCase());
  const sPass = ratios.filter((r) => r.cohort === "breadth-pass" && notCalendar(r.term)).map((r) => r.ratio);
  const sFail = ratios.filter((r) => r.cohort === "breadth-fail" && notCalendar(r.term)).map((r) => r.ratio);
  const dropped = ratios.length - (sPass.length + sFail.length);
  if (dropped > 0 && sPass.length >= 8 && sFail.length >= 8) {
    const mw2 = mannWhitney(sPass, sFail);
    console.log(
      `  sensitivity, ${dropped} calendar term(s) excluded: PASS ${median(sPass).toFixed(3)}x (n=${sPass.length}) ` +
        `vs FAIL ${median(sFail).toFixed(3)}x (n=${sFail.length}), p=${mw2.p < 0.0001 ? "<0.0001" : mw2.p.toFixed(4)}`
    );
  } else if (dropped === 0) {
    console.log(`  sensitivity: no calendar terms present, primary analysis is unaffected.`);
  }
  console.log();

  const pass = slopes.filter((s) => s.cohort === "breadth-pass").map((s) => s.slope);
  const fail = slopes.filter((s) => s.cohort === "breadth-fail").map((s) => s.slope);
  console.log(`--- normalised Google search-interest slope over the last 3 months ---`);
  console.log(`  breadth-PASS  n=${pass.length}  median slope ${pass.length ? median(pass).toFixed(5) : "n/a"}`);
  console.log(`  breadth-FAIL  n=${fail.length}  median slope ${fail.length ? median(fail).toFixed(5) : "n/a"}`);
  if (pass.length < 8 || fail.length < 8) {
    console.log(`\n  UNDERPOWERED (need >=8 per cohort, have ${pass.length}/${fail.length}). No conclusion.`);
  } else {
    const mw = mannWhitney(pass, fail);
    console.log(
      `\n  rank test z=${mw.z.toFixed(2)}, p=${mw.p < 0.0001 ? "<0.0001" : mw.p.toFixed(4)}`
    );
    console.log(
      `  -> ${
        mw.p >= 0.05
          ? "NO INDEPENDENT CORROBORATION at this sample size. The breadth check predicts our own social data but this does not show it predicting search."
          : median(pass) > median(fail)
            ? "CORROBORATED — entities the breadth check passes also rise in Google search, an independent source."
            : "INVERTED — breadth-passing entities fell in search relative to controls."
      }`
    );
  }
  console.log(`\n--- per-term detail ---`);
  for (const s of [...slopes].sort((a, b) => b.slope - a.slope)) {
    console.log(`  ${s.cohort.padEnd(13)} ${s.term.slice(0, 30).padEnd(32)} slope ${s.slope.toFixed(5)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
