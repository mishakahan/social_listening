import { randomUUID } from "node:crypto";
import * as storage from "../storage/index.js";
import { logger } from "../lib/logger.js";
import {
  getApifyClient,
  getActorMemoryMb,
  getWebhookBaseUrl,
  buildActorInput,
} from "./apify.js";
import { runEntityExtraction } from "./entity-extraction.js";
import { runTimeseriesAggregation } from "./timeseries.js";
import { runStateMachine } from "./state-machine.js";

type PlatformPlan = {
  platform: string;
  runMode: string;
  actorSlug: string;
  // Restrict this run to a single keyword. Used for actors that accept only one
  // search term (TikTok), so the query's full keyword list is covered by N runs
  // instead of being silently truncated to the first.
  keywordOverride?: string;
  // Restrict this run to a keyword subset (chunk). Used for actors that accept
  // a keyword ARRAY but were previously handed the entire query's keyword list
  // in one capped run (YouTube, X) — that starved every individual keyword of
  // the shared RESULT_CAP. Kept distinct from `keywordOverride` (a single
  // string) rather than overloading it, since "one keyword" and "a chunk of
  // keywords" are different shapes and conflating them invites bugs where a
  // single-element array silently means something else than a bare string.
  keywordsOverride?: string[];
};

// The TikTok actor takes ONE keyword per run, so buildActorInput used keywords[0]
// and dropped the rest: a 33-keyword "Alcoholic beverages" query only ever
// searched "beer" on TikTok, and soju never reached the platform where a soju
// trend would most obviously live. Fan out to one run per keyword instead.
// Affordable because TikTok is the cheapest actor we run by an order of
// magnitude — measured $0.0096/run, vs $0.39 YouTube and $0.27 Instagram — so
// covering all 466 keywords costs ~$4.4 rather than the ~1 cent per extra term
// it looks like it should. Capped so a runaway fan-out cannot surprise us.
//
// This is the lever for TikTok's share of the platform mix: lowering it caps
// how many keywords TikTok covers (and therefore how many entities/signals it
// can contribute) without touching any other platform's behaviour.
//
// Default is deliberately low (8, not 80). Measured on company 2 (14 queries,
// 828 keywords, real per-run cost $0.10 TikTok / $1.00 IG / $0.50 Reddit /
// $1.50 YouTube / $0.02 X): at the previous defaults (TikTok 80, YouTube chunk
// 40, X chunk 20) TikTok alone was ~828 runs (~$83) and, worse, TikTok's own
// run count grows near-linearly with the cap since every one of these queries
// has 36+ keywords — every unit of cap costs ~$1.40 (14 queries x $0.10)
// company-wide. TikTok already produces the least evidence per dollar of any
// platform here (13.8 distinct entities/run measured), while YouTube's one
// starved run still surfaced 320 entities — so cap TikTok down hard and spend
// the freed budget on YouTube/X chunking below. At 8, company 2's TikTok cost
// drops from ~$42 (the historical run, which itself used TIKTOK_MAX_KEYWORD_
// RUNS=30) to ~$11, funding a 19-run YouTube fan-out while keeping the whole
// company-2 sweep at ~$62 — under the $64 pre-rebalance cost and under the
// $APIFY_MAX_BATCH_USD preflight ceiling below. Raise this per-run if a
// client engagement specifically needs deep TikTok keyword coverage.
const TIKTOK_MAX_KEYWORD_RUNS =
  Number(process.env.TIKTOK_MAX_KEYWORD_RUNS ?? "8") || 8;

// YouTube and X used to receive the ENTIRE query keyword list in a single run
// (searchQueries: kws / searchTerms: kws), sharing one RESULT_CAP (200) across
// however many keywords the query had — on company 2 that was 828 keywords
// crammed into one YouTube run. TikTok's one-run-per-keyword fan-out doesn't
// apply as-is: YouTube/X actors DO accept a keyword array, and one run per
// keyword would multiply their run count (and therefore cost — YouTube is the
// most expensive actor we run, ~$1.50/run) far more than TikTok's fan-out does
// (~$0.10/run). So instead of one keyword per run, we chunk the keyword list
// into N-keyword groups and give each chunk its own run + RESULT_CAP — the
// same fix (more runs, so the cap isn't shared across the whole list) at a
// coarser, cost-appropriate granularity.
//
// Defaults are chosen to be budget-neutral against the historical measured
// sweep, not merely "bigger than before": with TIKTOK_MAX_KEYWORD_RUNS=8
// above and X chunked at 10, a YouTube chunk of 60 (-> up to 2 runs for every
// one of company 2's 14 queries, since none has more than 80 keywords, zero
// truncation) gives 19 YouTube runs (~$28.50) — YouTube's capacity (runs x
// the 200 cap) rises from 200 to 3,800, a 19x increase, targeting exactly the
// platform the starvation bug hurt most (320 entities from one capped run).
// Company 2's full projected sweep under these defaults: $62.42, under both
// the historical $64.18 and the $APIFY_MAX_BATCH_USD ceiling. Re-run
// src/scripts/project-platform-mix.ts after changing any of these — the
// tradeoffs are non-obvious (TikTok cost scales ~linearly with its cap here
// since every query has 36+ keywords) and should be checked empirically, not
// assumed.
//
// *_MAX_KEYWORD_RUNS is a hard per-query cap (mirroring TIKTOK_MAX_KEYWORD_RUNS)
// so a large keyword list can't silently explode the run count/bill; when it
// binds, the caller logs a warning naming the dropped keyword count rather
// than dropping them silently. Set well above what today's queries need (10
// YouTube runs = up to 600 keywords/query, 20 X runs = up to 200/query) so it
// acts as a backstop against future keyword-list growth, not a lever that
// bites under normal operation — the *_KEYWORDS_PER_RUN chunk sizes above are
// the actual cost/coverage lever.
const YOUTUBE_KEYWORDS_PER_RUN =
  Number(process.env.YOUTUBE_KEYWORDS_PER_RUN ?? "60") || 60;
const YOUTUBE_MAX_KEYWORD_RUNS =
  Number(process.env.YOUTUBE_MAX_KEYWORD_RUNS ?? "10") || 10;
const X_KEYWORDS_PER_RUN =
  Number(process.env.X_KEYWORDS_PER_RUN ?? "10") || 10;
const X_MAX_KEYWORD_RUNS =
  Number(process.env.X_MAX_KEYWORD_RUNS ?? "20") || 20;

export type KeywordChunkResult = {
  // One entry per run; each entry is the keyword subset for that run.
  chunks: string[][];
  // True when `maxRuns` capped the chunk count and some trailing keywords
  // were dropped (never silently — see droppedKeywords).
  truncated: boolean;
  // The keywords left out of `chunks` because of the maxRuns cap. Empty
  // whenever `truncated` is false.
  droppedKeywords: string[];
};

// Pure, side-effect-free keyword chunker shared by YouTube and X fan-out.
// Splits `keywords` into groups of at most `chunkSize`, then caps the number
// of groups (runs) at `maxRuns`, reporting anything that cap dropped instead
// of silently discarding it.
export function chunkKeywords(
  keywords: string[],
  chunkSize: number,
  maxRuns: number
): KeywordChunkResult {
  const cleaned = keywords.map((k) => k.trim()).filter((k) => k.length > 0);
  if (cleaned.length === 0) {
    return { chunks: [], truncated: false, droppedKeywords: [] };
  }

  const size = Math.max(1, Math.floor(chunkSize));
  const allChunks: string[][] = [];
  for (let i = 0; i < cleaned.length; i += size) {
    allChunks.push(cleaned.slice(i, i + size));
  }

  const cap = Math.max(1, Math.floor(maxRuns));
  if (allChunks.length <= cap) {
    return { chunks: allChunks, truncated: false, droppedKeywords: [] };
  }

  return {
    chunks: allChunks.slice(0, cap),
    truncated: true,
    droppedKeywords: allChunks.slice(cap).flat(),
  };
}

// ---------------------------------------------------------------------------
// Pre-flight cost gate
// ---------------------------------------------------------------------------
//
// This project has twice badly overspent: one scrape was estimated at $12 and
// actually cost $74, another was estimated at $18 and cost ~$60. Both
// estimates came from `tp_actor_runs.cost_usd`, which undercounts real Apify
// billing by roughly 4x. The Apify token used here also cannot read account
// limits (`/users/me` and `/users/me/limits` both return empty for it), so
// there is no external guard against a runaway batch — this is the only one.
//
// REAL_COST_PER_RUN_USD is real-spend, NOT tp_actor_runs.cost_usd (roughly
// 4x that column's figure) — measured against actual Apify invoices. The
// Apify console (https://console.apify.com/billing) is the only ground
// truth for actual spend; this table is our best pre-flight approximation
// of it, not a substitute for checking the console after a batch runs.
//
// Google Trends is priced per RECORD, not per run — its actor has no
// per-run result cap the way the others do (see buildActorInput's
// "apify/google-trends-scraper" case: no maxResults/RESULT_CAP, just
// `searchTerms: kws.slice(0, 5)`). We approximate its per-run cost as the
// same 5-term cap buildActorInput itself applies, at $0.10/record — a
// deliberately conservative (upper-bound-leaning) proxy, acceptable because
// Google Trends is off by default (ENABLE_GOOGLE_TRENDS) and essentially
// never appears in a real plan.
const REAL_COST_PER_RUN_USD: Record<string, number> = {
  tiktok: 0.1,
  instagram: 1.0,
  reddit: 0.5,
  youtube: 1.5,
  x: 0.02,
  google_trends: 0.5, // 5 terms/run cap x $0.10/record
};

// Hard ceiling on a single batch's estimated real spend. Default ($25) sits
// comfortably above a normal sweep (company 2's full 14-query sweep projects
// to ~$62 under the defaults above — wait, that's ABOVE $25; see note below)
// and far below a runaway. Deliberately env-overridable (so a larger,
// intentional sweep isn't permanently blocked) but with NO silent "no limit"
// fallback: if APIFY_MAX_BATCH_USD is unset it still defaults to $25, it
// never defaults to Infinity.
//
// NOTE: company 2's full-sweep projection (~$62, see
// src/scripts/project-platform-mix.ts) exceeds the $25 default on purpose —
// $25 is sized for the per-chunk batches fire-company-run.ts actually issues
// (2 queries at a time, ~$9-10 each under current defaults), not a
// launch-everything-at-once call. A single `launchBatch` covering all of a
// company's queries at once is exactly the "large keyword set" scenario this
// gate exists to catch before it fires, not paper over with a high ceiling.
const APIFY_MAX_BATCH_USD =
  Number(process.env.APIFY_MAX_BATCH_USD ?? "25") || 25;

export type BatchCostEstimate = {
  totalUsd: number;
  byPlatform: Record<string, { runs: number; usd: number }>;
};

// Pure: estimate a batch's real Apify spend from the platform plan about to
// be fired (one entry per planned run, already fanned out/chunked). Throws
// if any planned platform has no entry in REAL_COST_PER_RUN_USD — an unknown
// platform must never be silently treated as free; add a measured rate
// before it can be launched.
export function estimateBatchCostUsd(
  platforms: { platform: string }[]
): BatchCostEstimate {
  const byPlatform: Record<string, { runs: number; usd: number }> = {};
  for (const p of platforms) {
    const rate = REAL_COST_PER_RUN_USD[p.platform];
    if (rate === undefined) {
      throw new Error(
        `No real-cost rate for platform "${p.platform}" in REAL_COST_PER_RUN_USD — ` +
          `refusing to estimate batch cost rather than silently assuming it's free. ` +
          `Add a measured per-run (or per-record, as done for google_trends) rate ` +
          `before launching a batch that includes this platform.`
      );
    }
    const entry = byPlatform[p.platform] ?? { runs: 0, usd: 0 };
    entry.runs += 1;
    entry.usd += rate;
    byPlatform[p.platform] = entry;
  }
  const totalUsd = Object.values(byPlatform).reduce((s, e) => s + e.usd, 0);
  return { totalUsd, byPlatform };
}

// Pure: throws when `estimate.totalUsd` exceeds `ceilingUsd`, naming the
// estimate, the ceiling, and the full per-platform breakdown so the failure
// is actionable ("which platform is driving this") rather than just
// "batch too expensive." Callers must check this BEFORE creating any DB row
// or making any Apify call — never fire part of a batch and abort partway.
export function enforceBatchCostCeiling(
  estimate: BatchCostEstimate,
  ceilingUsd: number
): void {
  if (estimate.totalUsd <= ceilingUsd) return;
  const breakdown = Object.entries(estimate.byPlatform)
    .map(([platform, e]) => `${platform}: ${e.runs} runs = $${e.usd.toFixed(2)}`)
    .join(", ");
  throw new Error(
    `Apify batch cost estimate $${estimate.totalUsd.toFixed(2)} exceeds ` +
      `APIFY_MAX_BATCH_USD ceiling of $${ceilingUsd.toFixed(2)}. Breakdown: ` +
      `${breakdown}. Aborted before launching anything — raise ` +
      `APIFY_MAX_BATCH_USD (env) if this batch is intentional, or reduce the ` +
      `keyword/query scope.`
  );
}

// Exported (read-only) so a projection script can compute planned run counts
// per platform for real committed queries without launching anything.
export function planPlatformsForQuery(query: {
  keywords: string[] | null;
  language: string | null;
  geography: string | null;
  topicLabel: string | null;
}): PlatformPlan[] {
  const platforms: PlatformPlan[] = [];
  // IG is the cost driver (~85% of spend). Posts alone carry the hashtag
  // signal; reels are dropped to halve IG cost. Re-add if reels prove needed.
  platforms.push({ platform: "instagram", runMode: "backfill:ig_posts", actorSlug: "apify/instagram-scraper" });
  const tiktokKeywords = (query.keywords ?? [])
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .slice(0, TIKTOK_MAX_KEYWORD_RUNS);
  if (tiktokKeywords.length === 0) {
    // No keywords: fall back to one run, which buildActorInput fills from the
    // topic label.
    platforms.push({ platform: "tiktok", runMode: "backfill:tiktok", actorSlug: "scrapeforge/tiktok-posts" });
  } else {
    for (const keyword of tiktokKeywords) {
      platforms.push({
        platform: "tiktok",
        runMode: "backfill:tiktok",
        actorSlug: "scrapeforge/tiktok-posts",
        keywordOverride: keyword,
      });
    }
  }
  if (query.keywords && query.keywords.length > 0 && query.language !== "zh-CN") {
    // reddit-scraper-lite is recent-only but reliably returns data; the
    // archive actor (benthepythondev) promised date backfill but returned 0
    // even on direct calls, so we use the lite scraper until a working
    // date-capable Reddit actor is found. (Mapping for the archive actor is
    // kept in buildActorInput for when that phase comes.) Reddit already
    // fans a single run out across its full keyword list internally (one
    // search per keyword inside buildActorInput), so it doesn't need the
    // multi-run chunking below.
    platforms.push({ platform: "reddit", runMode: "backfill:reddit_search", actorSlug: "trudax/reddit-scraper-lite" });

    // X: free-text keyword search with a real since/until date window.
    // Chunked across multiple runs (see X_KEYWORDS_PER_RUN above) so the
    // shared RESULT_CAP isn't split across the whole keyword list.
    const xChunks = chunkKeywords(query.keywords, X_KEYWORDS_PER_RUN, X_MAX_KEYWORD_RUNS);
    if (xChunks.truncated) {
      logger.warn(
        { topicLabel: query.topicLabel, droppedKeywordCount: xChunks.droppedKeywords.length },
        "X_MAX_KEYWORD_RUNS capped this query's X fan-out; some keywords were dropped from X coverage"
      );
    }
    for (const chunk of xChunks.chunks) {
      platforms.push({ platform: "x", runMode: "backfill:x_search", actorSlug: "xquik/x-tweet-scraper", keywordsOverride: chunk });
    }

    // YouTube: deep date-queryable history — the main lever for the depth the
    // significance test needs (unlike recent-only IG/Reddit). Chunked across
    // multiple runs (see YOUTUBE_KEYWORDS_PER_RUN above) for the same reason
    // as X: a single run sharing RESULT_CAP across the whole keyword list
    // starved every individual keyword (828 keywords -> 1 capped run on
    // company 2, yielding 320 entities off a cap of 200 total items).
    const ytChunks = chunkKeywords(query.keywords, YOUTUBE_KEYWORDS_PER_RUN, YOUTUBE_MAX_KEYWORD_RUNS);
    if (ytChunks.truncated) {
      logger.warn(
        { topicLabel: query.topicLabel, droppedKeywordCount: ytChunks.droppedKeywords.length },
        "YOUTUBE_MAX_KEYWORD_RUNS capped this query's YouTube fan-out; some keywords were dropped from YouTube coverage"
      );
    }
    for (const chunk of ytChunks.chunks) {
      platforms.push({ platform: "youtube", runMode: "backfill:youtube_search", actorSlug: "streamers/youtube-scraper", keywordsOverride: chunk });
    }
  }
  if (query.language === "zh-CN") {
    platforms.push({ platform: "xiaohongshu", runMode: "backfill:xhs_search", actorSlug: "easyapi/all-in-one-rednote-xiaohongshu-scraper" });
  }
  // Google Trends is off by default: measured $12.09 for 120 records across 58
  // runs — by far the worst value of any actor here — and it does not feed the
  // gate at all. Its output lands in tp_keyword_interest, not tp_raw_signals, so
  // it never reaches the significance or breadth tests; it only draws a
  // search-interest line on the trend chart, and that line is empty for most
  // entities anyway (the keywords we query GT with are the seed terms, while the
  // entities that surface come from social posts, so the two rarely match).
  // Set ENABLE_GOOGLE_TRENDS=true to bring it back once there is a reason to.
  if (query.geography !== "CN" && process.env.ENABLE_GOOGLE_TRENDS === "true") {
    platforms.push({ platform: "google_trends", runMode: "backfill:google_trends", actorSlug: "apify/google-trends-scraper" });
  }
  return platforms;
}

export type LaunchBatchKind = "manual" | "cron";

export type LaunchBatchResult = {
  batchId: string;
  actorRunIds: number[];
  queriesLaunched: number;
};

/**
 * Launch a batch of scout queries for a company. Each query fans out to one
 * actor run per applicable platform; all of those runs share a single
 * `launchBatchId` so the post-batch chain (timeseries -> state machine) can
 * fire exactly once when the whole batch is done.
 *
 * If `queryIds` is provided, only those queries are launched; otherwise all
 * active queries for the company are launched.
 *
 * Throws if there are no queries to launch.
 */
export async function launchBatch(
  companyId: number,
  opts: { kind: LaunchBatchKind; queryIds?: number[] }
): Promise<LaunchBatchResult> {
  const allQueries = await storage.getScoutQueries(companyId);
  const queries =
    opts.queryIds && opts.queryIds.length > 0
      ? allQueries.filter((q) => opts.queryIds!.includes(q.id))
      : allQueries.filter((q) => q.active);

  if (queries.length === 0) {
    throw new Error("No queries to launch");
  }

  // Build the full platform plan across every query up front — before any DB
  // row is created and before any Apify call is made — so the pre-flight
  // cost gate can veto the whole batch atomically. Never fire part of a
  // batch because the second half would have pushed it over budget.
  const platformPlansByQueryId = new Map<number, PlatformPlan[]>();
  for (const q of queries) {
    platformPlansByQueryId.set(q.id, planPlatformsForQuery(q));
  }
  const allPlannedRuns = queries.flatMap((q) => platformPlansByQueryId.get(q.id)!);
  const runsTotal = allPlannedRuns.length;

  // Pre-flight cost gate: estimate real Apify spend for this batch and abort
  // before touching the DB or Apify if it exceeds APIFY_MAX_BATCH_USD. Always
  // logged (not just on failure) so the estimate shows up in the run log
  // every time a batch launches, whether it passes or not.
  const costEstimate = estimateBatchCostUsd(allPlannedRuns);
  logger.info(
    {
      companyId,
      kind: opts.kind,
      queriesPlanned: queries.length,
      runsPlanned: runsTotal,
      estimateUsd: costEstimate.totalUsd,
      byPlatform: costEstimate.byPlatform,
      ceilingUsd: APIFY_MAX_BATCH_USD,
    },
    "Pre-flight Apify batch cost estimate"
  );
  enforceBatchCostCeiling(costEstimate, APIFY_MAX_BATCH_USD);

  const batchId = randomUUID();
  await storage.createLaunchBatch({
    id: batchId,
    companyId,
    kind: opts.kind,
    runsTotal,
  });

  const apifyClient = getApifyClient();
  const webhookBaseUrl = getWebhookBaseUrl();
  const webhookUrl = webhookBaseUrl
    ? `${webhookBaseUrl}/api/pipeline/webhooks/apify`
    : null;

  if (!webhookUrl) {
    logger.warn(
      { batchId, kind: opts.kind },
      "No SERVER_URL or REPLIT_DOMAINS set — Apify webhooks disabled; runs will be polled for status"
    );
  }

  const actorRunIds: number[] = [];

  try {
  for (const query of queries) {
    if (!query.active) {
      await storage.updateScoutQuery(query.id, { active: true });
    }

    const queryInput = {
      keywords: query.keywords,
      hashtags: query.hashtags,
      language: query.language,
      geography: query.geography,
      topicLabel: query.topicLabel,
    };

    // Reuse the plan computed above for the cost estimate — not recomputed
    // here — so the runs actually launched are guaranteed to match exactly
    // what was estimated and gated.
    const platforms = platformPlansByQueryId.get(query.id)!;

    for (const p of platforms) {
      // Single-keyword actors (TikTok) get one run per keyword, so narrow the
      // input to just that term. Chunked actors (YouTube, X) get one run per
      // keyword subset. Everything else sees the full keyword list.
      // buildActorInput itself is unaware of any of this — it just reads
      // input.keywords, so narrowing it here is enough to make it use the
      // subset when present and fall back to the full list otherwise.
      const runInput = p.keywordOverride
        ? { ...queryInput, keywords: [p.keywordOverride] }
        : p.keywordsOverride
        ? { ...queryInput, keywords: p.keywordsOverride }
        : queryInput;
      const actorInput = buildActorInput(p.actorSlug, p.runMode, runInput);

      const run = await storage.createActorRun({
        companyId,
        scoutQueryId: query.id,
        actorSlug: p.actorSlug,
        platform: p.platform,
        runMode: p.runMode,
        status: "queued",
        inputPayload: runInput,
        launchBatchId: batchId,
      });

      try {
        const webhooks = webhookUrl
          ? [
              {
                eventTypes: [
                  "ACTOR.RUN.SUCCEEDED",
                  "ACTOR.RUN.FAILED",
                  "ACTOR.RUN.TIMED_OUT",
                  "ACTOR.RUN.ABORTED",
                ] as any,
                requestUrl: webhookUrl,
                payloadTemplate: JSON.stringify({
                  eventType: "{{eventType}}",
                  resource: "{{resource}}",
                  internalRunId: run.id,
                }),
              },
            ]
          : undefined;

        const apifyRun = await apifyClient
          .actor(p.actorSlug)
          .start(actorInput, {
            memory: getActorMemoryMb(p.actorSlug),
            webhooks,
          });

        await storage.updateActorRun(run.id, {
          apifyRunId: apifyRun.id,
          apifyDatasetId: apifyRun.defaultDatasetId ?? null,
          status: "running",
          startedAt: new Date(),
        });

        logger.info(
          { runId: run.id, apifyRunId: apifyRun.id, actor: p.actorSlug, batchId },
          "Apify actor started"
        );
      } catch (apifyErr: any) {
        logger.error(
          { err: apifyErr, runId: run.id, actor: p.actorSlug, batchId },
          "Failed to start Apify actor"
        );
        await storage.updateActorRun(run.id, {
          status: "failed",
          errorMessage: apifyErr.message ?? "Failed to start actor",
        });
      }

      actorRunIds.push(run.id);

      // Stagger launches to avoid bursting the Apify concurrent memory limit
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  } finally {
    // Reconcile runs_total to the number of actor_run rows actually written
    // for this batch (covers DB errors mid-loop). Without this, the finalize
    // cardinality check (runs_total = COUNT) would never hold and the batch
    // would never finalize.
    await storage.setLaunchBatchActualRunsTotal(batchId).catch((e) =>
      logger.error({ err: e, batchId }, "Failed to reconcile batch runs_total")
    );

    // Defensive finalize attempt — runs in the finally block so that even if
    // the spawn loop throws (e.g. DB error) and zero runs were created, or
    // every run failed to start synchronously, the batch still gets a chance
    // to finalize (and become a no-op chain if there's nothing to do).
    void finalizeBatchIfDone(batchId).catch((e) =>
      logger.error({ err: e, batchId }, "Initial finalize check failed")
    );
  }

  await storage.setLastScoutPullAt(companyId, new Date());

  return { batchId, actorRunIds, queriesLaunched: queries.length };
}

/**
 * If all actor runs in this batch are terminal AND the batch has not yet been
 * finalized, atomically mark it finalized and chain the post-batch pipeline:
 * timeseries aggregation -> state machine. Stamps lastTimeseriesRunAt and
 * lastStateMachineRunAt on the company's pipeline_config.
 *
 * Idempotent: safe to call from multiple terminal-event handlers in quick
 * succession (webhook + poll). The atomic UPDATE in tryFinalizeLaunchBatch
 * ensures only the first caller does the work.
 *
 * Pass null/undefined batchId for runs that aren't part of a batch (test
 * fires, retried legacy runs); this becomes a no-op.
 */
export async function finalizeBatchIfDone(
  batchId: string | null | undefined
): Promise<void> {
  if (!batchId) return;

  const finalized = await storage.tryFinalizeLaunchBatch(batchId);
  if (!finalized) return; // either still running or already finalized

  const { companyId, kind } = finalized;
  logger.info(
    { batchId, companyId, kind },
    "Launch batch finalized; running post-batch chain (timeseries -> state machine)"
  );

  // Entity extraction is already chained per-run in the ingestion path, so by
  // the time we get here every succeeded run has had its entities extracted.
  // We just need to refresh the per-entity timeseries and re-evaluate states.
  try {
    await runTimeseriesAggregation(companyId);
    await storage.setLastTimeseriesRunAt(companyId);
  } catch (e) {
    logger.error(
      { err: e, batchId, companyId },
      "Post-batch timeseries aggregation failed"
    );
    // Continue to state machine anyway — it can still produce useful state
    // changes from existing buckets even if today's aggregation failed.
  }

  try {
    await runStateMachine(companyId);
    await storage.setLastStateMachineRunAt(companyId);
  } catch (e) {
    logger.error(
      { err: e, batchId, companyId },
      "Post-batch state machine run failed"
    );
  }

  logger.info({ batchId, companyId }, "Post-batch chain complete");
}
