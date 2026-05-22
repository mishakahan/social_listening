// Backfill tp_entity_co_occurrences from existing tp_signal_entities and then
// run the composite-trend aggregator for every company.
//
// Run with:
//   pnpm --filter @workspace/api-server exec tsx \
//     src/scripts/backfill-co-occurrences.ts
//
// Idempotent: relies on the (raw_signal_id, entity_a_id, entity_b_id) unique
// index in tp_entity_co_occurrences to dedupe re-runs.
import { db } from "@workspace/db";
import {
  tpEntityCoOccurrences,
  tpRawSignals,
  tpSignalEntities,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { runCoOccurrenceAggregation } from "../services/co-occurrence.js";
import * as storage from "../storage/index.js";

async function main() {
  const companies = await storage.getAllCompanies();
  for (const company of companies) {
    // Pull every (signal, entity) link for this company in one shot, group
    // by signal in-memory, derive unordered pairs (a < b), upsert.
    const rows = await db
      .select({
        rawSignalId: tpSignalEntities.rawSignalId,
        entityId: tpSignalEntities.entityId,
        postedAt: sql<Date>`COALESCE(${tpRawSignals.postedAt}, ${tpRawSignals.capturedAt})`,
      })
      .from(tpSignalEntities)
      .innerJoin(
        tpRawSignals,
        sql`${tpRawSignals.id} = ${tpSignalEntities.rawSignalId} AND ${tpRawSignals.companyId} = ${company.id}`
      );

    if (rows.length === 0) {
      logger.info({ companyId: company.id }, "Backfill: no signal-entity links");
      await runCoOccurrenceAggregation(company.id);
      continue;
    }

    const bySignal = new Map<
      number,
      { postedAt: Date; entityIds: Set<number> }
    >();
    for (const r of rows) {
      const sid = Number(r.rawSignalId);
      const eid = Number(r.entityId);
      const cur = bySignal.get(sid);
      const postedAt = r.postedAt instanceof Date ? r.postedAt : new Date(r.postedAt as unknown as string);
      if (cur) {
        cur.entityIds.add(eid);
      } else {
        bySignal.set(sid, { postedAt, entityIds: new Set([eid]) });
      }
    }

    const MAX_PER_SIGNAL = 50;
    const BATCH = 5000;
    let buffer: Array<{
      companyId: number;
      rawSignalId: number;
      entityAId: number;
      entityBId: number;
      postedAt: Date;
    }> = [];
    let inserted = 0;

    async function flush() {
      if (buffer.length === 0) return;
      await db.insert(tpEntityCoOccurrences).values(buffer).onConflictDoNothing();
      inserted += buffer.length;
      buffer = [];
    }

    for (const [rawSignalId, info] of bySignal) {
      const ids = Array.from(info.entityIds).sort((a, b) => a - b);
      if (ids.length < 2) continue;
      const capped = ids.slice(0, MAX_PER_SIGNAL);
      for (let i = 0; i < capped.length; i++) {
        for (let j = i + 1; j < capped.length; j++) {
          buffer.push({
            companyId: company.id,
            rawSignalId,
            entityAId: capped[i]!,
            entityBId: capped[j]!,
            postedAt: info.postedAt,
          });
          if (buffer.length >= BATCH) await flush();
        }
      }
    }
    await flush();

    logger.info(
      { companyId: company.id, signals: bySignal.size, pairsInserted: inserted },
      "Backfill co-occurrence pairs done"
    );

    const stats = await runCoOccurrenceAggregation(company.id);
    logger.info({ companyId: company.id, ...stats }, "Composite aggregation done");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, "Backfill co-occurrence script failed");
    process.exit(1);
  });
