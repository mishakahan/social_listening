// One-shot: existing tp_entity_state rows still carry state='confirmed'.
// Run once after the rename lands, then this script is dead weight.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const dryRun = !process.argv.includes("--apply");

async function main() {
  const before = await db.execute(
    sql`select count(*)::int as n from tp_entity_state where state = 'confirmed'`
  );
  const n = (before.rows[0] as { n: number }).n;
  console.log(`rows with state='confirmed': ${n}`);

  if (dryRun) {
    console.log("dry run — pass --apply to write");
    return;
  }

  await db.execute(
    sql`update tp_entity_state set state = 'sustained' where state = 'confirmed'`
  );
  const after = await db.execute(
    sql`select count(*)::int as n from tp_entity_state where state = 'confirmed'`
  );
  console.log(`remaining after update: ${(after.rows[0] as { n: number }).n}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
