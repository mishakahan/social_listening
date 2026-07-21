// Read-only snapshot of the current radar: what the gate passed/held and why.
// Handy before/after a specificity or state-machine rerun.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMPANY_ID = Number(process.env.REGEN_COMPANY_ID ?? "1");

const rows: any = await db.execute(sql`
  SELECT e.canonical_label AS label,
         s.state,
         s.confirmation_verdict->>'decision'   AS decision,
         s.confirmation_verdict->>'significanceP' AS p,
         s.confirmation_verdict->>'entropyBits'   AS bits,
         s.specificity_verdict->>'specific'    AS specific,
         s.specificity_verdict->>'reason'      AS spec_reason
  FROM tp_entity_state s
  JOIN tp_entities e ON e.id = s.entity_id
  WHERE s.company_id = ${COMPANY_ID}
    AND s.confirmation_verdict IS NOT NULL
  ORDER BY (s.confirmation_verdict->>'decision') DESC, e.canonical_label
`);

const all = rows.rows ?? rows;
const passed = all.filter((r: any) => r.decision === "pass");
const held = all.filter((r: any) => r.decision !== "pass");

console.log(`\n=== PASSED (${passed.length}) ===`);
for (const r of passed) {
  console.log(
    `  ${r.label}  [${r.state}] p=${r.p ?? "?"} bits=${r.bits ?? "?"}  specific=${r.specific}  :: ${r.spec_reason ?? ""}`
  );
}
console.log(`\n=== HELD (${held.length}) ===`);
for (const r of held) {
  console.log(`  ${r.label}  [${r.state}] specific=${r.specific} :: ${r.spec_reason ?? ""}`);
}
process.exit(0);
