// Signal strength: how well-evidenced a trend is, as a percentile within its
// own company's radar.
//
// WHY THIS EXISTS. The score stored on knowledge_items by the state machine is
//   (volume7d / 10) * 30 + max(0, growthWow) * 40 + max(0, growthMom) * 30
// capped at 100 — absolute thresholds calibrated when this engine had
// single-digit volumes and growth ratios under 1.0. After the 2026-08-09
// sweep, 34 mentions in 7 days saturates the cap on volume alone before growth
// is added, and a growth ratio of 3.4 contributes 102 by itself. Measured
// result: 111 of 135 radar items pinned at exactly 100. A score that is
// constant for 82% of the list is not a score.
//
// A percentile cannot saturate, and it recalibrates itself whenever scrape
// volume changes — which is the root cause of the original failure, not a
// symptom of it.
//
// It ranks EVIDENCE ONLY (how many mentions, spread over how many platforms)
// and deliberately excludes growth. Growth has its own column now, and
// conflating "how sure are we" with "which way is it going" is what made the
// old score unreadable.
//
// THIS MODULE IS THE SINGLE SOURCE OF TRUTH. The score was previously computed
// in four separate places in storage/index.ts, and fixing only the list view
// left the trend detail page still showing 100 for everything — the same
// number, contradicting itself one click apart.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Raw evidence weight for one entity: mentions carried across platforms.
 * Pure, so the weighting is testable without a database.
 */
export function evidenceScore(evidenceCount: number, platformCount: number): number {
  return Math.max(0, evidenceCount) * Math.max(1, platformCount);
}

/**
 * Percentile of `value` within an ascending-sorted population, 0-100.
 * Exported for tests: the boundary behaviour (lowest scores 0, highest near
 * 100) is the part most likely to be got wrong silently.
 */
export function percentileIn(sortedAsc: number[], value: number): number {
  if (sortedAsc.length === 0) return 0;
  let below = 0;
  while (below < sortedAsc.length && sortedAsc[below]! < value) below++;
  return Math.round((below / sortedAsc.length) * 100);
}

/**
 * Signal percentile for every entity currently on a company's radar.
 *
 * The population is the radar itself, so a percentile means "better evidenced
 * than X% of what is on this radar". Computing it over all ~17k entities
 * instead would push every surfaced item into the high 90s and flatten the
 * scale in the opposite direction.
 */
export async function fetchSignalPercentiles(
  companyId: number
): Promise<Map<number, number>> {
  const rows = (
    await db.execute(sql`
      select es.entity_id,
             coalesce(ki.evidence_count, 0)                     as evidence_count,
             -- platforms_seen is jsonb, not a Postgres array
             greatest(jsonb_array_length(coalesce(es.platforms_seen, '[]'::jsonb)), 1) as platform_count
      from tp_entity_state es
      join knowledge_items ki on ki.id = es.knowledge_item_id
      join tp_entities e on e.id = es.entity_id
      where es.company_id = ${companyId}
        and es.knowledge_item_id is not null
        and e.deleted_at is null
        and ki.archived = false
    `)
  ).rows as any[];

  const scores = rows.map((r) =>
    evidenceScore(Number(r.evidence_count), Number(r.platform_count))
  );
  const sorted = [...scores].sort((a, b) => a - b);

  const out = new Map<number, number>();
  rows.forEach((r, i) => {
    out.set(Number(r.entity_id), percentileIn(sorted, scores[i]!));
  });
  return out;
}
