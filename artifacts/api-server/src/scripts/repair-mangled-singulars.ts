// Repair entities whose canonical label was mangled by the old singularizer,
// which stripped a trailing "s" from words that were already singular
// ("citrus" -> "citru", "hummus" -> "hummu", "molasses" -> "molass").
//
// The mangled form BECAME the stored canonical label, so it cannot be detected
// by re-running canonicalizeLabel — "citru" is a fixed point. Detection instead
// asks: if I put the "s" back, do I get a word the new guard recognises as an
// already-singular form? If yes, the label was mangled.
//
// Dry run by default. Pass --apply to write.
//   pnpm exec tsx --env-file=../../.env src/scripts/repair-mangled-singulars.ts
//   pnpm exec tsx --env-file=../../.env src/scripts/repair-mangled-singulars.ts --apply

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const COMPANY_ID = Number(process.env.REGEN_COMPANY_ID ?? "1");
const APPLY = process.argv.includes("--apply");

// EXPLICIT restorations only.
//
// The first attempt at this script derived the restoration by appending "s" and
// testing it against the new already-singular guard. That is unsound: appending
// "s" to any word ending in a vowel produces something matching /us|is$/, so it
// proposed chai->chais, yuzu->yuzus, swiss->swisss and flagged 499 entities. A
// mangled label is not recoverable by rule — "citru" and "chai" are
// indistinguishable without knowing which is a real word.
//
// So: a curated map, limited to food/wellness vocabulary that is unambiguously
// a mangled singular. Brand-looking fragments (vivonu, linfoflu, naali) are
// deliberately EXCLUDED — they may well be real names, and renaming a real
// brand is worse than leaving a rare fragment alone.
const RESTORE: Record<string, string> = {
  focu: "focus",
  superfocu: "superfocus",
  hibiscu: "hibiscus",
  citru: "citrus",
  molass: "molasses",
  hummu: "hummus",
  couscou: "couscous",
  celsiu: "celsius",
  celciu: "celcius",
  cannabi: "cannabis",
  lactobacillu: "lactobacillus",
  astragalu: "astragalus",
  osmanthu: "osmanthus",
  eucalyptu: "eucalyptus",
  phosphoru: "phosphorus",
  tribulu: "tribulus",
  lotu: "lotus",
  asparagu: "asparagus",
  deliciou: "delicious",
  arthriti: "arthritis",
  gastriti: "gastritis",
  psoriasi: "psoriasis",
  endometriosi: "endometriosis",
  gastroparesi: "gastroparesis",
  cirrhosi: "cirrhosis",
  disbiosi: "disbiosis",
  candidiasi: "candidiasis",
  hypervitaminosi: "hypervitaminosis",
  oasi: "oasis",
  propoli: "propolis",
  cassi: "cassis",
};

function restore(label: string): string | null {
  return RESTORE[label.toLowerCase()] ?? null;
}

const rows: any = await db.execute(sql`
  SELECT e.id, e.canonical_label AS label,
         COALESCE(SUM(t.mentions), 0) AS mentions
  FROM tp_entities e
  LEFT JOIN tp_entity_timeseries t ON t.entity_id = e.id
  WHERE e.company_id = ${COMPANY_ID}
  GROUP BY 1, 2
`);
const all = (rows.rows ?? rows) as { id: number; label: string; mentions: string }[];
const byLabel = new Map(all.map((e) => [e.label, e]));

const fixes: { id: number; from: string; to: string; mentions: string; collides: boolean }[] = [];
for (const e of all) {
  const to = restore(e.label);
  if (!to || to === e.label) continue;
  fixes.push({ id: e.id, from: e.label, to, mentions: e.mentions, collides: byLabel.has(to) });
}

if (fixes.length === 0) {
  console.log("no mangled singulars found");
  process.exit(0);
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${fixes.length} mangled label(s):\n`);
for (const f of fixes) {
  console.log(
    `  ${String(f.mentions).padStart(4)}m  ${f.from.padEnd(16)} -> ${f.to.padEnd(16)}` +
      (f.collides ? "  !! COLLIDES with an existing entity — needs a merge, skipping" : "")
  );
}

// A collision means both the mangled and correct forms exist; merging them means
// repointing timeseries/buckets/states, which is what merge-case-duplicate-entities.ts
// is for. Renaming into an occupied label would violate the unique index anyway.
const safe = fixes.filter((f) => !f.collides);
const blocked = fixes.length - safe.length;
if (blocked > 0) {
  console.log(`\n${blocked} need a merge, not a rename — run merge-case-duplicate-entities.ts after.`);
}

if (!APPLY) {
  console.log("\n(dry run — pass --apply to write)");
  process.exit(0);
}

let renamed = 0;
for (const f of safe) {
  await db.execute(sql`
    UPDATE tp_entities SET canonical_label = ${f.to} WHERE id = ${f.id}
  `);
  renamed++;
}
console.log(`\nrenamed ${renamed} entit(ies)`);
process.exit(0);
