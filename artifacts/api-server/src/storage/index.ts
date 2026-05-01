import { db } from "@workspace/db";
import {
  companies,
  users,
  knowledgeItems,
  knowledgeEvidence,
  tpSeedCandidates,
  tpSeedItems,
  tpScoutQueries,
  tpActorRuns,
  tpRawSignals,
  tpEntities,
  tpSignalEntities,
  tpEntityTimeseries,
  tpEntityState,
  tpEntitySynonyms,
  tpKeywordInterest,
  tpPipelineConfig,
  type Company,
  type InsertCompany,
  type TpSeedCandidate,
  type InsertTpSeedCandidate,
  type TpSeedItem,
  type InsertTpSeedItem,
  type TpScoutQuery,
  type InsertTpScoutQuery,
  type TpActorRun,
  type InsertTpActorRun,
  type TpRawSignal,
  type InsertTpRawSignal,
  type TpEntity,
  type InsertTpEntity,
  type TpEntitySynonym,
  type InsertTpEntitySynonym,
  type TpSignalEntity,
  type InsertTpSignalEntity,
  type TpEntityTimeseries,
  type InsertTpEntityTimeseries,
  type TpEntityState,
  type InsertTpEntityState,
  type TpKeywordInterest,
  type InsertTpKeywordInterest,
  type TpPipelineConfig,
  type KnowledgeItem,
  type InsertKnowledgeItem,
  type KnowledgeEvidence,
  type InsertKnowledgeEvidence,
} from "@workspace/db";
import {
  eq,
  and,
  inArray,
  desc,
  asc,
  or,
  isNull,
  not,
  sql,
  count,
  sum,
  gte,
  lte,
  lt,
} from "drizzle-orm";

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export async function getAllCompanies(): Promise<Company[]> {
  return db.select().from(companies);
}

export async function getOrCreateDefaultCompany(): Promise<Company> {
  const existing = await db
    .select()
    .from(companies)
    .where(eq(companies.id, 1))
    .limit(1);
  if (existing.length > 0) {
    return existing[0]!;
  }
  const inserted = await db
    .insert(companies)
    .values({ name: "Default Company" })
    .returning();
  return inserted[0]!;
}

export async function getOrCreateDefaultUserId(): Promise<number> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, 1))
    .limit(1);
  if (existing.length > 0) {
    return existing[0]!.id;
  }
  const inserted = await db
    .insert(users)
    .values({
      email: "default@trendpipeline.local",
      name: "Default User",
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  if (inserted[0]) {
    return inserted[0].id;
  }
  const fallback = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "default@trendpipeline.local"))
    .limit(1);
  return fallback[0]!.id;
}

export async function getCompany(id: number): Promise<Company | undefined> {
  const rows = await db
    .select()
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  return rows[0];
}

export async function createCompany(name: string): Promise<Company> {
  const rows = await db.insert(companies).values({ name }).returning();
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// Pipeline Config
// ---------------------------------------------------------------------------

export async function getPipelineConfig(
  companyId: number
): Promise<TpPipelineConfig> {
  const rows = await db
    .select()
    .from(tpPipelineConfig)
    .where(eq(tpPipelineConfig.companyId, companyId))
    .limit(1);
  if (rows.length > 0) {
    return rows[0]!;
  }
  // Insert defaults
  const inserted = await db
    .insert(tpPipelineConfig)
    .values({ companyId })
    .returning();
  return inserted[0]!;
}

export async function updatePipelineConfig(
  companyId: number,
  data: Partial<Omit<TpPipelineConfig, "companyId">>
): Promise<TpPipelineConfig> {
  // Ensure config exists first
  await getPipelineConfig(companyId);
  const rows = await db
    .update(tpPipelineConfig)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(tpPipelineConfig.companyId, companyId))
    .returning();
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// Seed Candidates
// ---------------------------------------------------------------------------

export async function createSeedCandidates(
  data: InsertTpSeedCandidate
): Promise<TpSeedCandidate> {
  const rows = await db.insert(tpSeedCandidates).values(data).returning();
  return rows[0]!;
}

export async function getLatestSeedCandidates(
  companyId: number
): Promise<TpSeedCandidate | undefined> {
  const rows = await db
    .select()
    .from(tpSeedCandidates)
    .where(eq(tpSeedCandidates.companyId, companyId))
    .orderBy(desc(tpSeedCandidates.createdAt))
    .limit(1);
  return rows[0];
}

export async function updateSeedCandidates(
  id: number,
  data: Partial<TpSeedCandidate>
): Promise<TpSeedCandidate> {
  const rows = await db
    .update(tpSeedCandidates)
    .set(data)
    .where(eq(tpSeedCandidates.id, id))
    .returning();
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// Seed Items
// ---------------------------------------------------------------------------

export async function createSeedItem(
  data: InsertTpSeedItem
): Promise<TpSeedItem> {
  const rows = await db
    .insert(tpSeedItems)
    .values(data as any)
    .returning();
  return rows[0]!;
}

export async function getSeedItems(companyId: number): Promise<TpSeedItem[]> {
  return db
    .select()
    .from(tpSeedItems)
    .where(eq(tpSeedItems.companyId, companyId))
    .orderBy(asc(tpSeedItems.createdAt));
}

export async function getSeedItem(id: number): Promise<TpSeedItem | undefined> {
  const rows = await db
    .select()
    .from(tpSeedItems)
    .where(eq(tpSeedItems.id, id))
    .limit(1);
  return rows[0];
}

export async function updateSeedItem(
  id: number,
  data: Partial<TpSeedItem>
): Promise<TpSeedItem> {
  const rows = await db
    .update(tpSeedItems)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(tpSeedItems.id, id))
    .returning();
  return rows[0]!;
}

export async function deleteSeedItem(id: number): Promise<void> {
  await db.delete(tpSeedItems).where(eq(tpSeedItems.id, id));
}

// ---------------------------------------------------------------------------
// Scout Queries
// ---------------------------------------------------------------------------

export async function createScoutQuery(
  data: InsertTpScoutQuery
): Promise<TpScoutQuery> {
  const rows = await db.insert(tpScoutQueries).values(data).returning();
  return rows[0]!;
}

export async function getScoutQueries(
  companyId: number,
  filters?: {
    geography?: string;
    language?: string;
    active?: boolean;
    seedItemId?: number;
  }
): Promise<TpScoutQuery[]> {
  const conditions = [eq(tpScoutQueries.companyId, companyId)];
  if (filters?.geography) {
    conditions.push(eq(tpScoutQueries.geography, filters.geography));
  }
  if (filters?.language) {
    conditions.push(eq(tpScoutQueries.language, filters.language));
  }
  if (filters?.active !== undefined) {
    conditions.push(eq(tpScoutQueries.active, filters.active));
  }
  if (filters?.seedItemId !== undefined) {
    conditions.push(eq(tpScoutQueries.seedItemId, filters.seedItemId));
  }
  return db
    .select()
    .from(tpScoutQueries)
    .where(and(...conditions))
    .orderBy(asc(tpScoutQueries.createdAt));
}

export async function getScoutQuery(
  id: number
): Promise<TpScoutQuery | undefined> {
  const rows = await db
    .select()
    .from(tpScoutQueries)
    .where(eq(tpScoutQueries.id, id))
    .limit(1);
  return rows[0];
}

export async function updateScoutQuery(
  id: number,
  data: Partial<TpScoutQuery>
): Promise<TpScoutQuery> {
  const rows = await db
    .update(tpScoutQueries)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(tpScoutQueries.id, id))
    .returning();
  return rows[0]!;
}

export async function incrementScoutQueryCounters(
  id: number,
  delta: { fetched: number; usable: number }
): Promise<void> {
  await db
    .update(tpScoutQueries)
    .set({
      totalSignalsFetched: sql`${tpScoutQueries.totalSignalsFetched} + ${delta.fetched}`,
      totalSignalsUsable: sql`${tpScoutQueries.totalSignalsUsable} + ${delta.usable}`,
      updatedAt: new Date(),
    })
    .where(eq(tpScoutQueries.id, id));
}

export async function deleteScoutQuery(id: number): Promise<void> {
  await db.delete(tpScoutQueries).where(eq(tpScoutQueries.id, id));
}

export async function deleteScoutQueries(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(tpScoutQueries).where(inArray(tpScoutQueries.id, ids));
}

// ---------------------------------------------------------------------------
// Actor Runs
// ---------------------------------------------------------------------------

export async function createActorRun(
  data: InsertTpActorRun
): Promise<TpActorRun> {
  const rows = await db.insert(tpActorRuns).values(data).returning();
  return rows[0]!;
}

export async function getActorRun(
  id: number
): Promise<TpActorRun | undefined> {
  const rows = await db
    .select()
    .from(tpActorRuns)
    .where(eq(tpActorRuns.id, id))
    .limit(1);
  return rows[0];
}

export async function getActorRunByApifyRunId(
  apifyRunId: string
): Promise<TpActorRun | undefined> {
  const rows = await db
    .select()
    .from(tpActorRuns)
    .where(eq(tpActorRuns.apifyRunId, apifyRunId))
    .limit(1);
  return rows[0];
}

export async function getActorRuns(
  companyId: number,
  filters?: { platform?: string; status?: string; scoutQueryId?: number }
): Promise<TpActorRun[]> {
  const conditions = [eq(tpActorRuns.companyId, companyId)];
  if (filters?.platform) {
    conditions.push(eq(tpActorRuns.platform, filters.platform));
  }
  if (filters?.status) {
    conditions.push(eq(tpActorRuns.status, filters.status));
  }
  if (filters?.scoutQueryId !== undefined) {
    conditions.push(eq(tpActorRuns.scoutQueryId, filters.scoutQueryId));
  }
  return db
    .select()
    .from(tpActorRuns)
    .where(and(...conditions))
    .orderBy(desc(tpActorRuns.createdAt));
}

export async function updateActorRun(
  id: number,
  data: Partial<TpActorRun>
): Promise<TpActorRun> {
  const rows = await db
    .update(tpActorRuns)
    .set(data)
    .where(eq(tpActorRuns.id, id))
    .returning();
  return rows[0]!;
}

export async function deleteActorRuns(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(tpActorRuns).where(inArray(tpActorRuns.id, ids));
}

export async function getActorRunSummary(
  companyId: number,
  windowHours?: number
): Promise<{
  totalRuns: number;
  totalRecords: number;
  totalUsable: number;
  totalCostUsd: number;
  runningCount: number;
  failedCount: number;
}> {
  const conditions = [eq(tpActorRuns.companyId, companyId)];
  if (windowHours !== undefined) {
    const since = new Date(Date.now() - windowHours * 3600 * 1000);
    conditions.push(sql`${tpActorRuns.createdAt} >= ${since}`);
  }
  const rows = await db
    .select({
      totalRuns: count(),
      totalRecords: sum(tpActorRuns.recordsFetched),
      totalUsable: sum(tpActorRuns.recordsUsable),
      totalCostUsd: sum(tpActorRuns.costUsd),
    })
    .from(tpActorRuns)
    .where(and(...conditions));

  const runningRows = await db
    .select({ cnt: count() })
    .from(tpActorRuns)
    .where(and(...conditions, eq(tpActorRuns.status, "running")));

  const failedRows = await db
    .select({ cnt: count() })
    .from(tpActorRuns)
    .where(and(...conditions, eq(tpActorRuns.status, "failed")));

  const r = rows[0]!;
  return {
    totalRuns: Number(r.totalRuns ?? 0),
    totalRecords: Number(r.totalRecords ?? 0),
    totalUsable: Number(r.totalUsable ?? 0),
    totalCostUsd: Number(r.totalCostUsd ?? 0),
    runningCount: Number(runningRows[0]?.cnt ?? 0),
    failedCount: Number(failedRows[0]?.cnt ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Raw Signals
// ---------------------------------------------------------------------------

export async function createRawSignal(
  data: InsertTpRawSignal
): Promise<TpRawSignal> {
  const rows = await db.insert(tpRawSignals).values(data).returning();
  return rows[0]!;
}

export async function getRawSignals(
  actorRunId: number,
  limit?: number
): Promise<TpRawSignal[]> {
  const q = db
    .select()
    .from(tpRawSignals)
    .where(eq(tpRawSignals.actorRunId, actorRunId))
    .orderBy(desc(tpRawSignals.createdAt));
  if (limit !== undefined) {
    return q.limit(limit);
  }
  return q;
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as Record<string, unknown>).code === "23505"
  );
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export async function upsertEntity(
  companyId: number,
  canonicalLabel: string,
  entityType: string,
  alias?: string
): Promise<TpEntity> {
  // Try to find existing entity
  const existing = await db
    .select()
    .from(tpEntities)
    .where(
      and(
        eq(tpEntities.companyId, companyId),
        eq(tpEntities.canonicalLabel, canonicalLabel),
        eq(tpEntities.entityType, entityType)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const entity = existing[0]!;
    // If alias provided and not already in aliases array, add it
    if (alias && !entity.aliases.includes(alias)) {
      const updatedRows = await db
        .update(tpEntities)
        .set({
          aliases: sql`${tpEntities.aliases} || ${JSON.stringify([alias])}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(tpEntities.id, entity.id))
        .returning();
      return updatedRows[0]!;
    }
    return entity;
  }

  // Insert new entity
  const aliases = alias ? [alias] : [];
  const rows = await db
    .insert(tpEntities)
    .values({ companyId, canonicalLabel, entityType, aliases })
    .returning();
  return rows[0]!;
}

export async function getEntitySynonyms(
  companyId: number,
  filters?: { language?: string; entityType?: string }
): Promise<TpEntitySynonym[]> {
  const conditions = [eq(tpEntitySynonyms.companyId, companyId)];
  if (filters?.language) {
    conditions.push(eq(tpEntitySynonyms.language, filters.language));
  }
  if (filters?.entityType) {
    conditions.push(eq(tpEntitySynonyms.entityType, filters.entityType));
  }
  return db
    .select()
    .from(tpEntitySynonyms)
    .where(and(...conditions))
    .orderBy(asc(tpEntitySynonyms.createdAt));
}

export async function createEntitySynonym(
  data: InsertTpEntitySynonym
): Promise<TpEntitySynonym> {
  const rows = await db.insert(tpEntitySynonyms).values(data).returning();
  return rows[0]!;
}

export async function deleteEntitySynonym(id: number): Promise<void> {
  await db.delete(tpEntitySynonyms).where(eq(tpEntitySynonyms.id, id));
}

export async function resolveSynonym(
  companyId: number,
  alias: string,
  entityType: string
): Promise<string> {
  const rows = await db
    .select()
    .from(tpEntitySynonyms)
    .where(
      and(
        eq(tpEntitySynonyms.companyId, companyId),
        eq(tpEntitySynonyms.alias, alias),
        eq(tpEntitySynonyms.entityType, entityType)
      )
    )
    .limit(1);
  if (rows.length > 0) {
    return rows[0]!.canonicalLabel;
  }
  return alias;
}

// ---------------------------------------------------------------------------
// Knowledge Items
// ---------------------------------------------------------------------------

export async function upsertKnowledgeItem(
  data: InsertKnowledgeItem & { topicLabel: string; geographicScope: string }
): Promise<KnowledgeItem> {
  const { topicLabel, geographicScope, companyId } = data;

  // Check existing
  const existing = await db
    .select()
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.companyId, companyId),
        eq(knowledgeItems.topicLabel, topicLabel),
        eq(knowledgeItems.geographicScope, geographicScope)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const updated = await db
      .update(knowledgeItems)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(knowledgeItems.id, existing[0]!.id))
      .returning();
    return updated[0]!;
  }

  const inserted = await db
    .insert(knowledgeItems)
    .values(data)
    .returning();
  return inserted[0]!;
}

export async function getKnowledgeItems(
  companyId: number,
  filters?: { type?: string; state?: string; archived?: boolean }
): Promise<KnowledgeItem[]> {
  const conditions = [eq(knowledgeItems.companyId, companyId)];
  if (filters?.type) {
    conditions.push(eq(knowledgeItems.type, filters.type));
  }
  if (filters?.archived !== undefined) {
    conditions.push(eq(knowledgeItems.archived, filters.archived));
  }
  return db
    .select()
    .from(knowledgeItems)
    .where(and(...conditions))
    .orderBy(desc(knowledgeItems.createdAt));
}

export async function updateKnowledgeItem(
  id: number,
  data: Partial<KnowledgeItem>
): Promise<KnowledgeItem> {
  const rows = await db
    .update(knowledgeItems)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(knowledgeItems.id, id))
    .returning();
  return rows[0]!;
}

export async function createKnowledgeEvidence(
  data: InsertKnowledgeEvidence
): Promise<KnowledgeEvidence> {
  const rows = await db.insert(knowledgeEvidence).values(data).returning();
  return rows[0]!;
}

export async function getKnowledgeEvidence(
  knowledgeItemId: number,
  limit?: number
): Promise<KnowledgeEvidence[]> {
  const q = db
    .select()
    .from(knowledgeEvidence)
    .where(eq(knowledgeEvidence.knowledgeItemId, knowledgeItemId))
    .orderBy(desc(knowledgeEvidence.createdAt));
  if (limit !== undefined) {
    return q.limit(limit);
  }
  return q;
}

// ---------------------------------------------------------------------------
// Ingestion mutex
// ---------------------------------------------------------------------------

// Atomically claim a run for ingestion. Returns true if this caller won the
// race (ingestionStatus was 'pending' → 'processing'). Returns false if
// another worker already claimed it.
export async function claimIngestion(runId: number): Promise<boolean> {
  const rows = await db
    .update(tpActorRuns)
    .set({ ingestionStatus: "processing" } as any)
    .where(
      and(eq(tpActorRuns.id, runId), eq(tpActorRuns.ingestionStatus as any, "pending"))
    )
    .returning({ id: tpActorRuns.id });
  return rows.length > 0;
}

export async function markIngestionDone(
  runId: number,
  stats: {
    usable: number;
    dropped: number;
    oldestPostedAt?: Date | null;
    newestPostedAt?: Date | null;
  }
): Promise<void> {
  await db
    .update(tpActorRuns)
    .set({
      ingestionStatus: "done",
      recordsUsable: stats.usable,
      recordsDropped: stats.dropped,
      oldestPostedAt: stats.oldestPostedAt ?? undefined,
      newestPostedAt: stats.newestPostedAt ?? undefined,
    } as any)
    .where(eq(tpActorRuns.id, runId));
}

export async function markIngestionFailed(
  runId: number,
  error: string
): Promise<void> {
  await db
    .update(tpActorRuns)
    .set({ ingestionStatus: "failed", errorMessage: error } as any)
    .where(eq(tpActorRuns.id, runId));
}

// ---------------------------------------------------------------------------
// Raw Signals — bulk operations
// ---------------------------------------------------------------------------

export async function bulkInsertRawSignals(
  signals: InsertTpRawSignal[]
): Promise<{ inserted: number }> {
  if (signals.length === 0) return { inserted: 0 };
  const rows = await db
    .insert(tpRawSignals)
    .values(signals)
    .onConflictDoNothing()
    .returning({ id: tpRawSignals.id });
  return { inserted: rows.length };
}

// ---------------------------------------------------------------------------
// Keyword interest (Google Trends) — narrow time series, separate from
// tp_raw_signals. Idempotent on (companyId, keyword, geo, bucketDate).
// ---------------------------------------------------------------------------

export async function bulkUpsertKeywordInterest(
  rows: InsertTpKeywordInterest[]
): Promise<{ upserted: number }> {
  if (rows.length === 0) return { upserted: 0 };
  const inserted = await db
    .insert(tpKeywordInterest)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        tpKeywordInterest.companyId,
        tpKeywordInterest.keyword,
        tpKeywordInterest.geo,
        tpKeywordInterest.bucketDate,
      ],
      set: {
        interestValue: sql`excluded.interest_value`,
        actorRunId: sql`excluded.actor_run_id`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    })
    .returning({ id: tpKeywordInterest.id });
  return { upserted: inserted.length };
}

export async function getKeywordInterestSeries(
  companyId: number,
  keywords: string[],
  windowDays = 90
): Promise<TpKeywordInterest[]> {
  if (keywords.length === 0) return [];
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const sinceDate = since.toISOString().slice(0, 10);
  // Keywords from Apify are case-preserved but Google Trends usually lowercases.
  // Match case-insensitively to be safe.
  const lowered = keywords.map((k) => k.toLowerCase());
  return db
    .select()
    .from(tpKeywordInterest)
    .where(
      and(
        eq(tpKeywordInterest.companyId, companyId),
        gte(tpKeywordInterest.bucketDate, sinceDate),
        inArray(sql`lower(${tpKeywordInterest.keyword})`, lowered)
      )
    )
    .orderBy(asc(tpKeywordInterest.bucketDate));
}

export async function getRawSignalsByCompany(
  companyId: number,
  filters?: {
    actorRunId?: number;
    platform?: string;
    entityExtractionStatus?: string;
    limit?: number;
    offset?: number;
  }
): Promise<TpRawSignal[]> {
  const conditions = [eq(tpRawSignals.companyId, companyId)];
  if (filters?.actorRunId !== undefined) {
    conditions.push(eq(tpRawSignals.actorRunId, filters.actorRunId));
  }
  if (filters?.platform) {
    conditions.push(eq(tpRawSignals.platform, filters.platform));
  }
  if (filters?.entityExtractionStatus) {
    conditions.push(eq(tpRawSignals.entityExtractionStatus, filters.entityExtractionStatus));
  }
  const q = db
    .select()
    .from(tpRawSignals)
    .where(and(...conditions))
    .orderBy(desc(tpRawSignals.capturedAt))
    .limit(filters?.limit ?? 100)
    .offset(filters?.offset ?? 0);
  return q;
}

export async function getRawSignalCount(
  companyId: number,
  filters?: { actorRunId?: number; platform?: string; entityExtractionStatus?: string }
): Promise<number> {
  const conditions = [eq(tpRawSignals.companyId, companyId)];
  if (filters?.actorRunId !== undefined) {
    conditions.push(eq(tpRawSignals.actorRunId, filters.actorRunId));
  }
  if (filters?.platform) {
    conditions.push(eq(tpRawSignals.platform, filters.platform));
  }
  if (filters?.entityExtractionStatus) {
    conditions.push(eq(tpRawSignals.entityExtractionStatus, filters.entityExtractionStatus));
  }
  const rows = await db
    .select({ cnt: count() })
    .from(tpRawSignals)
    .where(and(...conditions));
  return Number(rows[0]?.cnt ?? 0);
}

export async function deleteRawSignals(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .delete(tpRawSignals)
    .where(inArray(tpRawSignals.id, ids))
    .returning({ id: tpRawSignals.id });
  return rows.length;
}

export async function getUnextractedSignals(
  companyId: number,
  limit: number,
  actorRunId?: number
): Promise<TpRawSignal[]> {
  const conditions = [
    eq(tpRawSignals.companyId, companyId),
    eq(tpRawSignals.entityExtractionStatus, "pending"),
  ];
  if (actorRunId !== undefined) {
    conditions.push(eq(tpRawSignals.actorRunId, actorRunId));
  }
  return db
    .select()
    .from(tpRawSignals)
    .where(and(...conditions))
    .orderBy(asc(tpRawSignals.capturedAt))
    .limit(limit);
}

export async function markSignalsExtracted(signalIds: number[]): Promise<void> {
  if (signalIds.length === 0) return;
  await db
    .update(tpRawSignals)
    .set({ entityExtractionStatus: "done", entityExtractionAt: new Date() })
    .where(inArray(tpRawSignals.id, signalIds));
}

export async function markSignalsExtractionFailed(signalIds: number[]): Promise<void> {
  if (signalIds.length === 0) return;
  await db
    .update(tpRawSignals)
    .set({ entityExtractionStatus: "failed" })
    .where(inArray(tpRawSignals.id, signalIds));
}

// ---------------------------------------------------------------------------
// Signal Entities
// ---------------------------------------------------------------------------

export async function bulkInsertSignalEntities(
  data: InsertTpSignalEntity[]
): Promise<void> {
  if (data.length === 0) return;
  await db.insert(tpSignalEntities).values(data).onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Entities — extended operations
// ---------------------------------------------------------------------------

export async function getEntities(
  companyId: number,
  filters?: { entityType?: string; deletedAt?: "null" | "any" }
): Promise<TpEntity[]> {
  const conditions = [eq(tpEntities.companyId, companyId)];
  if (filters?.entityType) {
    conditions.push(eq(tpEntities.entityType, filters.entityType));
  }
  if (!filters?.deletedAt || filters.deletedAt === "null") {
    conditions.push(isNull(tpEntities.deletedAt));
  }
  return db
    .select()
    .from(tpEntities)
    .where(and(...conditions))
    .orderBy(desc(tpEntities.totalMentions));
}

export async function updateEntityMentionStats(
  entityId: number,
  delta: { mentions: number; firstSeenAt?: Date; lastSeenAt?: Date }
): Promise<void> {
  await db
    .update(tpEntities)
    .set({
      totalMentions: sql`${tpEntities.totalMentions} + ${delta.mentions}`,
      ...(delta.firstSeenAt
        ? { firstSeenAt: sql`LEAST(COALESCE(${tpEntities.firstSeenAt}, ${delta.firstSeenAt}), ${delta.firstSeenAt})` }
        : {}),
      ...(delta.lastSeenAt
        ? { lastSeenAt: sql`GREATEST(COALESCE(${tpEntities.lastSeenAt}, ${delta.lastSeenAt}), ${delta.lastSeenAt})` }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(tpEntities.id, entityId));
}

// ---------------------------------------------------------------------------
// Entity Timeseries
// ---------------------------------------------------------------------------

export async function upsertEntityTimeseries(
  data: InsertTpEntityTimeseries
): Promise<TpEntityTimeseries> {
  const rows = await db
    .insert(tpEntityTimeseries)
    .values(data)
    .onConflictDoUpdate({
      target: [
        tpEntityTimeseries.entityId,
        tpEntityTimeseries.platform,
        tpEntityTimeseries.geography,
        tpEntityTimeseries.bucketDate,
      ],
      set: {
        mentions: data.mentions,
        uniqueAuthors: data.uniqueAuthors,
        engagementSum: data.engagementSum,
        engagementMedian: data.engagementMedian,
        computedAt: new Date(),
      },
    })
    .returning();
  return rows[0]!;
}

export async function getEntityTimeseries(
  entityId: number,
  windowDays: number
): Promise<TpEntityTimeseries[]> {
  const since = new Date(Date.now() - windowDays * 86400 * 1000);
  const sinceDate = since.toISOString().slice(0, 10);
  return db
    .select()
    .from(tpEntityTimeseries)
    .where(
      and(
        eq(tpEntityTimeseries.entityId, entityId),
        gte(tpEntityTimeseries.bucketDate, sinceDate)
      )
    )
    .orderBy(asc(tpEntityTimeseries.bucketDate));
}

export async function getEntityTimeseriesByCompany(
  companyId: number,
  windowDays: number
): Promise<TpEntityTimeseries[]> {
  const since = new Date(Date.now() - windowDays * 86400 * 1000);
  const sinceDate = since.toISOString().slice(0, 10);
  return db
    .select()
    .from(tpEntityTimeseries)
    .where(
      and(
        eq(tpEntityTimeseries.companyId, companyId),
        gte(tpEntityTimeseries.bucketDate, sinceDate)
      )
    )
    .orderBy(asc(tpEntityTimeseries.bucketDate));
}

// ---------------------------------------------------------------------------
// Entity State
// ---------------------------------------------------------------------------

export async function getOrCreateEntityState(
  companyId: number,
  entityId: number,
  geography: string
): Promise<TpEntityState> {
  const existing = await db
    .select()
    .from(tpEntityState)
    .where(
      and(eq(tpEntityState.entityId, entityId), eq(tpEntityState.geography, geography))
    )
    .limit(1);
  if (existing.length > 0) return existing[0]!;

  const rows = await db
    .insert(tpEntityState)
    .values({ companyId, entityId, geography, state: "candidate" })
    .onConflictDoNothing()
    .returning();
  if (rows.length > 0) return rows[0]!;

  // Lost race — fetch what the other inserter created
  const fetched = await db
    .select()
    .from(tpEntityState)
    .where(
      and(eq(tpEntityState.entityId, entityId), eq(tpEntityState.geography, geography))
    )
    .limit(1);
  return fetched[0]!;
}

export async function updateEntityState(
  id: number,
  data: Partial<TpEntityState>
): Promise<TpEntityState> {
  const rows = await db
    .update(tpEntityState)
    .set({ ...data, computedAt: new Date() })
    .where(eq(tpEntityState.id, id))
    .returning();
  return rows[0]!;
}

export async function getEntityStates(
  companyId: number,
  filters?: { state?: string; geography?: string; entityId?: number }
): Promise<TpEntityState[]> {
  const conditions = [eq(tpEntityState.companyId, companyId)];
  if (filters?.state) conditions.push(eq(tpEntityState.state, filters.state));
  if (filters?.geography) conditions.push(eq(tpEntityState.geography, filters.geography));
  if (filters?.entityId !== undefined) conditions.push(eq(tpEntityState.entityId, filters.entityId));
  return db
    .select()
    .from(tpEntityState)
    .where(and(...conditions))
    .orderBy(desc(tpEntityState.computedAt));
}

export async function getEntityStateWithEntity(
  companyId: number,
  filters?: { state?: string; geography?: string; minVolume7d?: number }
): Promise<Array<TpEntityState & { entity: TpEntity }>> {
  const conditions = [eq(tpEntityState.companyId, companyId)];
  if (filters?.state) conditions.push(eq(tpEntityState.state, filters.state));
  if (filters?.geography) conditions.push(eq(tpEntityState.geography, filters.geography));
  if (filters?.minVolume7d !== undefined) {
    conditions.push(gte(tpEntityState.volume7d, filters.minVolume7d));
  }
  const rows = await db
    .select({ state: tpEntityState, entity: tpEntities })
    .from(tpEntityState)
    .innerJoin(tpEntities, eq(tpEntityState.entityId, tpEntities.id))
    .where(and(...conditions))
    .orderBy(desc(tpEntityState.volume7d));
  return rows.map((r) => ({ ...r.state, entity: r.entity }));
}

// ---------------------------------------------------------------------------
// Enriched Trends — joins entity states to knowledge items for the Trends page
// ---------------------------------------------------------------------------

export interface EnrichedTrend {
  id: number;           // knowledge item id
  title: string;
  state: string;
  signalStrength: number;
  wowGrowthPct: number;
  platforms: string[];
  evidenceCount: number;
  geography: string;
  territoryTag: string | null;
  summary: string | null;
  description: string | null;
  topicLabel: string | null;
  updatedAt: string;
}

export async function getTrendsEnriched(
  companyId: number,
  filters?: { archived?: boolean }
): Promise<EnrichedTrend[]> {
  const conditions = [
    eq(tpEntityState.companyId, companyId),
    not(isNull(tpEntityState.knowledgeItemId)),
    isNull(tpEntities.deletedAt),
  ];

  const rows = await db
    .select({
      ki: knowledgeItems,
      es: tpEntityState,
    })
    .from(tpEntityState)
    .innerJoin(tpEntities, eq(tpEntityState.entityId, tpEntities.id))
    .innerJoin(knowledgeItems, eq(tpEntityState.knowledgeItemId, knowledgeItems.id))
    .where(and(...conditions))
    .orderBy(desc(tpEntityState.volume7d));

  return rows
    .filter((r) =>
      filters?.archived === undefined ? !r.ki.archived : r.ki.archived === filters.archived
    )
    .map((r) => ({
      id: r.ki.id,
      title: r.ki.title,
      state: r.es.state,
      signalStrength: r.ki.signalStrength ?? 0,
      wowGrowthPct: Math.round(r.es.growthWow * 1000) / 10,
      platforms: r.es.platformsSeen ?? [],
      evidenceCount: r.ki.evidenceCount ?? 0,
      geography: r.es.geography,
      territoryTag: r.es.territoryTag ?? null,
      summary: r.ki.summary ?? null,
      description: r.ki.description ?? null,
      topicLabel: r.ki.topicLabel ?? null,
      updatedAt: r.ki.updatedAt.toISOString(),
    }));
}

export interface TrendEvidence {
  id: number;
  title: string | null;
  source: string;
  url: string | null;
  publishedAt: string | null;
  engagementScore: number | null;
  platform: string;
  author: string | null;
  excerpt: string | null;
}

export async function getTrendDetail(
  companyId: number,
  knowledgeItemId: number
): Promise<(EnrichedTrend & { evidence: TrendEvidence[]; growthMomPct: number; volume7d: number; volume30d: number }) | null> {
  const conditions = [
    eq(tpEntityState.companyId, companyId),
    eq(tpEntityState.knowledgeItemId, knowledgeItemId),
  ];

  const rows = await db
    .select({ ki: knowledgeItems, es: tpEntityState })
    .from(tpEntityState)
    .innerJoin(knowledgeItems, eq(tpEntityState.knowledgeItemId, knowledgeItems.id))
    .where(and(...conditions))
    .limit(1);

  if (rows.length === 0) {
    // Fall back to plain knowledge item lookup
    const kiRows = await db.select().from(knowledgeItems).where(
      and(eq(knowledgeItems.id, knowledgeItemId), eq(knowledgeItems.companyId, companyId))
    ).limit(1);
    if (kiRows.length === 0) return null;
    const ki = kiRows[0]!;
    return {
      id: ki.id,
      title: ki.title,
      state: "candidate",
      signalStrength: ki.signalStrength ?? 0,
      wowGrowthPct: 0,
      growthMomPct: 0,
      platforms: [],
      evidenceCount: ki.evidenceCount ?? 0,
      geography: ki.geographicScope ?? "Global",
      territoryTag: null,
      summary: ki.summary ?? null,
      description: ki.description ?? null,
      topicLabel: ki.topicLabel ?? null,
      updatedAt: ki.updatedAt.toISOString(),
      volume7d: 0,
      volume30d: 0,
      evidence: [],
    };
  }

  const { ki, es } = rows[0]!;

  // Fetch raw signals for this entity as evidence (most recent, limit 20)
  const evidenceRows = await db
    .select({
      sig: tpRawSignals,
    })
    .from(tpSignalEntities)
    .innerJoin(tpRawSignals, eq(tpSignalEntities.rawSignalId, tpRawSignals.id))
    .where(
      and(
        eq(tpSignalEntities.entityId, es.entityId),
        eq(tpRawSignals.companyId, companyId)
      )
    )
    .orderBy(desc(tpRawSignals.capturedAt))
    .limit(20);

  const evidence: TrendEvidence[] = evidenceRows.map((r) => ({
    id: r.sig.id,
    title: r.sig.text?.slice(0, 120) ?? null,
    source: r.sig.platform,
    url: r.sig.sourceUrl ?? null,
    publishedAt: r.sig.postedAt?.toISOString() ?? null,
    engagementScore: r.sig.engagementScore ?? null,
    platform: r.sig.platform,
    author: r.sig.authorHandle ?? null,
    excerpt: r.sig.text?.slice(0, 300) ?? null,
  }));

  return {
    id: ki.id,
    title: ki.title,
    state: es.state,
    signalStrength: ki.signalStrength ?? 0,
    wowGrowthPct: Math.round(es.growthWow * 1000) / 10,
    growthMomPct: Math.round(es.growthMom * 1000) / 10,
    platforms: es.platformsSeen ?? [],
    evidenceCount: ki.evidenceCount ?? 0,
    geography: es.geography,
    territoryTag: es.territoryTag ?? null,
    summary: ki.summary ?? null,
    description: ki.description ?? null,
    topicLabel: ki.topicLabel ?? null,
    updatedAt: ki.updatedAt.toISOString(),
    volume7d: es.volume7d,
    volume30d: es.volume30d,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Trend time-series — combined social mentions + Google search interest for
// the trend's primary entity. Used by the trend detail chart.
// ---------------------------------------------------------------------------

export interface TrendTimeseriesPoint {
  date: string;        // YYYY-MM-DD
  mentions: number;    // sum across platforms / geographies
  interest: number | null; // 0-100, null if no GT data for that day
}

export interface TrendTimeseriesResponse {
  entityId: number | null;
  keywords: string[];   // keywords matched in tp_keyword_interest
  windowDays: number;
  hasInterest: boolean;
  hasMentions: boolean;
  points: TrendTimeseriesPoint[];
}

export async function getTrendTimeseries(
  companyId: number,
  knowledgeItemId: number,
  windowDays = 90
): Promise<TrendTimeseriesResponse> {
  // Find the entity behind this knowledge item via tp_entity_state.
  const stateRows = await db
    .select({ es: tpEntityState, ent: tpEntities })
    .from(tpEntityState)
    .innerJoin(tpEntities, eq(tpEntityState.entityId, tpEntities.id))
    .where(
      and(
        eq(tpEntityState.companyId, companyId),
        eq(tpEntityState.knowledgeItemId, knowledgeItemId)
      )
    )
    .limit(1);

  if (stateRows.length === 0) {
    return {
      entityId: null,
      keywords: [],
      windowDays,
      hasInterest: false,
      hasMentions: false,
      points: [],
    };
  }

  const { es, ent } = stateRows[0]!;

  // Build keyword set from canonical label + aliases (defensive against null).
  const keywords = Array.from(
    new Set(
      [ent.canonicalLabel, ...(ent.aliases ?? [])]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .map((s) => s.trim())
    )
  );

  const [mentionRows, interestRows] = await Promise.all([
    getEntityTimeseries(es.entityId, windowDays),
    getKeywordInterestSeries(companyId, keywords, windowDays),
  ]);

  // Aggregate mentions by date (sum across platform/geography).
  const mentionsByDate = new Map<string, number>();
  for (const r of mentionRows) {
    const date = String(r.bucketDate);
    mentionsByDate.set(date, (mentionsByDate.get(date) ?? 0) + (r.mentions ?? 0));
  }

  // For interest, take the MAX across keywords for a date (keywords are
  // closely related; max preserves the visible signal). Empty days stay null.
  const interestByDate = new Map<string, number>();
  for (const r of interestRows) {
    const date = String(r.bucketDate);
    const prev = interestByDate.get(date);
    interestByDate.set(date, prev == null ? r.interestValue : Math.max(prev, r.interestValue));
  }

  const allDates = new Set<string>([...mentionsByDate.keys(), ...interestByDate.keys()]);
  const points: TrendTimeseriesPoint[] = Array.from(allDates)
    .sort()
    .map((date) => ({
      date,
      mentions: mentionsByDate.get(date) ?? 0,
      interest: interestByDate.has(date) ? interestByDate.get(date)! : null,
    }));

  return {
    entityId: es.entityId,
    keywords,
    windowDays,
    hasInterest: interestByDate.size > 0,
    hasMentions: mentionsByDate.size > 0,
    points,
  };
}

// ---------------------------------------------------------------------------
// Pipeline run status — live scope counts + last-run timestamps for the three
// manual pipeline steps shown on the Entities Audit page.
// ---------------------------------------------------------------------------

export interface PipelineRunStatus {
  extraction: {
    pendingSignals: number;
    failedSignals: number;
    totalSignals: number;
    lastExtractionAt: string | null;
  };
  timeseries: {
    signalsInWindow: number;
    windowDays: number;
    lastComputedAt: string | null;
  };
  stateMachine: {
    activeEntities: number;
    lastComputedAt: string | null;
  };
}

export async function getPipelineRunStatus(
  companyId: number,
  windowDays = 90
): Promise<PipelineRunStatus> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [
    extractionRows,
    extractionLastRows,
    timeseriesWindowRows,
    timeseriesLastRows,
    activeEntityRows,
    stateLastRows,
  ] = await Promise.all([
    db
      .select({
        status: tpRawSignals.entityExtractionStatus,
        cnt: count(),
      })
      .from(tpRawSignals)
      .where(eq(tpRawSignals.companyId, companyId))
      .groupBy(tpRawSignals.entityExtractionStatus),
    db
      .select({ ts: sql<Date | null>`max(${tpRawSignals.entityExtractionAt})` })
      .from(tpRawSignals)
      .where(eq(tpRawSignals.companyId, companyId)),
    // Count the same scope the timeseries job actually processes:
    // raw signals joined to non-deleted entities via signal_entities.
    db
      .select({ cnt: count() })
      .from(tpRawSignals)
      .innerJoin(
        tpSignalEntities,
        eq(tpSignalEntities.rawSignalId, tpRawSignals.id)
      )
      .innerJoin(tpEntities, eq(tpEntities.id, tpSignalEntities.entityId))
      .where(
        and(
          eq(tpRawSignals.companyId, companyId),
          gte(tpRawSignals.capturedAt, since),
          isNull(tpEntities.deletedAt)
        )
      ),
    // Only consider timestamps from non-deleted entities — the manual job
    // skips deleted ones, so a deleted entity's stale row should not make
    // "last run" look fresher than reality.
    db
      .select({ ts: sql<Date | null>`max(${tpEntityTimeseries.computedAt})` })
      .from(tpEntityTimeseries)
      .innerJoin(tpEntities, eq(tpEntityTimeseries.entityId, tpEntities.id))
      .where(
        and(eq(tpEntities.companyId, companyId), isNull(tpEntities.deletedAt))
      ),
    db
      .select({ cnt: count() })
      .from(tpEntities)
      .where(
        and(eq(tpEntities.companyId, companyId), isNull(tpEntities.deletedAt))
      ),
    db
      .select({ ts: sql<Date | null>`max(${tpEntityState.computedAt})` })
      .from(tpEntityState)
      .innerJoin(tpEntities, eq(tpEntityState.entityId, tpEntities.id))
      .where(
        and(eq(tpEntities.companyId, companyId), isNull(tpEntities.deletedAt))
      ),
  ]);

  let pending = 0;
  let failed = 0;
  let total = 0;
  for (const row of extractionRows) {
    const n = Number(row.cnt ?? 0);
    total += n;
    if (row.status === "pending") pending = n;
    else if (row.status === "failed") failed = n;
  }

  const toIso = (v: Date | null | undefined): string | null =>
    v ? new Date(v).toISOString() : null;

  return {
    extraction: {
      pendingSignals: pending,
      failedSignals: failed,
      totalSignals: total,
      lastExtractionAt: toIso(extractionLastRows[0]?.ts ?? null),
    },
    timeseries: {
      signalsInWindow: Number(timeseriesWindowRows[0]?.cnt ?? 0),
      windowDays,
      lastComputedAt: toIso(timeseriesLastRows[0]?.ts ?? null),
    },
    stateMachine: {
      activeEntities: Number(activeEntityRows[0]?.cnt ?? 0),
      lastComputedAt: toIso(stateLastRows[0]?.ts ?? null),
    },
  };
}
