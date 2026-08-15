import { db } from "@workspace/db";
import {
  tpEntityTimeseries,
  tpEntities,
  tpLongTailCandidates,
  tpPipelineConfig,
} from "@workspace/db";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { getPipelineConfig } from "../storage/index.js";
import { isWellFormed } from "./well-formedness.js";
import { judgeSpecificityBatch, type SpecificityResult } from "./specificity.js";

// ---------------------------------------------------------------------------
// Long-tail Bayesian uplift evaluator (Task #2).
//
// Reads only tp_entity_timeseries — no LLM, no scraper. For every non-deleted
// entity belonging to a company we compute:
//
//   current = sum(mentions, last 30d)
//   baseline = sum(mentions, same 30d window 1yr ago)     [yoy]
//   baseline = sum(mentions, days 30..60 ago) if yoy == 0 [prior_window]
//
// Then a Bayesian posterior under a Beta(1,1) prior on the proportion
// p = current / (current + baseline):
//
//   p | current, baseline ~ Beta(1 + current, 1 + baseline)
//
// Equal-length windows reduce "true rate >= 2x baseline" to p >= 2/3, so
//
//   posterior = P(p >= 2/3) = 1 - I(2/3; 1+current, 1+baseline)
//
// where I is the regularized incomplete beta function (implemented below
// via Lanczos lnGamma + Numerical-Recipes continued fraction; numerically
// stable for small integer counts and far cheaper than sampling).
//
// Qualifying entities (>= longTailMinMentions current AND < the volume
// ceiling AND well-formed AND posterior >= longTailMinPosterior AND not in
// core_vocabulary AND judged specific) get a fresh row in
// tp_long_tail_candidates tagged with the run's computedAt. Rows from
// prior runs for this company are deleted at the end of the run — the
// table is effectively a "current snapshot" with the unique index allowing
// a brief window of co-existence during the transaction.
//
// FILTER ORDER — cheapest first, so an entity that would be rejected anyway
// never spends a paid OpenAI call:
//   1. mention floor        (>= longTailMinMentions)
//   2. volume ceiling       (< the company's own percentile ceiling — see
//                            LONG_TAIL_VOLUME_CEILING_PERCENTILE below)
//   3. core vocabulary      (bare exact-match against the company blocklist)
//   4. well-formedness      (pure, deterministic — well-formedness.ts)
//   5. Bayesian posterior   (>= longTailMinPosterior; still just arithmetic)
//   6. specificity          (LLM, last — specificity.ts, batched per run)
// This mirrors the ordering state-machine.ts uses for the confirmation gate,
// where well-formedness gates the specificity call.
//
// -----------------------------------------------------------------------
// WHY A VOLUME CEILING (added 2026-08 after a client asked "are we using
// this page?"): the lane had a floor but no ceiling, so with no upper bound
// the HIGHEST-volume entities in the company's vocabulary qualified — the
// opposite of "long tail". On company 2 (Fast Food) the top candidates by
// current-30d mentions were café (83), aguacate (65), ajo (42), sal (27),
// pollo (34), huevo (25) — salt, chicken, egg, avocado. Those are staples,
// not an emerging long tail.
//
// The ceiling is derived from each company's OWN distribution (a percentile)
// rather than a hardcoded absolute mention count, because companies differ
// wildly in scale: verified against real data (2026-08), among entities that
// already clear longTailMinMentions=5,
//   company 1 (Leone):     n=279 entities, median=8,  max=221 (gummy)
//   company 2 (Fast Food): n=119 entities, median=7,  max=83  (café)
// A single absolute cutoff could not work for both — e.g. "cap at 20" would
// exclude almost everything for company 2 (p90=24) while still letting
// company 1's mid-volume staples (chocolate=87, probiotic=68, vegan=61)
// through. The default percentile is 50 (the median): at that line company
// 2's offenders above are all well clear of the ceiling and get excluded,
// while the surviving half is dominated by single-digit (5-7 mention)
// entities — an actual long tail. Env-configurable
// (LONG_TAIL_VOLUME_CEILING_PERCENTILE) per company/deployment in case a
// company's real long tail sits at a different point in its own
// distribution.
// ---------------------------------------------------------------------------

// Percentile (0-100) of the current-30d mention-count distribution, among
// entities that already clear longTailMinMentions, used as the upper volume
// bound. Default 50 = median; see the reasoning block above for why a
// percentile beats a hardcoded absolute here.
export const LONG_TAIL_VOLUME_CEILING_PERCENTILE =
  Number(process.env.LONG_TAIL_VOLUME_CEILING_PERCENTILE ?? "50") || 50;

/**
 * Percentile-rank (nearest-rank method) of a set of current-30d mention
 * counts. Pure and re-computed fresh every run from the company's own
 * above-floor entities, not a cross-company constant. Returns null when
 * there is nothing to compute a ceiling from (no entities clear the floor).
 */
export function computeVolumeCeiling(
  mentionCounts: number[],
  percentile: number
): number | null {
  if (mentionCounts.length === 0) return null;
  const sorted = [...mentionCounts].sort((a, b) => a - b);
  const clampedPct = Math.min(100, Math.max(0, percentile));
  const idx = Math.min(sorted.length - 1, Math.floor((clampedPct / 100) * sorted.length));
  return sorted[idx]!;
}

// ---------------------------------------------------------------------------
// Pure selection pass (testable without DB or LLM I/O). Applies every filter
// EXCEPT specificity, which needs a (batched) OpenAI call and stays in
// runLongTailEvaluation below so this function can be unit tested cheaply.
// ---------------------------------------------------------------------------

export interface EntityVolumeRow {
  entityId: number;
  canonicalLabel: string;
  currentMentions: number;
  priorMentions: number;
  yoyMentions: number;
}

export interface LongTailSpecificityCandidate {
  entityId: number;
  canonicalLabel: string;
  currentMentions: number;
  baselineMentions: number;
  baselineKind: string;
  upliftScore: number;
  posteriorProb: number;
}

export interface LongTailSelectionConfig {
  minMentions: number;
  minPosterior: number;
  /** lowercased, trimmed labels */
  coreVocabulary: Set<string>;
  volumeCeilingPercentile: number;
}

export interface LongTailSelectionStats {
  evaluated: number;
  filteredBelowFloor: number;
  volumeCeiling: number | null;
  filteredAboveCeiling: number;
  filteredCoreVocab: number;
  filteredMalformed: number;
  filteredNoBaseline: number;
  filteredLowPosterior: number;
  candidatesForSpecificity: number;
}

export interface LongTailSelectionResult {
  candidates: LongTailSpecificityCandidate[];
  stats: LongTailSelectionStats;
}

export function selectLongTailCandidates(
  rows: EntityVolumeRow[],
  cfg: LongTailSelectionConfig
): LongTailSelectionResult {
  const stats: LongTailSelectionStats = {
    evaluated: rows.length,
    filteredBelowFloor: 0,
    volumeCeiling: null,
    filteredAboveCeiling: 0,
    filteredCoreVocab: 0,
    filteredMalformed: 0,
    filteredNoBaseline: 0,
    filteredLowPosterior: 0,
    candidatesForSpecificity: 0,
  };

  // Stage 1: mention floor.
  const aboveFloor = rows.filter((r) => r.currentMentions >= cfg.minMentions);
  stats.filteredBelowFloor = rows.length - aboveFloor.length;

  // Stage 2: volume ceiling, computed from the above-floor set itself (the
  // company's own long-tail-eligible distribution), not the whole
  // vocabulary — the whole vocabulary includes a mass of near-zero entities
  // that would drag any percentile down to nothing.
  const ceiling = computeVolumeCeiling(
    aboveFloor.map((r) => r.currentMentions),
    cfg.volumeCeilingPercentile
  );
  stats.volumeCeiling = ceiling;

  const candidates: LongTailSpecificityCandidate[] = [];

  for (const r of aboveFloor) {
    // Strictly BELOW the ceiling: with small integer mention counts, ties
    // sitting exactly at the percentile boundary are common, and "below the
    // median" should mean the bottom half, not the bottom half plus every
    // entity tied with the median.
    if (ceiling !== null && r.currentMentions >= ceiling) {
      stats.filteredAboveCeiling++;
      continue;
    }

    // Stage 3: core vocabulary. Matches the same "bare exact match" rule
    // used at extraction time and in the radar list filter.
    if (cfg.coreVocabulary.has(r.canonicalLabel.trim().toLowerCase())) {
      stats.filteredCoreVocab++;
      continue;
    }

    // Stage 4: well-formedness (pure, deterministic, free).
    const wellFormed = isWellFormed(r.canonicalLabel);
    if (!wellFormed.wellFormed) {
      stats.filteredMalformed++;
      continue;
    }

    // Stage 5: Bayesian posterior uplift. Prefer YoY baseline when the
    // prior-year window has any data; otherwise fall back to the
    // immediately preceding 30d. If neither window has any data, the
    // entity is brand-new — we can't estimate uplift against nothing, so
    // skip rather than report a misleading +infinity.
    let baseline = r.yoyMentions;
    let baselineKind = "yoy";
    if (baseline === 0) {
      baseline = r.priorMentions;
      baselineKind = "prior_window";
    }
    if (baseline === 0) {
      stats.filteredNoBaseline++;
      continue;
    }

    const posteriorProb = bayesianUpliftPosterior(r.currentMentions, baseline);
    if (posteriorProb < cfg.minPosterior) {
      stats.filteredLowPosterior++;
      continue;
    }

    candidates.push({
      entityId: r.entityId,
      canonicalLabel: r.canonicalLabel,
      currentMentions: r.currentMentions,
      baselineMentions: baseline,
      baselineKind,
      upliftScore: r.currentMentions / Math.max(baseline, 1),
      posteriorProb,
    });
  }

  stats.candidatesForSpecificity = candidates.length;
  return { candidates, stats };
}

// Lanczos approximation of log Gamma. Standard 6-term coefficients; accurate
// to ~1e-10 for x > 0 which is more than enough for our integer-counts use.
function lnGamma(x: number): number {
  const cof = [
    76.18009172947146,
    -86.50532032941677,
    24.01409824083091,
    -1.231739572450155,
    0.001208650973866179,
    -0.000005395239384953,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j]! / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Continued-fraction expansion of the incomplete beta integral, following
// "Numerical Recipes" 6.4. Converges in O(10–30) iterations for the small
// parameter values we use (alpha,beta both <= a few hundred).
function betacf(x: number, a: number, b: number): number {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/**
 * Regularized incomplete beta I(x; a, b). Returns P(X <= x) where X ~ Beta(a, b).
 */
export function regularizedIncompleteBeta(
  x: number,
  a: number,
  b: number
): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    lnGamma(a + b) -
      lnGamma(a) -
      lnGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x)
  );
  // Use the continued fraction on whichever side converges fastest.
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(x, a, b)) / a;
  }
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

/**
 * Posterior probability that current rate >= 2x baseline rate under a
 * Beta(1,1) prior on the proportion p = current / (current + baseline).
 * Equal-length windows reduce "rate ratio >= 2" to p >= 2/3.
 */
export function bayesianUpliftPosterior(
  currentMentions: number,
  baselineMentions: number
): number {
  // Posterior on p is Beta(1+current, 1+baseline). We want P(p >= 2/3).
  return 1 - regularizedIncompleteBeta(2 / 3, 1 + currentMentions, 1 + baselineMentions);
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface LongTailRunStats {
  evaluated: number;
  qualified: number;
  filteredBelowFloor: number;
  volumeCeiling: number | null;
  filteredAboveCeiling: number;
  filteredCoreVocab: number;
  filteredMalformed: number;
  filteredNoBaseline: number;
  filteredLowPosterior: number;
  filteredNotSpecific: number;
  windowStart: string;
  windowEnd: string;
}

// Terms per judgeSpecificityBatch call. That prompt is only ever exercised
// with a single term in production today (state-machine.ts judges one entity
// at a time), so a long-tail run — which can hand it dozens of surviving
// candidates in one pass — chunks rather than sending an unbounded prompt.
// A failed chunk keeps its terms by default (interpretSpecificityVerdict's
// own "never silently drop on error" rule, applied at the chunk level too)
// and does not abort the rest of the run.
const SPECIFICITY_CHUNK_SIZE = 20;

async function judgeSpecificityChunked(
  labels: string[]
): Promise<Map<string, SpecificityResult>> {
  const out = new Map<string, SpecificityResult>();
  for (let i = 0; i < labels.length; i += SPECIFICITY_CHUNK_SIZE) {
    const chunk = labels.slice(i, i + SPECIFICITY_CHUNK_SIZE);
    try {
      const judged = await judgeSpecificityBatch(chunk);
      for (const [k, v] of judged) out.set(k, v);
    } catch (e) {
      logger.warn(
        { err: e, chunk },
        "long-tail specificity judge failed for a batch — keeping those candidates by default"
      );
    }
  }
  return out;
}

/**
 * Evaluate the long-tail lane for one company. Pure read of tp_entity_timeseries.
 * Inserts qualifying rows into tp_long_tail_candidates and deletes prior-run
 * rows for the same company in a single transaction so the table always
 * reflects the most recent snapshot.
 */
export async function runLongTailEvaluation(
  companyId: number
): Promise<LongTailRunStats> {
  // Use storage.getPipelineConfig (get-or-create) instead of a bare select so
  // the lastLongTailRunAt UPDATE inside the transaction below always has a
  // row to hit. Without this, brand-new companies would compute candidates
  // but the timestamp UPDATE would silently affect 0 rows and the UI would
  // forever show "never evaluated".
  const cfg = await getPipelineConfig(companyId);
  const minMentions = cfg?.longTailMinMentions ?? 5;
  const minPosterior = cfg?.longTailMinPosterior ?? 0.9;
  const coreVocab = new Set(
    (cfg?.coreVocabulary ?? [])
      .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
      .filter(Boolean)
  );

  const now = new Date();
  const d = (days: number) =>
    toDateStr(new Date(now.getTime() - days * 86400_000));

  const today = d(0);
  // Current 30d window [today-29..today].
  const curStart = d(29);
  // Prior 30d window [today-59..today-30] — used as fallback baseline.
  const priorEnd = d(30);
  const priorStart = d(59);
  // YoY 30d window [today-394..today-365] — exactly one year before current.
  const yoyEnd = d(365);
  const yoyStart = d(394);

  // Single aggregate pass: sum each entity's mentions in the three windows
  // plus distinct-day coverage so we can spot entities with no historical
  // baseline at all (curent window only).
  const rows = await db
    .select({
      entityId: tpEntityTimeseries.entityId,
      canonicalLabel: tpEntities.canonicalLabel,
      currentMentions: sql<number>`coalesce(sum(case when ${tpEntityTimeseries.bucketDate} between ${curStart} and ${today} then ${tpEntityTimeseries.mentions} else 0 end), 0)::int`,
      priorMentions: sql<number>`coalesce(sum(case when ${tpEntityTimeseries.bucketDate} between ${priorStart} and ${priorEnd} then ${tpEntityTimeseries.mentions} else 0 end), 0)::int`,
      yoyMentions: sql<number>`coalesce(sum(case when ${tpEntityTimeseries.bucketDate} between ${yoyStart} and ${yoyEnd} then ${tpEntityTimeseries.mentions} else 0 end), 0)::int`,
    })
    .from(tpEntityTimeseries)
    .innerJoin(tpEntities, eq(tpEntities.id, tpEntityTimeseries.entityId))
    .where(
      and(
        eq(tpEntityTimeseries.companyId, companyId),
        isNull(tpEntities.deletedAt),
        gte(tpEntityTimeseries.bucketDate, yoyStart),
        lte(tpEntityTimeseries.bucketDate, today)
      )
    )
    .groupBy(tpEntityTimeseries.entityId, tpEntities.canonicalLabel);

  const computedAt = new Date();

  // Stages 1-5 (mention floor, volume ceiling, core vocabulary,
  // well-formedness, Bayesian posterior) — pure, no I/O, fully unit tested
  // in long-tail.test.ts.
  const selection = selectLongTailCandidates(
    rows.map((r) => ({
      entityId: r.entityId,
      canonicalLabel: r.canonicalLabel,
      currentMentions: Number(r.currentMentions) || 0,
      priorMentions: Number(r.priorMentions) || 0,
      yoyMentions: Number(r.yoyMentions) || 0,
    })),
    {
      minMentions,
      minPosterior,
      coreVocabulary: coreVocab,
      volumeCeilingPercentile: LONG_TAIL_VOLUME_CEILING_PERCENTILE,
    }
  );

  // Stage 6: specificity — the one LLM call, last, and only ever asked about
  // the (usually small) set of candidates that survived every free filter
  // above. Reuses judgeSpecificityBatch (the tuned two-axis prompt with its
  // own eval suite) rather than a second relevance-scoring implementation.
  const specificityMap =
    selection.candidates.length > 0
      ? await judgeSpecificityChunked(selection.candidates.map((c) => c.canonicalLabel))
      : new Map<string, SpecificityResult>();

  let filteredNotSpecific = 0;
  const qualifyingInserts: Array<{
    companyId: number;
    entityId: number;
    windowStart: string;
    windowEnd: string;
    currentMentions: number;
    baselineMentions: number;
    baselineKind: string;
    upliftScore: number;
    posteriorProb: number;
    computedAt: Date;
  }> = [];

  for (const c of selection.candidates) {
    // No verdict (chunk failed, or the model dropped the term) keeps by
    // default — same "never silently drop on error" rule as
    // interpretSpecificityVerdict itself.
    const verdict = specificityMap.get(c.canonicalLabel.toLowerCase());
    if (verdict && !verdict.specific) {
      filteredNotSpecific++;
      continue;
    }

    qualifyingInserts.push({
      companyId,
      entityId: c.entityId,
      windowStart: curStart,
      windowEnd: today,
      currentMentions: c.currentMentions,
      baselineMentions: c.baselineMentions,
      baselineKind: c.baselineKind,
      upliftScore: c.upliftScore,
      posteriorProb: c.posteriorProb,
      computedAt,
    });
  }

  // Replace prior-run snapshot atomically. Soft-delete (a deletedAt column)
  // would be more auditable but for v1 we treat the table as a derived
  // materialised view; nothing else references its rows.
  await db.transaction(async (tx) => {
    await tx
      .delete(tpLongTailCandidates)
      .where(eq(tpLongTailCandidates.companyId, companyId));
    if (qualifyingInserts.length > 0) {
      await tx.insert(tpLongTailCandidates).values(qualifyingInserts);
    }
    await tx
      .update(tpPipelineConfig)
      .set({ lastLongTailRunAt: computedAt })
      .where(eq(tpPipelineConfig.companyId, companyId));
  });

  const stats: LongTailRunStats = {
    evaluated: rows.length,
    qualified: qualifyingInserts.length,
    filteredBelowFloor: selection.stats.filteredBelowFloor,
    volumeCeiling: selection.stats.volumeCeiling,
    filteredAboveCeiling: selection.stats.filteredAboveCeiling,
    filteredCoreVocab: selection.stats.filteredCoreVocab,
    filteredMalformed: selection.stats.filteredMalformed,
    filteredNoBaseline: selection.stats.filteredNoBaseline,
    filteredLowPosterior: selection.stats.filteredLowPosterior,
    filteredNotSpecific,
    windowStart: curStart,
    windowEnd: today,
  };
  logger.info({ companyId, ...stats }, "Long-tail evaluation complete");
  return stats;
}
