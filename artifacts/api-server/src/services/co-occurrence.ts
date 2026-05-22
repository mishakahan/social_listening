import { db } from "@workspace/db";
import {
  tpEntityCoOccurrences,
  tpSignalEntities,
  tpRawSignals,
  tpEntities,
} from "@workspace/db";
import { and, eq, gte, isNull, lte, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import {
  getPipelineConfig,
  replaceCompositeTrendCandidates,
} from "../storage/index.js";

// ---------------------------------------------------------------------------
// Composite co-occurrence aggregator (Task #3).
//
// For each unordered entity pair (a < b) that co-mention in at least
// `compositeMinJointMentions` distinct signals inside the rolling window
// (default 14d), compute:
//
//   joint    = COUNT(DISTINCT raw_signal_id) from tp_entity_co_occurrences
//   count_a  = COUNT(DISTINCT raw_signal_id) where entity a was mentioned
//   count_b  = COUNT(DISTINCT raw_signal_id) where entity b was mentioned
//   N        = COUNT(DISTINCT raw_signal_id) for the company in the window
//   expected = (count_a * count_b) / N
//   lift     = joint / max(expected, epsilon)
//
// Surface pairs with lift >= compositeMinLift. Filter pairs where either
// entity is in the company's core vocabulary (case-insensitive bare match).
// Snapshot-replace tp_composite_trend_candidates in a single transaction.
// ---------------------------------------------------------------------------

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface CoOccurrenceRunStats {
  evaluated: number;
  qualified: number;
  filteredCoreVocab: number;
  totalSignals: number;
  windowStart: string;
  windowEnd: string;
}

export async function runCoOccurrenceAggregation(
  companyId: number
): Promise<CoOccurrenceRunStats> {
  const cfg = await getPipelineConfig(companyId);
  const minJoint = cfg?.compositeMinJointMentions ?? 5;
  const minLift = cfg?.compositeMinLift ?? 2.0;
  const windowDays = cfg?.compositeWindowDays ?? 14;
  const coreVocab = new Set(
    (cfg?.coreVocabulary ?? [])
      .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
      .filter(Boolean)
  );

  const now = new Date();
  const windowEndDate = now;
  const windowStartDate = new Date(now.getTime() - windowDays * 86400_000);
  // Prior baseline = the window of equal length immediately preceding the
  // current one. Required by the task spec so the UI can show
  // current-vs-prior joint counts alongside lift.
  const priorWindowEndDate = windowStartDate;
  const priorWindowStartDate = new Date(
    priorWindowEndDate.getTime() - windowDays * 86400_000
  );
  const windowStart = toDateStr(windowStartDate);
  const windowEnd = toDateStr(windowEndDate);

  // Snapshot-consistent read phase: wrap all four reads (N, pairRows,
  // per-entity counts, entity labels) in a single REPEATABLE READ transaction
  // so the numerators and denominators of every lift calculation come from
  // the same point-in-time view. Without this, concurrent ingestion between
  // statements can produce incoherent lift values.
  //
  // We capture the read results into outer variables so the rest of the
  // function (filtering, math, snapshot replace) runs outside the read tx.
  let totalSignals = 0;
  let pairRows: Array<{
    entityAId: number;
    entityBId: number;
    joint: number;
  }> = [];
  let entityCountRows: Array<{ entityId: number; cnt: number }> = [];
  let entityRows: Array<{
    id: number;
    label: string;
    deletedAt: Date | null;
  }> = [];
  // Prior-window joint count per pair. Pairs absent from the prior window
  // simply don't appear here (treated as 0 by the lookup).
  let priorPairRows: Array<{
    entityAId: number;
    entityBId: number;
    joint: number;
  }> = [];
  // Per-pair daily joint counts across the current window. Each row is one
  // (a, b, day) bucket; we re-shape into fixed-length arrays after the tx.
  let dailyRows: Array<{
    entityAId: number;
    entityBId: number;
    day: string;
    joint: number;
  }> = [];

  await db.transaction(async (tx) => {
    // Promote the read tx to REPEATABLE READ so the four reads below see a
    // single Postgres snapshot. Ingestion concurrent with the aggregator
    // can no longer split numerator/denominator across snapshots.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);

    const nRow = await tx
      .select({
        n: sql<number>`COUNT(DISTINCT ${tpRawSignals.id})::int`,
      })
      .from(tpRawSignals)
      .innerJoin(
        tpSignalEntities,
        eq(tpSignalEntities.rawSignalId, tpRawSignals.id)
      )
      .where(
        and(
          eq(tpRawSignals.companyId, companyId),
          gte(
            sql`COALESCE(${tpRawSignals.postedAt}, ${tpRawSignals.capturedAt})`,
            windowStartDate
          ),
          lte(
            sql`COALESCE(${tpRawSignals.postedAt}, ${tpRawSignals.capturedAt})`,
            windowEndDate
          )
        )
      );
    totalSignals = Number(nRow[0]?.n ?? 0) || 0;
    if (totalSignals === 0) return;

    pairRows = (await tx
      .select({
        entityAId: tpEntityCoOccurrences.entityAId,
        entityBId: tpEntityCoOccurrences.entityBId,
        joint: sql<number>`COUNT(DISTINCT ${tpEntityCoOccurrences.rawSignalId})::int`,
      })
      .from(tpEntityCoOccurrences)
      .where(
        and(
          eq(tpEntityCoOccurrences.companyId, companyId),
          gte(tpEntityCoOccurrences.postedAt, windowStartDate),
          lte(tpEntityCoOccurrences.postedAt, windowEndDate)
        )
      )
      .groupBy(
        tpEntityCoOccurrences.entityAId,
        tpEntityCoOccurrences.entityBId
      )
      .having(
        sql`COUNT(DISTINCT ${tpEntityCoOccurrences.rawSignalId}) >= ${minJoint}`
      )) as Array<{ entityAId: number; entityBId: number; joint: number }>;

    if (pairRows.length === 0) return;

    const candidateEntityIds = Array.from(
      new Set(pairRows.flatMap((r) => [r.entityAId, r.entityBId]))
    );
    entityCountRows = (await tx
      .select({
        entityId: tpSignalEntities.entityId,
        cnt: sql<number>`COUNT(DISTINCT ${tpSignalEntities.rawSignalId})::int`,
      })
      .from(tpSignalEntities)
      .innerJoin(
        tpRawSignals,
        eq(tpRawSignals.id, tpSignalEntities.rawSignalId)
      )
      .where(
        and(
          eq(tpRawSignals.companyId, companyId),
          inArray(tpSignalEntities.entityId, candidateEntityIds),
          gte(
            sql`COALESCE(${tpRawSignals.postedAt}, ${tpRawSignals.capturedAt})`,
            windowStartDate
          ),
          lte(
            sql`COALESCE(${tpRawSignals.postedAt}, ${tpRawSignals.capturedAt})`,
            windowEndDate
          )
        )
      )
      .groupBy(tpSignalEntities.entityId)) as Array<{
      entityId: number;
      cnt: number;
    }>;

    entityRows = (await tx
      .select({
        id: tpEntities.id,
        label: tpEntities.canonicalLabel,
        deletedAt: tpEntities.deletedAt,
      })
      .from(tpEntities)
      .where(inArray(tpEntities.id, candidateEntityIds))) as Array<{
      id: number;
      label: string;
      deletedAt: Date | null;
    }>;

    // Prior-window joint counts for the same candidate pairs. No HAVING
    // floor here — a pair that surfaces this window but had zero prior
    // mentions should still get priorJointCount=0 (lookup miss handles it).
    priorPairRows = (await tx
      .select({
        entityAId: tpEntityCoOccurrences.entityAId,
        entityBId: tpEntityCoOccurrences.entityBId,
        joint: sql<number>`COUNT(DISTINCT ${tpEntityCoOccurrences.rawSignalId})::int`,
      })
      .from(tpEntityCoOccurrences)
      .where(
        and(
          eq(tpEntityCoOccurrences.companyId, companyId),
          gte(tpEntityCoOccurrences.postedAt, priorWindowStartDate),
          lte(tpEntityCoOccurrences.postedAt, priorWindowEndDate)
        )
      )
      .groupBy(
        tpEntityCoOccurrences.entityAId,
        tpEntityCoOccurrences.entityBId
      )) as Array<{ entityAId: number; entityBId: number; joint: number }>;

    // Daily joint counts for sparkline. Bucket on date_trunc('day', posted_at)
    // and DISTINCT raw_signal_id so a post mentioning the pair multiple
    // times still counts as one for that day. We re-shape into a fixed-length
    // array (oldest → newest) below, indexed by day offset from windowStart.
    dailyRows = (await tx
      .select({
        entityAId: tpEntityCoOccurrences.entityAId,
        entityBId: tpEntityCoOccurrences.entityBId,
        day: sql<string>`to_char(date_trunc('day', ${tpEntityCoOccurrences.postedAt}), 'YYYY-MM-DD')`,
        joint: sql<number>`COUNT(DISTINCT ${tpEntityCoOccurrences.rawSignalId})::int`,
      })
      .from(tpEntityCoOccurrences)
      .where(
        and(
          eq(tpEntityCoOccurrences.companyId, companyId),
          gte(tpEntityCoOccurrences.postedAt, windowStartDate),
          lte(tpEntityCoOccurrences.postedAt, windowEndDate)
        )
      )
      .groupBy(
        tpEntityCoOccurrences.entityAId,
        tpEntityCoOccurrences.entityBId,
        sql`date_trunc('day', ${tpEntityCoOccurrences.postedAt})`
      )) as Array<{
      entityAId: number;
      entityBId: number;
      day: string;
      joint: number;
    }>;
  });

  if (totalSignals === 0) {
    await replaceCompositeTrendCandidates(companyId, [], now);
    logger.info(
      { companyId, totalSignals, windowStart, windowEnd },
      "Composite co-occurrence run: no signals in window"
    );
    return {
      evaluated: 0,
      qualified: 0,
      filteredCoreVocab: 0,
      totalSignals,
      windowStart,
      windowEnd,
    };
  }

  if (pairRows.length === 0) {
    await replaceCompositeTrendCandidates(companyId, [], now);
    logger.info(
      { companyId, totalSignals, windowStart, windowEnd },
      "Composite co-occurrence run: no pairs cleared joint floor"
    );
    return {
      evaluated: 0,
      qualified: 0,
      filteredCoreVocab: 0,
      totalSignals,
      windowStart,
      windowEnd,
    };
  }

  const countByEntity = new Map<number, number>();
  for (const r of entityCountRows) {
    countByEntity.set(Number(r.entityId), Number(r.cnt) || 0);
  }
  const labelByEntity = new Map<number, string>();
  const deletedEntity = new Set<number>();
  for (const r of entityRows) {
    labelByEntity.set(Number(r.id), r.label);
    if (r.deletedAt) deletedEntity.add(Number(r.id));
  }
  const priorByPair = new Map<string, number>();
  for (const r of priorPairRows) {
    priorByPair.set(
      `${Number(r.entityAId)}:${Number(r.entityBId)}`,
      Number(r.joint) || 0
    );
  }
  // Build a fixed-length sparkline (length = windowDays) per pair, indexed
  // by day-offset from windowStartDate. Missing days are 0.
  const sparkByPair = new Map<string, number[]>();
  const startMs = Date.UTC(
    windowStartDate.getUTCFullYear(),
    windowStartDate.getUTCMonth(),
    windowStartDate.getUTCDate()
  );
  for (const r of dailyRows) {
    const key = `${Number(r.entityAId)}:${Number(r.entityBId)}`;
    let arr = sparkByPair.get(key);
    if (!arr) {
      arr = new Array<number>(windowDays).fill(0);
      sparkByPair.set(key, arr);
    }
    const dayMs = Date.parse(`${r.day}T00:00:00Z`);
    if (!Number.isFinite(dayMs)) continue;
    const offset = Math.floor((dayMs - startMs) / 86400_000);
    if (offset >= 0 && offset < windowDays) {
      arr[offset] = Number(r.joint) || 0;
    }
  }

  const computedAt = new Date();
  let filteredCoreVocab = 0;
  const qualifying: Array<{
    entityAId: number;
    entityBId: number;
    windowStart: string;
    windowEnd: string;
    jointCount: number;
    priorJointCount: number;
    countA: number;
    countB: number;
    totalSignals: number;
    expectedCount: number;
    lift: number;
    sparkline: number[];
  }> = [];

  for (const p of pairRows) {
    const a = Number(p.entityAId);
    const b = Number(p.entityBId);
    if (deletedEntity.has(a) || deletedEntity.has(b)) continue;

    const labelA = (labelByEntity.get(a) ?? "").trim().toLowerCase();
    const labelB = (labelByEntity.get(b) ?? "").trim().toLowerCase();
    if (coreVocab.has(labelA) || coreVocab.has(labelB)) {
      filteredCoreVocab++;
      continue;
    }

    const joint = Number(p.joint) || 0;
    const countA = countByEntity.get(a) ?? 0;
    const countB = countByEntity.get(b) ?? 0;
    // Defensive: an entity with zero signals in the window shouldn't appear
    // in any pair, but guard against the divide-by-zero anyway.
    if (countA === 0 || countB === 0) continue;

    const expected = (countA * countB) / totalSignals;
    if (expected <= 0) continue;
    const lift = joint / expected;
    if (lift < minLift) continue;

    const pairKey = `${a}:${b}`;
    qualifying.push({
      entityAId: a,
      entityBId: b,
      windowStart,
      windowEnd,
      jointCount: joint,
      priorJointCount: priorByPair.get(pairKey) ?? 0,
      countA,
      countB,
      totalSignals,
      expectedCount: expected,
      lift,
      sparkline:
        sparkByPair.get(pairKey) ?? new Array<number>(windowDays).fill(0),
    });
  }

  // Sort by lift desc, then joint count desc — same order the UI uses.
  qualifying.sort((x, y) => y.lift - x.lift || y.jointCount - x.jointCount);

  await replaceCompositeTrendCandidates(companyId, qualifying, computedAt);

  const stats: CoOccurrenceRunStats = {
    evaluated: pairRows.length,
    qualified: qualifying.length,
    filteredCoreVocab,
    totalSignals,
    windowStart,
    windowEnd,
  };
  logger.info({ companyId, ...stats }, "Composite co-occurrence run complete");
  return stats;
}

// Suppress unused-import warning — `isNull` is kept for parity with other
// services that may extend this module to filter on entity.deletedAt at the
// SQL layer; today the filtering happens in JS for clarity.
void isNull;
