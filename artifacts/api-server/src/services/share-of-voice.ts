// PER-PLATFORM share-of-voice growth: an entity's share of conversation
// WITHIN each platform, compared against its share in the preceding window,
// then combined across platforms.
//
// This corrects three separate confounds, all measured on real data
// (2026-08-09). Each one on its own is enough to make a client-facing growth
// number meaningless.
//
// 1. SCRAPE VOLUME. Actors are relevance-sorted and return recent posts
//    preferentially, so one sweep loads recent buckets far harder than old
//    ones. Signals per day by POST date: May 110, Jun 122, Jul 192, Aug 1,835.
//    A 15x jump in three months is our scraper, not the market — it reported
//    `queso` (cheese) at +312% MoM and `açaí` at +2122%.
//    FIX: divide by the period total, so only relative movement counts.
//
// 2. PLATFORM MIX. The old scrape was 98% TikTok / 1% X; the new sweep is
//    15% TikTok / 81% X in August. An entity that happens to live on X would
//    appear to explode purely because X went from 1% of our sample to 81%.
//    A single blended share-of-voice does NOT fix this, because it normalises
//    across platforms rather than within them.
//    FIX: compute share within each platform separately, so a mix shift
//    cancels — X's share is measured against X's own total.
//
// 3. THIN COUNTS. On a 30-day window the top of the ranking was a run of
//    identical values (237.7%, 162.7% repeated) driven by 1 -> 2 and 1 -> 3
//    mention jumps.
//    FIX: a minimum prior-window volume per platform, plus a requirement that
//    the move appears on more than one platform. A real trend shows up in more
//    than one place; a sampling artifact usually does not.
//
// WHAT THIS DOES NOT DO: it is not a genericness filter. Genericness resisted
// four separate data-driven approaches (entity type, co-occurrence breadth,
// query spread, blended share-of-voice) and appears not to be a property of
// the signal. Do not reach for this to solve that.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Minimum mentions on a platform in the PRIOR window for that platform to
// contribute. Chosen from the measured distribution of radar items by prior
// 60-day volume (>=1: 122 items, >=3: 88, >=5: 57, >=10: 40), not invented:
// 3 keeps most of the radar addressable while excluding the 1->2 jumps that
// produced the degenerate ranking.
const MIN_PRIOR_MENTIONS = Number(process.env.SOV_MIN_PRIOR ?? "3") || 3;
// Platforms that must independently qualify. 2 is the smallest number that
// can corroborate at all; requiring more would exclude most of the radar,
// since only 465 of 6,251 entities appeared on 2+ platforms before the mix fix.
const MIN_PLATFORMS = Number(process.env.SOV_MIN_PLATFORMS ?? "2") || 2;

export interface ShareOfVoice {
  /** Median of the per-platform share growths, as a percentage. */
  growthPct: number | null;
  /** Platforms that met MIN_PRIOR_MENTIONS and contributed. */
  platformsUsed: number;
  /** Per-platform growth, for audit — a verdict should be inspectable. */
  byPlatform: { platform: string; growthPct: number; priorMentions: number }[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// Pure, so the combination rule is unit-testable without a database.
export function combinePlatformGrowths(
  perPlatform: { platform: string; recentN: number; recentTotal: number; priorN: number; priorTotal: number }[],
  minPriorMentions = MIN_PRIOR_MENTIONS,
  minPlatforms = MIN_PLATFORMS
): ShareOfVoice {
  const qualifying: { platform: string; growthPct: number; priorMentions: number }[] = [];
  for (const p of perPlatform) {
    if (p.priorN < minPriorMentions) continue;
    if (p.priorTotal <= 0 || p.recentTotal <= 0) continue;
    const priorShare = p.priorN / p.priorTotal;
    const recentShare = p.recentN / p.recentTotal;
    if (priorShare <= 0) continue;
    qualifying.push({
      platform: p.platform,
      growthPct: (recentShare / priorShare - 1) * 100,
      priorMentions: p.priorN,
    });
  }
  if (qualifying.length < minPlatforms) {
    return { growthPct: null, platformsUsed: qualifying.length, byPlatform: qualifying };
  }
  return {
    // Median, not mean: one platform behaving oddly should not carry the
    // verdict, which is the same reason the rest of this engine uses rank
    // statistics rather than averages.
    growthPct: median(qualifying.map((q) => q.growthPct)),
    platformsUsed: qualifying.length,
    byPlatform: qualifying,
  };
}

/**
 * Per-platform share-of-voice growth for every entity of a company, comparing
 * the last `windowDays` against the `windowDays` before that.
 *
 * Windows are anchored to the company's LAST DAY OF DATA, not wall-clock now:
 * a company whose scrape is stale would otherwise have both windows land in an
 * empty present and report nothing.
 */
export async function fetchShareOfVoice(
  companyId: number,
  windowDays = Number(process.env.SOV_WINDOW_DAYS ?? "60") || 60
): Promise<Map<number, ShareOfVoice>> {
  const rows = (
    await db.execute(sql`
      with bounds as (
        select max(bucket_date) as last_day
        from tp_entity_timeseries where company_id = ${companyId}
      ),
      w as (
        select (select last_day from bounds) - (${windowDays})::int     as recent_start,
               (select last_day from bounds)                            as recent_end,
               (select last_day from bounds) - (${windowDays * 2})::int as prior_start,
               (select last_day from bounds) - (${windowDays})::int     as prior_end
      ),
      per_entity_platform as (
        select ts.entity_id, ts.platform,
               sum(ts.mentions) filter (
                 where ts.bucket_date > w.recent_start and ts.bucket_date <= w.recent_end
               ) as recent_n,
               sum(ts.mentions) filter (
                 where ts.bucket_date > w.prior_start and ts.bucket_date <= w.prior_end
               ) as prior_n
        from tp_entity_timeseries ts cross join w
        where ts.company_id = ${companyId}
        group by ts.entity_id, ts.platform
      ),
      -- Totals are PER PLATFORM: this is what cancels the mix shift.
      platform_totals as (
        select platform,
               coalesce(sum(recent_n), 0) as recent_total,
               coalesce(sum(prior_n), 0)  as prior_total
        from per_entity_platform group by platform
      )
      select p.entity_id, p.platform,
             coalesce(p.recent_n, 0) as recent_n,
             coalesce(p.prior_n, 0)  as prior_n,
             t.recent_total, t.prior_total
      from per_entity_platform p
      join platform_totals t on t.platform = p.platform
    `)
  ).rows as any[];

  const byEntity = new Map<
    number,
    { platform: string; recentN: number; recentTotal: number; priorN: number; priorTotal: number }[]
  >();
  for (const r of rows) {
    const id = Number(r.entity_id);
    const list = byEntity.get(id) ?? [];
    list.push({
      platform: String(r.platform),
      recentN: Number(r.recent_n),
      recentTotal: Number(r.recent_total),
      priorN: Number(r.prior_n),
      priorTotal: Number(r.prior_total),
    });
    byEntity.set(id, list);
  }

  const out = new Map<number, ShareOfVoice>();
  for (const [id, list] of byEntity) out.set(id, combinePlatformGrowths(list));
  return out;
}
