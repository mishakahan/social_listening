import { logger } from "../lib/logger.js";
import { withDbRetry } from "./db-retry.js";
import * as storage from "../storage/index.js";
import { db } from "@workspace/db";
import { tpRawSignals, tpSignalEntities, tpEntities } from "@workspace/db";
import { eq, and, gte, sql, isNull } from "drizzle-orm";
import type { InsertTpEntityTimeseries } from "@workspace/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400_000);
}

// Compute the median of an array of numbers
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

// ---------------------------------------------------------------------------
// Per-entity, per-day aggregation
// ---------------------------------------------------------------------------

interface SignalRow {
  entityId: number;
  platform: string;
  geography: string | null;
  bucketDate: string;
  authorHandle: string | null;
  engagementComposite: number;
  backfillDerived: boolean;
}

async function fetchSignalsForAggregation(
  companyId: number,
  since: Date
): Promise<SignalRow[]> {
  // Join raw_signals → signal_entities to get per-entity signal data
  const rows = await db
    .select({
      entityId: tpSignalEntities.entityId,
      platform: tpRawSignals.platform,
      geography: tpRawSignals.geography,
      postedAt: tpRawSignals.postedAt,
      capturedAt: tpRawSignals.capturedAt,
      authorHandle: tpRawSignals.authorHandle,
      engagementComposite: tpRawSignals.engagementComposite,
      backfillDerived: tpRawSignals.backfillDerived,
    })
    .from(tpRawSignals)
    .innerJoin(tpSignalEntities, eq(tpSignalEntities.rawSignalId, tpRawSignals.id))
    .innerJoin(tpEntities, eq(tpEntities.id, tpSignalEntities.entityId))
    .where(
      and(
        eq(tpRawSignals.companyId, companyId),
        gte(tpRawSignals.capturedAt, since),
        isNull(tpEntities.deletedAt)
      )
    );

  return rows.map((r) => ({
    entityId: r.entityId,
    platform: r.platform,
    geography: r.geography ?? "Global",
    bucketDate: toDateStr(r.postedAt ?? r.capturedAt),
    authorHandle: r.authorHandle,
    engagementComposite: r.engagementComposite ?? 0,
    backfillDerived: r.backfillDerived,
  }));
}

// ---------------------------------------------------------------------------
// Aggregate and upsert timeseries buckets
// ---------------------------------------------------------------------------

interface BucketKey {
  entityId: number;
  platform: string;
  geography: string;
  bucketDate: string;
}

interface BucketAccumulator {
  mentions: number;
  authors: Set<string>;
  engagements: number[];
  backfillDerived: boolean;
}

export async function runTimeseriesAggregation(
  companyId: number,
  windowDays = 90
): Promise<{ bucketsWritten: number; bucketsFailed: number }> {
  const since = daysAgo(windowDays);
  const signals = await fetchSignalsForAggregation(companyId, since);

  if (signals.length === 0) {
    logger.info({ companyId }, "No signals for timeseries aggregation");
    return { bucketsWritten: 0, bucketsFailed: 0 };
  }

  // Group by (entityId, platform, geography, bucketDate)
  const buckets = new Map<string, BucketAccumulator>();

  for (const s of signals) {
    const key = `${s.entityId}|${s.platform}|${s.geography}|${s.bucketDate}`;
    let acc = buckets.get(key);
    if (!acc) {
      acc = { mentions: 0, authors: new Set(), engagements: [], backfillDerived: s.backfillDerived };
      buckets.set(key, acc);
    }
    acc.mentions++;
    if (s.authorHandle) acc.authors.add(s.authorHandle);
    if (s.engagementComposite > 0) acc.engagements.push(s.engagementComposite);
  }

  // Get entity companyIds for the upsert
  const entityIds = [...new Set(signals.map((s) => s.entityId))];
  const entities = await storage.getEntities(companyId);
  const entityCompanyMap = new Map(entities.map((e) => [e.id, e.companyId]));

  let bucketsWritten = 0;
  let bucketsFailed = 0;

  for (const [key, acc] of buckets) {
    const [entityIdStr, platform, geography, bucketDate] = key.split("|");
    const entityId = Number(entityIdStr);
    const entityCompanyId = entityCompanyMap.get(entityId) ?? companyId;

    const data: InsertTpEntityTimeseries = {
      companyId: entityCompanyId,
      entityId,
      platform: platform!,
      geography: geography!,
      bucketDate: bucketDate!,
      mentions: acc.mentions,
      uniqueAuthors: acc.authors.size,
      engagementSum: acc.engagements.reduce((a, b) => a + b, 0),
      engagementMedian: median(acc.engagements),
      backfillDerived: acc.backfillDerived,
    };

    // Retry before giving up: a Neon connection drop mid-run used to lose the
    // bucket outright. A lost bucket is invisible downstream (the state machine
    // just sees a smaller series) so it must not pass quietly.
    try {
      await withDbRetry("upsertEntityTimeseries", () => storage.upsertEntityTimeseries(data));
      bucketsWritten++;
    } catch (err) {
      bucketsFailed++;
      logger.warn({ err, entityId, platform, geography, bucketDate }, "Failed to upsert timeseries bucket");
    }
  }

  if (bucketsFailed > 0) {
    logger.error(
      { companyId, bucketsWritten, bucketsFailed },
      "Timeseries aggregation INCOMPLETE — buckets lost after retries; verdicts computed on this data will be understated"
    );
  }
  logger.info({ companyId, bucketsWritten, bucketsFailed, signalCount: signals.length }, "Timeseries aggregation complete");
  return { bucketsWritten, bucketsFailed };
}
