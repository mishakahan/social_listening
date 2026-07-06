// One-off: create the 10 agreed test-batch scout queries with controlled
// keyword/hashtag lists (faithful to Jonathan's spec — no LLM expansion).
// Clears prior seed items + scout queries for the company first so the DB
// holds exactly this test set. Queries are created INACTIVE.
import * as storage from "../storage/index.js";
import { db, tpScoutQueries, tpSeedItems } from "@workspace/db";
import { eq } from "drizzle-orm";

const COMPANY_ID = Number(process.env.REGEN_COMPANY_ID ?? "1");

interface TestQuery {
  label: string;
  geography: string;
  language: string;
  keywords: string[];
  hashtags: string[];
}

// Tier 1 — benchmark-dense categories (English, worldwide). Broader keywords ok.
// Tier 2 — Leone-specific granularity (English). Kept close to the exact term.
// Tier 3 — Italian localized. EXACT phrases Jonathan gave, minimal expansion.
const QUERIES: TestQuery[] = [
  { label: "Alcoholic beverages", geography: "Global", language: "en",
    keywords: ["alcoholic beverages", "craft cocktails", "hard seltzer", "ready to drink cocktails"],
    hashtags: ["alcoholicbeverages", "craftcocktails", "hardseltzer"] },
  { label: "Non-alcoholic beverages", geography: "Global", language: "en",
    keywords: ["non alcoholic beverages", "functional drinks", "mocktails", "prebiotic soda"],
    hashtags: ["nonalcoholic", "functionaldrinks", "mocktails"] },
  { label: "Condiments and seasonings", geography: "Global", language: "en",
    keywords: ["condiments", "seasonings", "hot sauce", "gourmet condiments"],
    hashtags: ["condiments", "seasonings", "hotsauce"] },
  { label: "Dietary supplements and nutrition", geography: "Global", language: "en",
    keywords: ["dietary supplements", "nutrition supplements", "vitamins", "wellness supplements"],
    hashtags: ["supplements", "nutrition", "vitamins"] },

  { label: "Chocolate gifting", geography: "Global", language: "en",
    keywords: ["chocolate gifting", "chocolate gifts", "chocolate gift box"],
    hashtags: ["chocolategifting", "chocolategifts", "chocolategiftbox"] },
  { label: "Gummies", geography: "Global", language: "en",
    keywords: ["gummies", "gummy candy", "gummy sweets"],
    hashtags: ["gummies", "gummycandy", "gummysweets"] },
  { label: "Functional gummies", geography: "Global", language: "en",
    keywords: ["functional gummies", "supplement gummies", "vitamin gummies"],
    hashtags: ["functionalgummies", "vitamingummies", "supplementgummies"] },

  { label: "Chocolate gifting (Italy)", geography: "IT", language: "it",
    keywords: ["regali cioccolata", "regali di cioccolato", "cioccolato regalo"],
    hashtags: ["regalicioccolato", "cioccolatoregalo"] },
  { label: "Gummies (Italy)", geography: "IT", language: "it",
    keywords: ["caramelle gommose", "gommose", "caramelle gelatina"],
    hashtags: ["caramellegommose", "gommose"] },
  { label: "Functional gummies (Italy)", geography: "IT", language: "it",
    keywords: ["gommose funzionali", "caramelle funzionali", "integratori gommose"],
    hashtags: ["gommosefunzionali", "integratorigommose"] },
];

async function main() {
  // wipe prior scout queries + seed items for a clean test set
  await db.delete(tpScoutQueries).where(eq(tpScoutQueries.companyId, COMPANY_ID));
  await db.delete(tpSeedItems).where(eq(tpSeedItems.companyId, COMPANY_ID));
  console.log("cleared prior scout queries + seed items");

  for (const q of QUERIES) {
    const seed = await storage.createSeedItem({
      companyId: COMPANY_ID,
      label: q.label,
      geography: q.geography,
      status: "committed",
    } as any);
    await storage.createScoutQuery({
      companyId: COMPANY_ID,
      seedItemId: seed.id,
      topicLabel: q.label,
      geography: q.geography,
      language: q.language,
      keywords: q.keywords,
      hashtags: q.hashtags,
      active: false,
    } as any);
    console.log(`created: ${q.label} [${q.geography}/${q.language}] ${q.keywords.length} kw, ${q.hashtags.length} tags`);
  }
  console.log(`\nDone. ${QUERIES.length} test queries created (inactive).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
