// Recover scraped data that was paid for but never ingested.
//
// What happened: the API server was started while .env still held a stale Apify
// token, so every status poll 401'd and the run rows stayed frozen at "running"
// with 0 records. Reading that as "nothing is completing", the runs were aborted
// and the rows deleted — but the runs had in fact SUCCEEDED, and their datasets
// are still on Apify. Deleting the rows only destroyed our POINTERS to them.
//
// This rebuilds those pointers. Apify keeps each run's INPUT in its key-value
// store, and that input carries the exact keywords we sent, so each run can be
// matched back to the scout query that produced it. We then recreate the run row
// and hand it to the normal ingestion path.
//
// Costs nothing: reading finished datasets bills no compute. No actor is started.
import { db, tpScoutQueries, tpActorRuns } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import * as storage from "../storage/index.js";
import { ingestActorRun, ingestGoogleTrendsRun } from "../services/ingestion.js";
import { getApifyClient } from "../services/apify.js";

const COMPANY_ID = Number(process.env.RECOVER_COMPANY_ID ?? "1");
const SINCE = process.env.RECOVER_SINCE ?? "2026-07-17T05:30:00.000Z";
const DRY_RUN = process.env.RECOVER_DRY_RUN === "true";

// actorId -> our platform name. Apify returns actId, not the slug.
const ACTOR_PLATFORM: Record<string, { platform: string; runMode: string; slug: string }> = {
  "apify~instagram-scraper": { platform: "instagram", runMode: "backfill:ig_posts", slug: "apify/instagram-scraper" },
  "scrapeforge~tiktok-posts": { platform: "tiktok", runMode: "backfill:tiktok", slug: "scrapeforge/tiktok-posts" },
  "trudax~reddit-scraper-lite": { platform: "reddit", runMode: "backfill:reddit_search", slug: "trudax/reddit-scraper-lite" },
  "xquik~x-tweet-scraper": { platform: "x", runMode: "backfill:x_search", slug: "xquik/x-tweet-scraper" },
  "streamers~youtube-scraper": { platform: "youtube", runMode: "backfill:youtube_search", slug: "streamers/youtube-scraper" },
  "apify~google-trends-scraper": { platform: "google_trends", runMode: "backfill:google_trends", slug: "apify/google-trends-scraper" },
};

// Pull the terms a run was launched with, whatever shape the actor uses.
function termsFromInput(input: any): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const key of ["searchTerms", "searchQueries", "keywords"]) {
    if (Array.isArray(input[key])) out.push(...input[key].map(String));
  }
  for (const key of ["keyword", "searchQuery"]) {
    if (typeof input[key] === "string" && input[key]) out.push(input[key]);
  }
  // IG sends hashtag explore URLs rather than terms.
  if (Array.isArray(input.directUrls)) {
    for (const u of input.directUrls) {
      const m = String(u).match(/explore\/tags\/([^/]+)/);
      if (m) out.push(decodeURIComponent(m[1]));
    }
  }
  return out.map((t) => t.trim().toLowerCase()).filter(Boolean);
}

async function main() {
  const client = getApifyClient();
  const queries = (await db
    .select()
    .from(tpScoutQueries)
    .where(eq(tpScoutQueries.companyId, COMPANY_ID))) as any[];

  // Index every query's terms so a run's input can be traced back to it.
  // Longest match wins: a query's full keyword list is far more distinctive than
  // any single shared word.
  const index: { q: any; terms: Set<string> }[] = queries.map((q) => ({
    q,
    terms: new Set(
      [...(q.keywords ?? []), ...(q.hashtags ?? [])].map((t: string) =>
        String(t).trim().toLowerCase()
      )
    ),
  }));

  const matchQuery = (terms: string[]) => {
    let best: any = null;
    let bestScore = 0;
    for (const { q, terms: qt } of index) {
      let score = 0;
      for (const t of terms) if (qt.has(t)) score++;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    return bestScore > 0 ? best : null;
  };

  console.log("fetching run list from Apify...");
  const { items } = await client.runs().list({ limit: 600, desc: true });
  const todays = items.filter(
    (r: any) => r.status === "SUCCEEDED" && new Date(r.startedAt) >= new Date(SINCE)
  );
  console.log(`${todays.length} SUCCEEDED runs since ${SINCE}\n`);

  let recovered = 0, ingested = 0, skipped = 0, unmatched = 0, records = 0;

  for (const r of todays as any[]) {
    const actorKey = String(r.actId);
    // actId is an opaque id, so resolve the actor to get its slug.
    let meta = ACTOR_PLATFORM[actorKey];
    if (!meta) {
      try {
        const actor = await client.actor(r.actId).get();
        const slug = `${(actor as any)?.username}/${(actor as any)?.name}`;
        meta = Object.values(ACTOR_PLATFORM).find((m) => m.slug === slug)!;
        if (meta) ACTOR_PLATFORM[actorKey] = meta;
      } catch { /* fall through */ }
    }
    if (!meta) { skipped++; continue; }

    // Already recovered? apifyRunId is the idempotency key.
    const existing = await db
      .select()
      .from(tpActorRuns)
      .where(and(eq(tpActorRuns.companyId, COMPANY_ID), eq(tpActorRuns.apifyRunId, r.id)))
      .limit(1);
    if (existing.length > 0) { skipped++; continue; }

    let input: any = null;
    try {
      input = await client.keyValueStore(r.defaultKeyValueStoreId).getRecord("INPUT");
      input = (input as any)?.value ?? input;
    } catch { /* no input, cannot match */ }

    const terms = termsFromInput(input);
    const q = matchQuery(terms);
    if (!q) { unmatched++; continue; }

    if (DRY_RUN) {
      console.log(`  [dry] ${meta.platform.padEnd(14)} -> "${q.topicLabel}" (${terms.slice(0,2).join(", ")})`);
      recovered++;
      continue;
    }

    const run = await storage.createActorRun({
      companyId: COMPANY_ID,
      scoutQueryId: q.id,
      actorSlug: meta.slug,
      platform: meta.platform,
      runMode: meta.runMode,
      status: "succeeded",
      apifyRunId: r.id,
      apifyDatasetId: r.defaultDatasetId,
      inputPayload: input ?? {},
      startedAt: r.startedAt ? new Date(r.startedAt) : undefined,
      completedAt: r.finishedAt ? new Date(r.finishedAt) : undefined,
      costUsd: (r as any)?.usageTotalUsd ?? null,
    } as any);
    recovered++;

    // Hand to the normal ingestion path so normalisation/filters apply as usual.
    try {
      const ds = await client.dataset(r.defaultDatasetId).listItems();
      const data = ds.items ?? [];
      const fresh = await storage.getActorRun(run.id);
      if (meta.platform === "google_trends") await ingestGoogleTrendsRun(fresh!, data as any);
      else await ingestActorRun(fresh!, data as any);
      records += data.length;
      ingested++;
      if (ingested % 25 === 0) console.log(`  ingested ${ingested}/${todays.length} runs, ${records} records so far`);
    } catch (e: any) {
      console.error(`  ingest failed for ${r.id}: ${e?.message ?? e}`);
    }
  }

  console.log(`\nrecovered rows: ${recovered}`);
  console.log(`ingested runs:  ${ingested}`);
  console.log(`records:        ${records}`);
  console.log(`skipped:        ${skipped} (already present / unknown actor)`);
  console.log(`unmatched:      ${unmatched} (input did not map to a query)`);
  console.log(DRY_RUN ? "\nDRY RUN — nothing written." : "\nDONE");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
