import app from "./app.js";
import { logger } from "./lib/logger.js";
import cron from "node-cron";
import * as storage from "./storage/index.js";
import {
  getApifyClient,
  getWebhookBaseUrl,
  buildActorInput,
  mapApifyStatus,
} from "./services/apify.js";
import { ingestActorRun, ingestGoogleTrendsRun } from "./services/ingestion.js";
import { runEntityExtraction } from "./services/entity-extraction.js";
import { runTimeseriesAggregation } from "./services/timeseries.js";
import { runStateMachine } from "./services/state-machine.js";
import { launchBatch, finalizeBatchIfDone } from "./services/launch-batch.js";
import { runLongTailEvaluation } from "./services/long-tail.js";
import { runCoOccurrenceAggregation } from "./services/co-occurrence.js";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

logger.info({ port, env: { PORT: process.env["PORT"], NODE_ENV: process.env["NODE_ENV"] } }, "Starting server");

const server = app.listen(port, () => {
  const addr = server.address();
  logger.info({ port, addr }, "Server listening");
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Helpers shared by startup drain and retry logic
// ---------------------------------------------------------------------------
async function fireActorRun(runId: number, actorSlug: string, runMode: string, inputPayload: unknown) {
  const webhookBaseUrl = getWebhookBaseUrl();
  const webhookUrl = webhookBaseUrl
    ? `${webhookBaseUrl}/api/pipeline/webhooks/apify`
    : null;

  const queryInput = inputPayload as {
    keywords: string[];
    hashtags: string[];
    language: string;
    geography: string;
    topicLabel: string;
  };
  const actorInput = buildActorInput(actorSlug, runMode, queryInput);

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
            internalRunId: runId,
          }),
        },
      ]
    : undefined;

  const apifyRun = await getApifyClient()
    .actor(actorSlug)
    .start(actorInput, { webhooks });

  await storage.updateActorRun(runId, {
    apifyRunId: apifyRun.id,
    apifyDatasetId: apifyRun.defaultDatasetId ?? null,
    status: "running",
    startedAt: new Date(),
  });

  logger.info({ runId, apifyRunId: apifyRun.id, actorSlug }, "Apify actor started");
  return apifyRun.id;
}

// ---------------------------------------------------------------------------
// Startup drain: fire any queued runs that never got an apifyRunId.
// These are left over from before the Apify integration was wired up.
// ---------------------------------------------------------------------------
async function drainQueuedRuns() {
  if (!process.env.APIFY_TOKEN) {
    logger.warn("APIFY_TOKEN not set — skipping queued run drain");
    return;
  }

  try {
    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      const allQueued = await storage.getActorRuns(company.id, { status: "queued" });
      const orphaned = allQueued.filter((r) => !r.apifyRunId);
      if (orphaned.length === 0) continue;

      logger.info({ companyId: company.id, count: orphaned.length }, "Draining orphaned queued runs");

      for (const run of orphaned) {
        try {
          await fireActorRun(run.id, run.actorSlug, run.runMode, run.inputPayload);
        } catch (e: any) {
          logger.error({ err: e, runId: run.id, actorSlug: run.actorSlug }, "Failed to drain queued run");
          await storage.updateActorRun(run.id, {
            status: "failed",
            errorMessage: e.message ?? "Failed to start actor on drain",
          });
        }
      }
    }
  } catch (e: any) {
    logger.warn({ err: e }, "Queued run drain failed");
  }
}

// ---------------------------------------------------------------------------
// Background poll: sync status of in-flight runs every 2 minutes.
// Covers the no-webhook case and any missed webhook deliveries.
// ---------------------------------------------------------------------------
async function syncRunningActorRuns() {
  if (!process.env.APIFY_TOKEN) return;

  try {
    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      const runs = await storage.getActorRuns(company.id, { status: "running" });
      if (runs.length === 0) continue;

      const client = getApifyClient();
      for (const run of runs) {
        if (!run.apifyRunId) continue;
        try {
          const apifyRun = await client.run(run.apifyRunId).get();
          if (!apifyRun) continue;

          const newStatus = mapApifyStatus(apifyRun.status);
          if (newStatus === "running") continue;

          const update: Record<string, unknown> = {
            status: newStatus,
            completedAt: apifyRun.finishedAt ? new Date(apifyRun.finishedAt) : new Date(),
            costUsd: apifyRun.usageTotalUsd ?? null,
          };

          if (newStatus !== "succeeded") {
            update.errorMessage = apifyRun.statusMessage ?? null;
          }

          if (newStatus === "succeeded" && apifyRun.defaultDatasetId) {
            try {
              const dataset = await client.dataset(apifyRun.defaultDatasetId).get();
              if (dataset) update.recordsFetched = dataset.itemCount ?? 0;
            } catch (_) { /* non-fatal */ }
          }

          await storage.updateActorRun(run.id, update as any);
          logger.info({ runId: run.id, newStatus }, "Actor run synced via poll");

          // Trigger ingestion for newly-succeeded runs (webhook may have missed it)
          if (newStatus === "succeeded" && apifyRun.defaultDatasetId) {
            const datasetId = apifyRun.defaultDatasetId;
            const runId = run.id;
            const companyId = run.companyId;
            const launchBatchId = run.launchBatchId;
            setImmediate(async () => {
              try {
                const freshRun = await storage.getActorRun(runId);
                if (!freshRun) return;
                const items = await client.dataset(datasetId).listItems({ limit: 1000 });
                if (freshRun.platform === "google_trends") {
                  await ingestGoogleTrendsRun(freshRun, items.items ?? []);
                } else {
                  // Defer markIngestionDone until after extraction so the
                  // finalize SQL guard doesn't release prematurely.
                  const stats = await ingestActorRun(freshRun, items.items ?? [], { skipMarkDone: true });

                  // If another worker (e.g. webhook) already claimed this
                  // run's ingestion, do nothing — they'll mark it done.
                  if (!stats.claimed) return;

                  // If extraction throws, mark ingestion FAILED so the
                  // finalize SQL guard ('done'|'failed') can still release.
                  try {
                    await runEntityExtraction(companyId, { actorRunId: runId });
                  } catch (err) {
                    await storage.markIngestionFailed(
                      runId,
                      `Entity extraction failed: ${(err as Error).message ?? "unknown"}`
                    );
                    throw err;
                  }
                  await storage.markIngestionDone(runId, {
                    usable: stats.usable,
                    dropped: stats.dropped,
                    oldestPostedAt: stats.oldestPostedAt,
                    newestPostedAt: stats.newestPostedAt,
                  });
                }
              } catch (e) {
                logger.error({ err: e, runId }, "Poll-triggered ingestion failed");
              } finally {
                // Whether or not ingestion succeeded, this run is terminal.
                // Try to finalize the batch so the post-batch chain runs.
                await finalizeBatchIfDone(launchBatchId).catch((e) =>
                  logger.error({ err: e, runId }, "Poll batch finalize failed")
                );
              }
            });
          } else if (run.launchBatchId) {
            // Newly-terminal run that won't go through ingestion (failed/timeout,
            // or succeeded with no dataset). Mark ingestion done so the
            // finalize SQL guard (succeeded => ingestion terminal) can pass.
            const launchBatchId = run.launchBatchId;
            const runId = run.id;
            setImmediate(async () => {
              try {
                await storage.markIngestionDone(runId, {
                  usable: 0,
                  dropped: 0,
                  oldestPostedAt: null,
                  newestPostedAt: null,
                });
              } catch (e) {
                logger.warn({ err: e, runId }, "Poll markIngestionDone for terminal-no-ingestion run failed");
              }
              await finalizeBatchIfDone(launchBatchId).catch((e) =>
                logger.error({ err: e, runId }, "Poll batch finalize on failure failed")
              );
            });
          }
        } catch (e: any) {
          logger.warn({ err: e, runId: run.id }, "Failed to poll actor run status");
        }
      }
    }
  } catch (e: any) {
    logger.warn({ err: e }, "Actor run sync job failed");
  }
}

// Drain orphaned runs 5 seconds after startup (give the DB connection time to settle)
setTimeout(() => {
  drainQueuedRuns().catch((e) =>
    logger.error({ err: e }, "Unhandled error in queued run drain")
  );
}, 5000);

// Poll running runs every 2 minutes
cron.schedule("*/2 * * * *", () => {
  syncRunningActorRuns().catch((e) =>
    logger.error({ err: e }, "Unhandled error in actor run sync")
  );
});

// Nightly timeseries aggregation at 02:00 UTC.
// Gated per-company: skipped if no actor_runs have succeeded since the last
// timeseries run (no new data => identical output, save the work).
cron.schedule("0 2 * * *", async () => {
  try {
    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      const cfg = await storage.getPipelineConfig(company.id);
      const since = cfg?.lastTimeseriesRunAt ?? null;
      const hasFresh = await storage.hasFreshActorRunsSince(company.id, since);
      if (!hasFresh) {
        logger.info(
          { companyId: company.id, lastRunAt: since },
          "Nightly timeseries skipped: no new succeeded runs since last aggregation"
        );
        continue;
      }
      await runTimeseriesAggregation(company.id);
      await storage.setLastTimeseriesRunAt(company.id);
    }
  } catch (e) {
    logger.error({ err: e }, "Nightly timeseries aggregation failed");
  }
});

// Nightly state machine at 02:30 UTC (after timeseries).
// Always runs — state transitions like "declining" and "dormant" depend on
// the calendar advancing, not on new data arriving.
cron.schedule("30 2 * * *", async () => {
  try {
    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      await runStateMachine(company.id);
      await storage.setLastStateMachineRunAt(company.id);
    }
  } catch (e) {
    logger.error({ err: e }, "Nightly state machine run failed");
  }
});

// Nightly long-tail Bayesian uplift at 02:45 UTC (after state machine).
// Pure read of tp_entity_timeseries, cheap to run unconditionally so we
// keep the snapshot fresh even on quiet days. Stamps lastLongTailRunAt
// inside runLongTailEvaluation's own transaction.
cron.schedule("45 2 * * *", async () => {
  try {
    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      await runLongTailEvaluation(company.id);
    }
  } catch (e) {
    logger.error({ err: e }, "Nightly long-tail evaluation failed");
  }
});

// Nightly category attribute timeseries aggregation at 02:45 UTC.
// Pure read of tp_attribute_signals + raw signal posted_at; stamps
// lastAttributeAggregationAt inside its own transaction.
cron.schedule("45 2 * * *", async () => {
  try {
    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      await storage.runAttributeTimeseriesAggregation(company.id);
    }
  } catch (e) {
    logger.error({ err: e }, "Nightly attribute aggregation failed");
  }
});

// Weekly composite co-occurrence aggregation, Mondays at 03:00 UTC.
// Pair-level scan over tp_entity_co_occurrences ∪ tp_signal_entities. The
// service stamps lastCoOccurrenceRunAt inside its own transaction.
cron.schedule("0 3 * * 1", async () => {
  try {
    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      await runCoOccurrenceAggregation(company.id);
    }
  } catch (e) {
    logger.error({ err: e }, "Weekly co-occurrence aggregation failed");
  }
});

// ---------------------------------------------------------------------------
// Weekly/biweekly/monthly scout-pull cron
// ---------------------------------------------------------------------------
// Ticks every hour and fires `launchBatch(kind:'cron')` for any company
// whose schedule matches the current UTC day-of-week + hour AND whose last
// pull is older than the cadence window (with a small slack so we don't
// double-fire if the tick is delayed by a few minutes).
const CADENCE_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

cron.schedule("0 * * * *", async () => {
  try {
    const now = new Date();
    const utcDow = now.getUTCDay();
    const utcHour = now.getUTCHours();

    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      const cfg = await storage.getPipelineConfig(company.id);
      if (!cfg) continue;

      const cadence = cfg.scoutPullCadence ?? "weekly";
      if (cadence === "manual") continue;

      const cadenceDays = CADENCE_DAYS[cadence];
      if (!cadenceDays) {
        logger.warn(
          { companyId: company.id, cadence },
          "Unknown scout pull cadence; skipping"
        );
        continue;
      }

      if ((cfg.scoutPullDow ?? 1) !== utcDow) continue;
      if ((cfg.scoutPullHourUtc ?? 6) !== utcHour) continue;

      // Cadence window with 30-minute slack for tick lag.
      const minIntervalMs = cadenceDays * 24 * 60 * 60 * 1000 - 30 * 60 * 1000;
      if (
        cfg.lastScoutPullAt &&
        now.getTime() - cfg.lastScoutPullAt.getTime() < minIntervalMs
      ) {
        logger.info(
          { companyId: company.id, cadence, lastPull: cfg.lastScoutPullAt },
          "Scout pull cron tick matched but cadence window not yet elapsed"
        );
        continue;
      }

      try {
        const result = await launchBatch(company.id, { kind: "cron" });
        logger.info(
          {
            companyId: company.id,
            cadence,
            batchId: result.batchId,
            queriesLaunched: result.queriesLaunched,
            actorRuns: result.actorRunIds.length,
          },
          "Scheduled scout pull launched"
        );
      } catch (err: any) {
        if (err.message === "No queries to launch") {
          logger.info(
            { companyId: company.id },
            "Scheduled scout pull skipped: no active queries"
          );
        } else {
          logger.error(
            { err, companyId: company.id },
            "Scheduled scout pull failed"
          );
        }
      }
    }
  } catch (e) {
    logger.error({ err: e }, "Scout pull cron tick failed");
  }
});
