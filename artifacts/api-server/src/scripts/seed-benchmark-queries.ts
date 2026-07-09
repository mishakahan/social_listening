// Seed the Schedule B benchmark backtest queries: 20 consumer-brand positives
// (known trends that should PASS the gate) + 10 evergreen noise terms (should
// HOLD). Creates them INACTIVE under a separate seed so they don't mix with the
// 10 Leone test queries. Idempotent-ish: clears prior benchmark seeds first.
import * as storage from "../storage/index.js";
import { db, tpScoutQueries, tpSeedItems } from "@workspace/db";
import { eq, and, like } from "drizzle-orm";

const COMPANY_ID = Number(process.env.REGEN_COMPANY_ID ?? "1");

// [label, expected] — expected is recorded in the seed label for later scoring
const POSITIVES = [
  "Athletic Brewing", "High Noon Cocktail", "JuneShine", "Jiant Kombucha",
  "Equiano Rum", "Los Sundays Tequila", "Onda Tequila", "Three Spirit",
  "Pentire Drinks", "Lunar Seltzer", "Lychee Seltzer", "Boozy Tea",
  "Coolberg", "Pinkglow Pineapple", "Oishii Strawberries", "Ritual Rum",
  "Nomadica Wine", "TALEA Beer Co.", "Mayawell", "Happi Drink",
];
const NOISE = ["Water", "Coffee", "Bread", "Milk", "Sugar", "Salt", "Apple", "Chicken", "Rice", "Butter"];

function toKeywords(name: string): string[] {
  const clean = name.replace(/\bCo\.?\b/gi, "").trim();
  return [name, clean, `${clean} review`, `${clean} drink`].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
}
function toHashtags(name: string): string[] {
  const tag = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [tag];
}

async function main() {
  // remove prior benchmark seeds/queries (labelled with the BENCH: prefix)
  const priorSeeds = await db
    .select()
    .from(tpSeedItems)
    .where(and(eq(tpSeedItems.companyId, COMPANY_ID), like(tpSeedItems.label, "BENCH:%")));
  for (const s of priorSeeds) {
    await db.delete(tpScoutQueries).where(eq(tpScoutQueries.seedItemId, s.id));
    await db.delete(tpSeedItems).where(eq(tpSeedItems.id, s.id));
  }
  console.log(`cleared ${priorSeeds.length} prior benchmark seeds`);

  const all = [
    ...POSITIVES.map((n) => ({ name: n, expected: "pass" as const })),
    ...NOISE.map((n) => ({ name: n, expected: "hold" as const })),
  ];
  for (const q of all) {
    const seed = await storage.createSeedItem({
      companyId: COMPANY_ID,
      label: `BENCH:${q.expected}:${q.name}`,
      geography: "Global",
      status: "committed",
    } as any);
    await storage.createScoutQuery({
      companyId: COMPANY_ID,
      seedItemId: seed.id,
      topicLabel: `BENCH:${q.expected}:${q.name}`,
      geography: "Global",
      language: "en",
      keywords: toKeywords(q.name),
      hashtags: toHashtags(q.name),
      active: false,
    } as any);
    console.log(`  ${q.expected.toUpperCase()}  ${q.name}`);
  }
  console.log(`\nDone. ${all.length} benchmark queries created (inactive).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
