// One-shot repair for evidence already split across a modifier and its compound
// ("non-alcoholic" 26 mentions vs "non-alcoholic beer" 39). Registers the
// modifier as an alias of the compound and archives the orphan, so the volume
// consolidates instead of the modifier simply vanishing from the radar.
//
// SAFETY: writes to the shared live Neon database. Dry-run first (default) and
// inspect every pair before passing --apply. Only one process should touch the
// DB at a time.
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
  const weights: Record<string, number> = Object.fromEntries(
    entities.map((e) => [e.canonical_label.trim().toLowerCase(), e.total_mentions ?? 0])
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
    console.log(`  "${p.from.canonical_label}"  ->  "${p.to}"`);
  }
  console.log(`${plans.length} modifier(s) with a compound parent`);

  if (dryRun) {
    console.log("dry run — pass --apply to write");
    return;
  }

  for (const p of plans) {
    await db.execute(
      sql`insert into tp_entity_synonyms
            (company_id, alias, canonical_label, entity_type, source)
          values (${companyId}, ${p.from.canonical_label}, ${p.to},
                  ${p.from.entity_type}, 'dangling-modifier-merge')
          on conflict do nothing`
    );
    await db.execute(
      sql`update tp_entities set deleted_at = now() where id = ${p.from.id}`
    );
  }
  console.log(`merged ${plans.length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
