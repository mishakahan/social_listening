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
  // search term, so the query's full keyword list is covered by N runs instead
  // of being silently truncated to the first.
  keywordOverride?: string;
};

// The TikTok actor takes ONE keyword per run, so buildActorInput used keywords[0]
// and dropped the rest: a 33-keyword "Alcoholic beverages" query only ever
// searched "beer" on TikTok, and soju never reached the platform where a soju
// trend would most obviously live. Fan out to one run per keyword instead.
// Affordable because TikTok is the cheapest actor we run by an order of
// magnitude — measured $0.0096/run, vs $0.39 YouTube and $0.27 Instagram — so
// covering all 466 keywords costs ~$4.4 rather than the ~1 cent per extra term
// it looks like it should. Capped so a runaway fan-out cannot surprise us.
const TIKTOK_MAX_KEYWORD_RUNS =
  Number(process.env.TIKTOK_MAX_KEYWORD_RUNS ?? "80") || 80;

function planPlatformsForQuery(query: {
  keywords: string[] | null;
  language: string | null;
  geography: string | null;
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
    // kept in buildActorInput for when that happens.)
    platforms.push({ platform: "reddit", runMode: "backfill:reddit_search", actorSlug: "trudax/reddit-scraper-lite" });
    // X: free-text keyword search with a real since/until date window.
    platforms.push({ platform: "x", runMode: "backfill:x_search", actorSlug: "xquik/x-tweet-scraper" });
    // YouTube: deep date-queryable history — the main lever for the depth the
    // significance test needs (unlike recent-only IG/Reddit).
    platforms.push({ platform: "youtube", runMode: "backfill:youtube_search", actorSlug: "streamers/youtube-scraper" });
  }
  if (query.language === "zh-CN") {
    platforms.push({ platform: "xiaohongshu", runMode: "backfill:xhs_search", actorSlug: "easyapi/all-in-one-rednote-xiaohongshu-scraper" });
  }
  if (query.geography !== "CN") {
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

  // Pre-compute the total run count so the batch row knows it up front.
  const runsTotal = queries.reduce(
    (sum, q) => sum + planPlatformsForQuery(q).length,
    0
  );

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

    const platforms = planPlatformsForQuery(query);

    for (const p of platforms) {
      // Single-keyword actors (TikTok) get one run per keyword, so narrow the
      // input to just that term. Everything else sees the full keyword list.
      const runInput = p.keywordOverride
        ? { ...queryInput, keywords: [p.keywordOverride] }
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
