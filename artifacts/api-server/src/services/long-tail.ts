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
// Qualifying entities (>= longTailMinMentions current AND posterior >=
// longTailMinPosterior AND not in core_vocabulary) get a fresh row in
// tp_long_tail_candidates tagged with the run's computedAt. Rows from
// prior runs for this company are deleted at the end of the run — the
// table is effectively a "current snapshot" with the unique index allowing
// a brief window of co-existence during the transaction.
// ---------------------------------------------------------------------------

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
  filteredCoreVocab: number;
  windowStart: string;
  windowEnd: string;
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

  let filteredCoreVocab = 0;

  for (const r of rows) {
    const current = Number(r.currentMentions) || 0;
    if (current < minMentions) continue;

    // Skip if the entity's canonical label is in the company's core vocab.
    // Matches the same "bare exact match" rule used at extraction time and
    // in the radar list filter.
    if (coreVocab.has(r.canonicalLabel.trim().toLowerCase())) {
      filteredCoreVocab++;
      continue;
    }

    // Prefer YoY baseline when prior-year window has any data; otherwise
    // fall back to immediately preceding 30d. Tag each row so the UI can
    // render "vs same 30d last year" vs "vs prior 30d".
    let baseline = Number(r.yoyMentions) || 0;
    let baselineKind = "yoy";
    if (baseline === 0) {
      baseline = Number(r.priorMentions) || 0;
      baselineKind = "prior_window";
    }
    // If neither window has any data, the entity is brand-new — we can't
    // estimate uplift against nothing, so skip rather than report a
    // misleading +infinity.
    if (baseline === 0) continue;

    const posterior = bayesianUpliftPosterior(current, baseline);
    if (posterior < minPosterior) continue;

    const upliftScore = current / Math.max(baseline, 1);

    qualifyingInserts.push({
      companyId,
      entityId: r.entityId,
      windowStart: curStart,
      windowEnd: today,
      currentMentions: current,
      baselineMentions: baseline,
      baselineKind,
      upliftScore,
      posteriorProb: posterior,
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
    filteredCoreVocab,
    windowStart: curStart,
    windowEnd: today,
  };
  logger.info({ companyId, ...stats }, "Long-tail evaluation complete");
  return stats;
}
