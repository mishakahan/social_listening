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
import { ingestActorRun } from "./services/ingestion.js";
import { runEntityExtraction } from "./services/entity-extraction.js";
import { runTimeseriesAggregation } from "./services/timeseries.js";
import { runStateMachine } from "./services/state-machine.js";

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
            setImmediate(async () => {
              try {
                const freshRun = await storage.getActorRun(runId);
                if (!freshRun) return;
                const items = await client.dataset(datasetId).listItems({ limit: 1000 });
                await ingestActorRun(freshRun, items.items ?? []);
                await runEntityExtraction(companyId, { actorRunId: runId });
              } catch (e) {
                logger.error({ err: e, runId }, "Poll-triggered ingestion failed");
              }
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

// Nightly timeseries aggregation at 02:00 UTC
cron.schedule("0 2 * * *", async () => {
  try {
    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      await runTimeseriesAggregation(company.id);
    }
  } catch (e) {
    logger.error({ err: e }, "Nightly timeseries aggregation failed");
  }
});

// Nightly state machine at 02:30 UTC (after timeseries)
cron.schedule("30 2 * * *", async () => {
  try {
    const companies = await storage.getAllCompanies();
    for (const company of companies) {
      await runStateMachine(company.id);
    }
  } catch (e) {
    logger.error({ err: e }, "Nightly state machine run failed");
  }
});
