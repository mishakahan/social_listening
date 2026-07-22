// Read-only: dump Leone's current watch topics (seed items) and the scout
// queries derived from them, so we can confirm the list with Jonathan before
// the full paid scrape.
import { db, tpSeedItems, tpScoutQueries } from "@workspace/db";
import { eq } from "drizzle-orm";

const COMPANY = 1;

async function main() {
  const seeds = await db.select().from(tpSeedItems).where(eq(tpSeedItems.companyId, COMPANY));
  const queries = await db.select().from(tpScoutQueries).where(eq(tpScoutQueries.companyId, COMPANY));

  console.log(`\n=== SEED ITEMS (watch topics): ${seeds.length} ===`);
  for (const s of seeds as any[]) {
    console.log(`- [${s.status ?? '?'}] ${s.label ?? s.topicLabel ?? s.name} `
      + `| geo=${s.geography ?? '-'} | catLink=${s.productCategoryLink ?? '-'} `
      + `| territory=${s.territoryTag ?? '-'} | centrality=${s.strategicCentrality ?? '-'}`);
  }

  console.log(`\n=== SCOUT QUERIES: ${queries.length} (active shown first) ===`);
  const sorted = (queries as any[]).sort((a, b) => Number(b.active) - Number(a.active));
  for (const q of sorted) {
    const kw = Array.isArray(q.keywords) ? q.keywords.join(', ') : q.keywords;
    const ht = Array.isArray(q.hashtags) ? q.hashtags.join(', ') : q.hashtags;
    console.log(`- [${q.active ? 'ACTIVE' : 'inactive'}] topic="${q.topicLabel ?? q.label}" lang=${q.language ?? '-'}`);
    console.log(`    keywords: ${kw}`);
    if (ht) console.log(`    hashtags: ${ht}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
