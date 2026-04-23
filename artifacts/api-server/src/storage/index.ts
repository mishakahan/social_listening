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
} from "drizzle-orm";

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

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
