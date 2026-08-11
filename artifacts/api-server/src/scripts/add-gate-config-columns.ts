// Additive migration: expose the confirmation gate's thresholds as real
// tp_pipeline_config columns so the Control Panel can reach them.
//
// Deliberately NOT `drizzle-kit push`: push diffs the whole schema against the
// live DB and will happily propose drops or type changes if anything else has
// drifted. This is the shared Neon DB behind the client's deployment, so the
// migration is written out explicitly — three ADD COLUMN IF NOT EXISTS, no
// other statements, idempotent, and reversible with three DROP COLUMNs.
//
// The defaults reproduce CURRENTLY LIVE behaviour. No GATE_* env override is
// set in this deployment, so every existing verdict was computed at 1.0 bits
// with the significance test required. Backfilling anything else would rewrite
// the radar on the next recompute.
//
//   cd artifacts/api-server && pnpm exec tsx --env-file=../../.env \
//     src/scripts/add-gate-config-columns.ts

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const STATEMENTS = [
  `ALTER TABLE tp_pipeline_config
     ADD COLUMN IF NOT EXISTS gate_enabled boolean NOT NULL DEFAULT true`,
  `ALTER TABLE tp_pipeline_config
     ADD COLUMN IF NOT EXISTS gate_min_source_entropy_bits double precision NOT NULL DEFAULT 1.0`,
  `ALTER TABLE tp_pipeline_config
     ADD COLUMN IF NOT EXISTS gate_require_significance boolean NOT NULL DEFAULT true`,
];

async function main() {
  for (const stmt of STATEMENTS) {
    console.log(`> ${stmt.replace(/\s+/g, " ").trim()}`);
    await db.execute(sql.raw(stmt));
  }

  // Read the columns back rather than trusting that the ALTERs "worked" — a
  // migration that reports success without being verified is the same class of
  // broken reporter that has bitten this project three times.
  const check = await db.execute(
    sql.raw(`SELECT column_name, data_type, is_nullable, column_default
               FROM information_schema.columns
              WHERE table_name = 'tp_pipeline_config'
                AND column_name LIKE 'gate\\_%'
              ORDER BY column_name`)
  );
  console.log("\nColumns now present:");
  console.table(check.rows);

  const values = await db.execute(
    sql.raw(`SELECT company_id, gate_enabled, gate_min_source_entropy_bits,
                    gate_require_significance
               FROM tp_pipeline_config ORDER BY company_id`)
  );
  console.log("\nPer-company values (must match pre-migration behaviour):");
  console.table(values.rows);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
