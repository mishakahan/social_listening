// Capped pilot: generate CATEGORY-level seeds for a company, expand them
// through the real fan-out, and report the exact planned Apify run count and
// projected real spend BEFORE anything fires.
//
// NO APIFY SPEND ANYWHERE IN THIS SCRIPT. Stage 1 and stage 2 make OpenAI
// calls only; stage 2 writes scout queries INACTIVE, and firing is a separate
// step (scripts/fire-company-run.ts) that requires explicit approval.
//
//   STAGE=generate COMPANY_ID=2 pnpm exec tsx --env-file=../../.env \
//     src/scripts/pilot-category-seeds.ts
//   STAGE=fanout COMPANY_ID=2 PILOT_SEEDS=0,3,7 pnpm exec tsx --env-file=../../.env \
//     src/scripts/pilot-category-seeds.ts            # dry run, prints cost
//   ... same + COMMIT=1                              # persists queries INACTIVE
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as storage from "../storage/index.js";
import {
  generateSeedCandidates,
  generateScoutQueriesForSeed,
  type CompanyContext,
  type SeedCandidateItem,
  type WatchTopic,
} from "../services/radar-setup-bot.js";
import {
  planPlatformsForQuery,
  estimateBatchCostUsd,
  effectiveRunFor,
  type PlannedRun,
} from "../services/launch-batch.js";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "2");
const STAGE = process.env.STAGE ?? "generate";
const COMMIT = process.env.COMMIT === "1";

// Read the brief + watch topics the client actually gave us, from the most
// recent COMMITTED candidate — the same input the old product-specific seeds
// were generated from, so the only thing that changes is the prompt.
async function loadBriefInput(): Promise<{ brief: string; watchTopics: WatchTopic[] }> {
  const r = await db.execute(sql`
    select brief_snapshot, watch_topics_snapshot
    from tp_seed_candidates
    where company_id = ${COMPANY_ID} and status = 'committed'
    order by created_at desc limit 1
  `);
  const row = (r.rows as any[])[0];
  if (!row) throw new Error(`No committed tp_seed_candidates for company ${COMPANY_ID}`);
  return {
    brief: String(row.brief_snapshot ?? ""),
    watchTopics: (row.watch_topics_snapshot ?? []) as WatchTopic[],
  };
}

async function loadLatestDraft(): Promise<{
  id: number;
  payload: SeedCandidateItem[];
  companyContext: CompanyContext;
}> {
  const r = await db.execute(sql`
    select id, payload, company_context_snapshot
    from tp_seed_candidates
    where company_id = ${COMPANY_ID} and status = 'draft'
    order by created_at desc limit 1
  `);
  const row = (r.rows as any[])[0];
  if (!row) throw new Error(`No draft candidate for company ${COMPANY_ID} — run STAGE=generate first`);
  return {
    id: Number(row.id),
    payload: (row.payload ?? []) as SeedCandidateItem[],
    companyContext: (row.company_context_snapshot ?? {}) as CompanyContext,
  };
}

async function stageGenerate() {
  const { brief, watchTopics } = await loadBriefInput();
  console.log(
    `company ${COMPANY_ID}: brief ${brief.length} chars, ${watchTopics.length} watch topics\n` +
      `generating CATEGORY-level seeds (OpenAI only, no Apify, saved as DRAFT)\n`
  );

  const { companyContext, seedItems } = await generateSeedCandidates(
    brief,
    COMPANY_ID,
    await storage.getOrCreateDefaultUserId(),
    watchTopics
  );

  const candidate = await storage.createSeedCandidates({
    companyId: COMPANY_ID,
    userId: await storage.getOrCreateDefaultUserId(),
    payload: seedItems as any,
    briefSnapshot: brief,
    companyContextSnapshot: companyContext as Record<string, any>,
    watchTopicsSnapshot: watchTopics,
    status: "draft",
  });

  console.log(`draft candidate id=${candidate.id}, ${seedItems.length} seeds\n`);
  seedItems.forEach((s, i) => {
    const langs = (s.seedQueries ?? []).map((q) => q.language).join(",");
    console.log(
      `  [${String(i).padStart(2)}] ${String(s.label).padEnd(34)} geo=${String(s.geography).padEnd(7)} langs=${langs.padEnd(10)} watchTopic="${s.watchTopic ?? ""}"`
    );
  });

  // The language-duplication bug (commit f3c9505) made one seed fan out into
  // 4-7 language buckets, multiplying cost ~2.3x. Check the spread here,
  // before anything is expanded or fired.
  const multiLang = seedItems.filter((s) => (s.seedQueries ?? []).length > 1);
  console.log(
    `\nlanguage sanity: ${multiLang.length}/${seedItems.length} seeds have >1 language bucket` +
      (multiLang.length ? ` — INSPECT: ${multiLang.map((s) => s.label).join(", ")}` : " — clean")
  );
}

async function stageFanout() {
  const { payload, companyContext } = await loadLatestDraft();
  const picked = (process.env.PILOT_SEEDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < payload.length);
  if (picked.length === 0) throw new Error(`PILOT_SEEDS must name valid indices 0..${payload.length - 1}`);

  console.log(
    `expanding ${picked.length} seed(s) through the real fan-out (OpenAI only, no Apify)\n` +
      `COMMIT=${COMMIT ? "1 — queries WILL be written INACTIVE" : "0 — dry run, nothing written"}\n`
  );

  const plannedQueries: { label: string; language: string; keywords: string[]; hashtags: string[]; geography: string; watchTopic: string | null; seedIndex: number }[] = [];

  for (const idx of picked) {
    const seed = payload[idx]!;
    console.log(`--- [${idx}] ${seed.label} (${seed.geography}) ---`);
    const generated = await generateScoutQueriesForSeed(seed, companyContext);
    for (const g of generated) {
      console.log(`    [${g.language}] ${g.keywords.length} keywords, ${g.hashtags.length} hashtags`);
      console.log(`      ${g.keywords.slice(0, 12).join(", ")}${g.keywords.length > 12 ? ", ..." : ""}`);
      plannedQueries.push({
        label: seed.label,
        language: g.language,
        keywords: g.keywords,
        hashtags: g.hashtags,
        geography: seed.geography,
        watchTopic: (seed as any).watchTopic ?? null,
        seedIndex: idx,
      });
    }
  }

  // Exact planned Apify runs, using the SAME pure planner launchBatch() uses,
  // so this projection is what would actually fire — not an approximation.
  console.log(`\n=== PLANNED APIFY RUNS (planPlatformsForQuery, the real planner) ===`);
  const allPlanned: PlannedRun[] = [];
  for (const q of plannedQueries) {
    const query = {
      keywords: q.keywords,
      hashtags: q.hashtags,
      language: q.language,
      geography: q.geography,
      topicLabel: q.label,
    };
    const plan = planPlatformsForQuery(query);
    const runs = plan.map((p) => effectiveRunFor(p, query));
    const byPlat: Record<string, number> = {};
    for (const p of plan) byPlat[p.platform] = (byPlat[p.platform] ?? 0) + 1;
    const est = estimateBatchCostUsd(runs);
    console.log(
      `  ${q.label.padEnd(30)} [${q.language}] ${String(q.keywords.length).padStart(3)} kw -> ` +
        `${String(plan.length).padStart(3)} runs ${JSON.stringify(byPlat)} = $${est.totalUsd.toFixed(2)}`
    );
    allPlanned.push(...runs);
  }

  const est = estimateBatchCostUsd(allPlanned);
  console.log(`\n--- TOTAL ---`);
  for (const [platform, e] of Object.entries(est.byPlatform)) {
    console.log(
      `  ${platform.padEnd(11)} ${String(e.runs).padStart(3)} runs ${String(e.records.toLocaleString()).padStart(8)} records = $${e.usd.toFixed(2)}`
    );
  }
  const totalRecords = Object.values(est.byPlatform).reduce((s, e) => s + e.records, 0);
  console.log(
    `  ${"TOTAL".padEnd(11)} ${String(allPlanned.length).padStart(3)} runs ${String(totalRecords.toLocaleString()).padStart(8)} records = $${est.totalUsd.toFixed(2)}`
  );
  console.log(
    `  caps in effect: TIKTOK_MAX_KEYWORD_RUNS=${process.env.TIKTOK_MAX_KEYWORD_RUNS ?? "8 (default)"} ` +
      `YOUTUBE_MAX_KEYWORDS=${process.env.YOUTUBE_MAX_KEYWORDS ?? "8 (default)"} ` +
      `YOUTUBE_RESULT_CAP=${process.env.YOUTUBE_RESULT_CAP ?? "40 (default)"} ` +
      `X_KEYWORDS_PER_RUN=${process.env.X_KEYWORDS_PER_RUN ?? "10 (default)"} ` +
      `BACKFILL_RESULT_CAP=${process.env.BACKFILL_RESULT_CAP ?? "200 (default)"}`
  );
  console.log(
    `\n  NOTE: pre-flight projection from measured per-RECORD rates (tp_actor_runs\n` +
      `  cost_usd x4, since that column undercounts real billing ~4x). The Apify\n` +
      `  CONSOLE is the only ground truth for real spend — check it after firing.`
  );

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written, nothing fired.`);
    return;
  }

  for (const idx of picked) {
    const seed = payload[idx]!;
    const mine = plannedQueries.filter((q) => q.seedIndex === idx);
    if (mine.length === 0) continue;
    const seedItem = await storage.createSeedItem({
      companyId: COMPANY_ID,
      label: seed.label,
      description: seed.description,
      geography: seed.geography,
      productCategoryLink: seed.productCategoryLink,
      territoryTag: seed.territoryTag,
      watchTopic: (seed as any).watchTopic ?? null,
      strategicCentrality: seed.strategicCentrality,
      actionableAt: seed.actionableAt,
      groundedIn: seed.groundedIn,
      status: "pending",
    } as any);
    for (const q of mine) {
      await storage.createScoutQuery({
        companyId: COMPANY_ID,
        seedItemId: seedItem.id,
        topicLabel: seed.label,
        watchTopic: q.watchTopic,
        geography: q.geography,
        language: q.language,
        keywords: q.keywords,
        hashtags: q.hashtags,
        active: false,
      } as any);
    }
    console.log(`committed seed "${seed.label}" -> ${mine.length} scout query(ies), INACTIVE`);
  }
  console.log(`\nDone. Queries are INACTIVE and nothing has been fired.`);
}

async function main() {
  if (STAGE === "generate") await stageGenerate();
  else if (STAGE === "fanout") await stageFanout();
  else throw new Error(`Unknown STAGE "${STAGE}" (expected generate|fanout)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
