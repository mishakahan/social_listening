// Acceptance check for the two-axis specificity change.
//   1. the three category-wide terms Jonathan flagged are now HELD
//   2. the real trends still CONFIRM
//   3. the 10 evergreen noise terms still hold 10/10
//
//   pnpm exec tsx --env-file=../../.env src/scripts/check-specificity-rerun.ts

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMPANY_ID = Number(process.env.REGEN_COMPANY_ID ?? "1");

const MUST_HOLD = ["gummy bears", "haribo", "caramelle gommose"];
// juneshine was in this list originally, but that expectation was itself an
// artifact of the stale-verdict bug: juneshine is DORMANT, and only ever showed
// "pass" because a verdict from when it was emerging was never cleared. With the
// stale-verdict fix its verdict is correctly cleared, so it no longer surfaces.
// Asserting pass here would be asserting the bug. If we later decide dormant
// benchmark-matches should surface, that is a product change to the state
// machine, not something this check should demand.
const MUST_PASS = ["creatine", "vitamin d3"];
// Verified-correct holds we assert explicitly so a regression that re-surfaced
// them (e.g. a reintroduced stale verdict) would fail the check.
const DORMANT_MUST_NOT_SURFACE = ["juneshine", "shallot"];
// Repaired by the singularizer fix + repair-mangled-singulars.ts — these used to
// exist under mangled labels ("citru", "focu", "hibiscu").
const REPAIRED_LABELS = ["citrus", "focus", "hibiscus"];
// Schedule B evergreen noise (seed-benchmark-queries.ts + seed-extra-noise.ts)
const NOISE = ["water", "bread", "sugar", "salt", "rice", "butter", "spoon", "napkin", "plate", "flour"];

// STALE_AFTER guards against a trap this script walked into once: the gate only
// runs for surfacing states (emerging/confirmed/peaking/resurgent). When an
// entity drops to `dormant` its old confirmation_verdict is left untouched, so
// it keeps showing as "pass" on the radar forever. Reading that as a fresh
// confirmation reports a trend the current run never actually re-confirmed.
const STALE_AFTER_HOURS = Number(process.env.STALE_AFTER_HOURS ?? "12");

const rows: any = await db.execute(sql`
  SELECT lower(e.canonical_label) AS label,
         s.state,
         s.confirmation_verdict->>'decision'    AS decision,
         s.confirmation_verdict->>'evaluatedAt' AS evaluated_at,
         s.specificity_verdict->>'specific'     AS specific,
         s.specificity_verdict->>'reason'       AS reason
  FROM tp_entity_state s
  JOIN tp_entities e ON e.id = s.entity_id
  WHERE s.company_id = ${COMPANY_ID}
`);
const all = rows.rows ?? rows;

// An entity can have several states (per geography); it is on the radar if ANY
// of them passed.
type Row = {
  decision: string | null;
  state: string | null;
  evaluated_at: string | null;
  specific: string | null;
  reason: string | null;
};
const byLabel = new Map<string, Row>();
for (const r of all) {
  const prev = byLabel.get(r.label);
  if (!prev || (r.decision === "pass" && prev.decision !== "pass")) byLabel.set(r.label, r);
}

let failures = 0;
let stale = 0;
const report = (label: string, want: "pass" | "hold") => {
  const r = byLabel.get(label);
  const decision = r?.decision ?? null;
  const got: "pass" | "hold" = decision === "pass" ? "pass" : "hold";
  const ok = got === want;
  if (!ok) failures++;

  const ageH = r?.evaluated_at
    ? (Date.now() - Date.parse(r.evaluated_at)) / 3_600_000
    : null;
  const isStale = got === "pass" && ageH !== null && ageH > STALE_AFTER_HOURS;
  if (isStale) stale++;

  const seen = r ? "" : "  (no entity state)";
  console.log(
    `  ${ok ? (isStale ? "STALE" : "OK  ") : "FAIL"}  ${label.padEnd(20)} want=${want} got=${got}${seen}` +
      (isStale
        ? `\n           !! verdict is ${ageH!.toFixed(0)}h old (state=${r!.state}) — NOT re-confirmed by this run`
        : "") +
      (r?.reason ? `\n           specific=${r.specific} :: ${r.reason}` : "")
  );
};

console.log("\n=== must now be HELD (Jonathan's flags) ===");
MUST_HOLD.forEach((l) => report(l, "hold"));

console.log("\n=== must still CONFIRM ===");
MUST_PASS.forEach((l) => report(l, "pass"));

console.log("\n=== dormant — must NOT surface (stale-verdict fix) ===");
DORMANT_MUST_NOT_SURFACE.forEach((l) => report(l, "hold"));

console.log("\n=== evergreen noise (want 10/10 held) ===");
const before = failures;
NOISE.forEach((l) => report(l, "hold"));
console.log(`  noise held: ${NOISE.length - (failures - before)}/${NOISE.length}`);

// Not pass/hold assertions — just confirm the repaired labels exist and the
// mangled forms are gone, so a regression in the singularizer would show here.
console.log("\n=== repaired labels (singularizer fix) ===");
for (const good of REPAIRED_LABELS) {
  const hasGood = byLabel.has(good);
  const mangled = good.slice(0, -1); // citrus->citru, focus->focu, hibiscus->hibiscu
  const hasMangled = byLabel.has(mangled);
  const ok = hasGood && !hasMangled;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "OK  " : "FAIL"}  ${good.padEnd(20)} present=${hasGood} mangled("${mangled}")=${hasMangled}`
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (stale > 0) {
  console.log(
    `WARNING: ${stale} of the passes rest on a verdict older than ${STALE_AFTER_HOURS}h.\n` +
      `  The gate only runs for surfacing states, so a dormant entity keeps its last\n` +
      `  verdict indefinitely. Those are NOT confirmations from this run.`
  );
}
process.exit(failures === 0 ? 0 : 1);
