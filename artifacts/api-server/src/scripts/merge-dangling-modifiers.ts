// One-shot repair for evidence already split across a modifier and its compound
// ("non-alcoholic" 73 mentions vs "non-alcoholic beer" 64). Registers the
// modifier as an alias of the compound and archives the orphan, so the volume
// consolidates instead of the modifier simply vanishing from the radar.
//
// ROUND 1 SHIPPED A DATA-LOSS BUG: findCompoundParent picked the best
// candidate PARENT by weight, but never compared that parent's weight to the
// MODIFIER's own weight. "vegan" (479 mentions) got archived into "vegan
// chocolate" (28) — evidence went backwards, not consolidated. Fixed in
// findCompoundParent itself: it now returns null unless the chosen parent's
// weight is >= the modifier's own weight, so a modifier that carries more
// evidence than every candidate is left alone instead of merged. See
// well-formedness.ts and well-formedness.test.ts for the guard + coverage.
//
// SAFETY: writes to the shared live Neon database. Dry-run first (default) and
// inspect every pair before passing --apply — specifically confirm the
// parent's weight (printed alongside each pair) is >= the modifier's weight.
// Only one process should touch the DB at a time.
//
//   COMPANY_ID=1 pnpm exec tsx --env-file=../../.env src/scripts/merge-dangling-modifiers.ts
//   COMPANY_ID=1 pnpm exec tsx --env-file=../../.env src/scripts/merge-dangling-modifiers.ts --apply
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { findCompoundParent, isDanglingModifier } from "../services/well-formedness.js";

const dryRun = !process.argv.includes("--apply");
const companyId = Number(process.env.COMPANY_ID ?? 1);

async function main() {
  const rows = await db.execute(
    sql`select id, canonical_label, entity_type, total_mentions from tp_entities
         where company_id = ${companyId} and deleted_at is null`
  );
  const entities = rows.rows as Array<{
    id: number; canonical_label: string; entity_type: string; total_mentions: number;
  }>;
  const labels = entities.map((e) => e.canonical_label);
  // Evidence weight per label, so the parent pick favours the entity that
  // actually carries the conversation, not whichever string is shortest.
  // Keyed by the EXACT canonical_label (not lowercased): two case-duplicate
  // entities like "Artisanal" and "artisanal" must keep distinct weights, or
  // one silently overwrites the other's mention count in this map and the
  // volume guard below reads the wrong entity's evidence.
  const weights: Record<string, number> = Object.fromEntries(
    entities.map((e) => [e.canonical_label.trim(), e.total_mentions ?? 0])
  );

  const plans: Array<{ from: typeof entities[number]; to: string }> = [];
  for (const e of entities) {
    // Only standalone modifiers are eligible to fold into a compound. Occasion
    // words ("brunch", "graduation") are dropped by the well-formedness gate
    // on the next state-machine run with no DB action here — an occasion next
    // to a plausible compound ("brunch cocktails") is a different, narrower
    // topic, not the same conversation split in two.
    if (!isDanglingModifier(e.canonical_label)) continue;
    const parent = findCompoundParent(e.canonical_label, labels, weights);
    if (parent) plans.push({ from: e, to: parent });
  }

  for (const p of plans) {
    // p.from.total_mentions is authoritative for the modifier's own weight
    // (no lookup needed); p.to came straight from the `labels` array built
    // from the same entities, so it is an exact key into `weights`.
    const modW = p.from.total_mentions ?? 0;
    const parentW = weights[p.to] ?? 0;
    console.log(`  "${p.from.canonical_label}" (${modW}m)  ->  "${p.to}" (${parentW}m)`);
  }
  console.log(`${plans.length} modifier(s) with a compound parent that carries at least as much evidence`);

  if (dryRun) {
    console.log("dry run — pass --apply to write");
    return;
  }

  for (const p of plans) {
    // Wrapped so a mid-loop failure (e.g. connection drop) cannot leave the
    // synonym row written without the archive, or vice versa.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`insert into tp_entity_synonyms
              (company_id, alias, canonical_label, entity_type, source)
            values (${companyId}, ${p.from.canonical_label}, ${p.to},
                    ${p.from.entity_type}, 'dangling-modifier-merge')
            on conflict do nothing`
      );
      await tx.execute(
        sql`update tp_entities set deleted_at = now() where id = ${p.from.id}`
      );
      // The entity soft-delete alone doesn't hide it from the detail route —
      // getTrendDetail (unlike getTrendsEnriched) had no deletedAt guard until
      // this fix wave, and even with that guard a knowledge item left
      // "current" would just keep aging on its old data forever instead of
      // ever being cleaned up. Archive the knowledge item(s) this entity's
      // state rows point to in the same transaction so both sides land or
      // neither does.
      await tx.execute(
        sql`update knowledge_items
              set archived = true
            where id in (
              select knowledge_item_id from tp_entity_state
              where entity_id = ${p.from.id} and knowledge_item_id is not null
            )`
      );
    });
  }
  console.log(`merged ${plans.length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
