import { db } from "@workspace/db";
import { tpEntityTimeseries, tpEntities } from "@workspace/db";
import { eq, and, gte, lte, sql, isNull } from "drizzle-orm";

// ---------------------------------------------------------------------------
// MoM + YoY delta computation (Task #1)
//
// Reads only tp_entity_timeseries (no LLM, no scraper). One aggregate SQL
// query per company returns per-entity sums in four fixed windows:
//
//   momCurrent  = sum(mentions) in last 30 days
//   momPrior    = sum(mentions) in days 30..60 ago
//   yoyCurrent  = sum(mentions) in last 90 days
//   yoyPrior    = sum(mentions) in days 365..455 ago  (matched 90-day window)
//
// momGrowthPct = momCurrent / momPrior - 1
//   null if momPrior == 0 OR insufficient history (entity has < 30 distinct
//   bucket-days across the combined 60-day MoM window).
// yoyGrowthPct = yoyCurrent / yoyPrior - 1
//   null if yoyPrior == 0 OR insufficient history (entity has < 30 distinct
//   bucket-days in the prior-year 90-day window — no real baseline).
//
// Stored as a fraction (0.31 == +31%) to stay consistent with the existing
// growthWow / growthMom columns. UI multiplies by 100 for the badge label.
// ---------------------------------------------------------------------------

export interface EntityDelta {
  entityId: number;
  momCurrent: number;
  momPrior: number;
  yoyCurrent: number;
  yoyPrior: number;
  momGrowthPct: number | null;
  yoyGrowthPct: number | null;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute MoM/YoY deltas for every entity belonging to a company in a single
 * aggregate SQL pass. Entities with no timeseries rows in any of the four
 * windows are omitted (caller should leave their existing values alone).
 */
export async function computeDeltasForCompany(
  companyId: number
): Promise<EntityDelta[]> {
  const now = new Date();
  const d = (days: number) => toDateStr(new Date(now.getTime() - days * 86400_000));

  // All four windows are exactly 30 (MoM) or 90 (YoY) days, fully bounded on
  // both ends so they cannot drift by ±1 day. "Today" (d(0)) is the inclusive
  // upper bound; the prior windows sit immediately before the current ones
  // for MoM and exactly one year offset for YoY.
  const today = d(0);

  const momCurStart = d(29);  // 30-day window [today-29 .. today]
  const momPriorEnd = d(30);  // prior window ends day before current starts
  const momPriorStart = d(59); // [today-59 .. today-30]

  const yoyCurStart = d(89);  // 90-day window [today-89 .. today]
  const yoyPriorEnd = d(365); // [today-454 .. today-365]
  const yoyPriorStart = d(454);

  const rows = await db
    .select({
      entityId: tpEntityTimeseries.entityId,
      momCurrent: sql<number>`coalesce(sum(case when ${tpEntityTimeseries.bucketDate} between ${momCurStart} and ${today} then ${tpEntityTimeseries.mentions} else 0 end), 0)::int`,
      momPrior: sql<number>`coalesce(sum(case when ${tpEntityTimeseries.bucketDate} between ${momPriorStart} and ${momPriorEnd} then ${tpEntityTimeseries.mentions} else 0 end), 0)::int`,
      yoyCurrent: sql<number>`coalesce(sum(case when ${tpEntityTimeseries.bucketDate} between ${yoyCurStart} and ${today} then ${tpEntityTimeseries.mentions} else 0 end), 0)::int`,
      yoyPrior: sql<number>`coalesce(sum(case when ${tpEntityTimeseries.bucketDate} between ${yoyPriorStart} and ${yoyPriorEnd} then ${tpEntityTimeseries.mentions} else 0 end), 0)::int`,
      // Distinct-day coverage for insufficient-history gating. A delta is
      // only meaningful when the entity has been observed on a reasonable
      // fraction of days in the relevant span.
      momCoverageDays: sql<number>`count(distinct case when ${tpEntityTimeseries.bucketDate} between ${momPriorStart} and ${today} then ${tpEntityTimeseries.bucketDate} else null end)::int`,
      yoyPriorCoverageDays: sql<number>`count(distinct case when ${tpEntityTimeseries.bucketDate} between ${yoyPriorStart} and ${yoyPriorEnd} then ${tpEntityTimeseries.bucketDate} else null end)::int`,
    })
    .from(tpEntityTimeseries)
    .innerJoin(tpEntities, eq(tpEntities.id, tpEntityTimeseries.entityId))
    .where(
      and(
        eq(tpEntityTimeseries.companyId, companyId),
        isNull(tpEntities.deletedAt),
        // Bound the scan: only the four windows we read matter, and nothing
        // dated past today (defensive guard against backdated/future rows).
        gte(tpEntityTimeseries.bucketDate, yoyPriorStart),
        lte(tpEntityTimeseries.bucketDate, today)
      )
    )
    .groupBy(tpEntityTimeseries.entityId);

  // Insufficient-history gating: require at least 30 distinct bucket-days
  // spanning the relevant comparison window before we trust a delta. Without
  // this, a brand-new entity with one mention yesterday and one mention 30
  // days ago would show a misleading "0%" / "+inf%" MoM.
  const MIN_COVERAGE_DAYS = 30;

  return rows.map((r) => {
    const momCurrent = Number(r.momCurrent) || 0;
    const momPrior = Number(r.momPrior) || 0;
    const yoyCurrent = Number(r.yoyCurrent) || 0;
    const yoyPrior = Number(r.yoyPrior) || 0;
    const momCoverage = Number(r.momCoverageDays) || 0;
    const yoyPriorCoverage = Number(r.yoyPriorCoverageDays) || 0;

    const momEligible = momPrior > 0 && momCoverage >= MIN_COVERAGE_DAYS;
    const yoyEligible = yoyPrior > 0 && yoyPriorCoverage >= MIN_COVERAGE_DAYS;

    return {
      entityId: r.entityId,
      momCurrent,
      momPrior,
      yoyCurrent,
      yoyPrior,
      momGrowthPct: momEligible ? momCurrent / momPrior - 1 : null,
      yoyGrowthPct: yoyEligible ? yoyCurrent / yoyPrior - 1 : null,
    };
  });
}
