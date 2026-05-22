/**
 * One-shot backfill for tp_entity_state.{momGrowthPct, yoyGrowthPct,
 * momCurrent, momPrior, yoyCurrent, yoyPrior}.
 *
 * Iterates every company, calls computeDeltasForCompany(), and updates each
 * entity_state row (one row per (entity, geography); the same entity-wide
 * delta is written to all of them).
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-mom-yoy-deltas.ts
 */
import { db } from "@workspace/db";
import { companies, tpEntityState } from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeDeltasForCompany } from "../services/deltas.js";

async function main() {
  const allCompanies = await db.select().from(companies);
  // eslint-disable-next-line no-console
  console.log(`[backfill] ${allCompanies.length} companies`);

  let totalUpdated = 0;
  for (const c of allCompanies) {
    const deltas = await computeDeltasForCompany(c.id);
    if (deltas.length === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[backfill] company ${c.id} (${c.name}): no entities with timeseries`
      );
      continue;
    }
    let updated = 0;
    for (const d of deltas) {
      const result = await db
        .update(tpEntityState)
        .set({
          momGrowthPct: d.momGrowthPct,
          yoyGrowthPct: d.yoyGrowthPct,
          momCurrent: d.momCurrent,
          momPrior: d.momPrior,
          yoyCurrent: d.yoyCurrent,
          yoyPrior: d.yoyPrior,
        })
        .where(eq(tpEntityState.entityId, d.entityId))
        .returning({ id: tpEntityState.id });
      updated += result.length;
    }
    totalUpdated += updated;
    // eslint-disable-next-line no-console
    console.log(
      `[backfill] company ${c.id} (${c.name}): ${deltas.length} entities, ${updated} state rows updated`
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[backfill] done. ${totalUpdated} entity_state rows updated.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[backfill] failed:", err);
    process.exit(1);
  });
