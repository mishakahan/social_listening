// Regenerate the Leone scout queries through the taxonomy fan-out.
//
// The existing queries were hand-written (see seed-test-queries.ts, "no LLM
// expansion"), so they never exercised the fan-out: that is why nothing ever
// searched soju. This rebuilds them from the seed labels via
// generateScoutQueriesForSeed, which unions several passes per topic.
//
// Scope: only non-BENCH queries are touched. The BENCH:* set is the Schedule B
// backtest fixture and must stay byte-identical or the baseline is no longer
// comparable. Previous queries are archived to docs/scout-queries-pre-fanout.json.
//
// Writes queries INACTIVE. Nothing scrapes; no Apify spend. Review the list,
// then activate.
import { db, tpScoutQueries, tpSeedItems } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as storage from "../storage/index.js";
import { generateScoutQueriesForSeed, type CompanyContext, type SeedCandidateItem } from "../services/radar-setup-bot.js";

const COMPANY_ID = Number(process.env.REGEN_COMPANY_ID ?? "1");
const DRY_RUN = process.env.REGEN_DRY_RUN === "true";

// Languages to generate per topic. Italian topics keep their localisation.
function languagesFor(label: string, geography: string): string[] {
  if (geography === "IT" || /\(Italy\)/i.test(label)) return ["it"];
  return ["en"];
}

async function main() {
  const ctx = (await storage.getPipelineConfig(COMPANY_ID)) as any;
  const companyContext: CompanyContext = {
    companyName: "Leone",
    vertical: "confectionery",
    clientSegments: [],
    productCategories: ["gummies", "chocolate", "confectionery"],
    targetGeographies: ["Global", "IT"],
    operationalCapabilities: [],
    ipAssets: [],
    distributionNetworks: [],
    skillsAndHr: [],
    supplyChain: [],
    namedClients: [],
    namedCompetitors: [],
    strategicPriorities: ["premium gifting", "functional wellness", "international growth"],
    brandPositioning: null,
    brandingGuidelines: null,
    npdPhases: [],
    innovationPhases: [],
  };
  void ctx;

  const seeds = (await db.select().from(tpSeedItems).where(eq(tpSeedItems.companyId, COMPANY_ID))) as any[];
  const targets = seeds.filter((s) => !String(s.label).startsWith("BENCH:"));
  console.log(`${targets.length} non-BENCH seed topics to regenerate (BENCH set left untouched)\n`);

  for (const seed of targets) {
    const langs = languagesFor(seed.label, seed.geography);
    const candidate: SeedCandidateItem = {
      label: seed.label,
      description: seed.description ?? "",
      geography: seed.geography,
      productCategoryLink: seed.productCategoryLink ?? "",
      territoryTag: seed.territoryTag ?? "",
      strategicCentrality: seed.strategicCentrality ?? 50,
      actionableAt: seed.actionableAt ?? "",
      groundedIn: seed.groundedIn ?? [],
      seedQueries: langs.map((l) => ({ language: l, keywords: [], hashtags: [] })),
    };

    const generated = await generateScoutQueriesForSeed(candidate, companyContext);
    for (const g of generated) {
      console.log(`\n=== ${seed.label} [${seed.geography}/${g.language}] ===`);
      console.log(`  ${g.keywords.length} keywords: ${g.keywords.join(", ")}`);
      console.log(`  ${g.hashtags.length} hashtags: ${g.hashtags.join(", ")}`);
    }

    if (DRY_RUN) continue;

    // Replace this seed's existing queries with the fan-out result.
    const existing = (await db
      .select()
      .from(tpScoutQueries)
      .where(eq(tpScoutQueries.seedItemId, seed.id))) as any[];
    for (const e of existing) {
      await db.delete(tpScoutQueries).where(eq(tpScoutQueries.id, e.id));
    }
    for (const g of generated) {
      await storage.createScoutQuery({
        companyId: COMPANY_ID,
        seedItemId: seed.id,
        topicLabel: seed.label,
        geography: seed.geography,
        language: g.language,
        keywords: g.keywords,
        hashtags: g.hashtags,
        active: false,
      } as any);
    }
  }

  console.log(DRY_RUN ? "\nDRY RUN — nothing written." : "\nDone. Queries written INACTIVE — review, then activate.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
