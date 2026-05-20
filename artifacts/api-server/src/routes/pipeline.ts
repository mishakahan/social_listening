import { Router } from "express";
import { z } from "zod";
import * as storage from "../storage/index.js";
import {
  generateSeedCandidates,
  generateScoutQueriesForSeed,
  type SeedCandidateItem,
  type CompanyContext,
} from "../services/radar-setup-bot.js";
import {
  getApifyClient,
  getWebhookBaseUrl,
  buildActorInput,
  getActorMemoryMb,
  mapApifyStatus,
} from "../services/apify.js";
import { ingestActorRun, ingestGoogleTrendsRun } from "../services/ingestion.js";
import { runEntityExtraction } from "../services/entity-extraction.js";
import { runTimeseriesAggregation } from "../services/timeseries.js";
import { runStateMachine } from "../services/state-machine.js";
import { launchBatch, finalizeBatchIfDone } from "../services/launch-batch.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/default
// Health / dev: get-or-create the default company
// ---------------------------------------------------------------------------
router.get("/companies/default", async (_req, res) => {
  try {
    const company = await storage.getOrCreateDefaultCompany();
    res.json(company);
  } catch (err: any) {
    logger.error({ err }, "Failed to get default company");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/setup-radar/generate
// Body: { brief: string }
// ---------------------------------------------------------------------------
router.post("/companies/:id/setup-radar/generate", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const { brief, userId } = req.body as { brief?: string; userId?: number };

    if (!brief || typeof brief !== "string") {
      res.status(400).json({ error: "brief is required" });
      return;
    }
    if (brief.length < 500) {
      res.status(400).json({
        error: `Brief must be at least 500 characters (got ${brief.length}).`,
      });
      return;
    }

    const resolvedUserId = userId ?? (await storage.getOrCreateDefaultUserId());

    const { companyContext, seedItems } = await generateSeedCandidates(
      brief,
      companyId,
      resolvedUserId
    );

    const candidate = await storage.createSeedCandidates({
      companyId,
      userId: resolvedUserId,
      payload: seedItems as any,
      briefSnapshot: brief,
      companyContextSnapshot: companyContext as Record<string, any>,
      status: "draft",
    });

    res.json({
      candidateId: candidate.id,
      payload: candidate.payload,
      companyContext,
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to generate seed candidates");
    if (
      err.message?.startsWith("Please mention") ||
      err.message?.startsWith("Brief must be")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/setup-radar/commit  (alias for seeds/commit)
// ---------------------------------------------------------------------------
router.post("/companies/:id/setup-radar/commit", async (req, res) => {
  req.params.id = req.params.id!;
  // Delegate to commit handler inline
  await commitSeeds(req, res);
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/seed-candidates
// ---------------------------------------------------------------------------
router.get("/companies/:id/seed-candidates", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const candidate = await storage.getLatestSeedCandidates(companyId);
    if (!candidate) {
      res.status(404).json({ error: "No seed candidates found" });
      return;
    }
    res.json(candidate);
  } catch (err: any) {
    logger.error({ err }, "Failed to get seed candidates");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/pipeline/companies/:id/seed-candidates/:candidateId
// Body: partial update to a single item in payload by index
// ---------------------------------------------------------------------------
router.patch(
  "/companies/:id/seed-candidates/:candidateId",
  async (req, res) => {
    try {
      const candidateId = parseInt(req.params.candidateId!, 10);
      const { index, updates } = req.body as {
        index?: number;
        updates?: Partial<SeedCandidateItem & { status?: string }>;
      };

      const candidate = await storage.updateSeedCandidates(candidateId, {});
      // Re-fetch with actual data
      const existing = await storage.getLatestSeedCandidates(
        parseInt(req.params.id!, 10)
      );
      if (!existing || existing.id !== candidateId) {
        res.status(404).json({ error: "Seed candidate not found" });
        return;
      }

      if (index !== undefined && updates !== undefined) {
        const payload = [...(existing.payload as SeedCandidateItem[])];
        if (index < 0 || index >= payload.length) {
          res.status(400).json({ error: `Index ${index} out of range` });
          return;
        }
        payload[index] = { ...payload[index]!, ...updates };
        const updated = await storage.updateSeedCandidates(candidateId, {
          payload: payload as any,
        });
        res.json(updated);
        return;
      }

      res.json(existing);
    } catch (err: any) {
      logger.error({ err }, "Failed to patch seed candidates");
      res.status(500).json({ error: err.message });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/seeds/commit
// ---------------------------------------------------------------------------
async function commitSeeds(req: any, res: any) {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const { candidateId } = req.body as { candidateId: number };

    if (!candidateId) {
      res.status(400).json({ error: "candidateId is required" });
      return;
    }

    // Load the candidate
    const candidates = await storage.getLatestSeedCandidates(companyId);
    if (!candidates || candidates.id !== candidateId) {
      res.status(404).json({ error: "Seed candidates not found" });
      return;
    }

    const companyContextSnapshot = (candidates.companyContextSnapshot ??
      {}) as CompanyContext;

    const payload = candidates.payload as Array<
      SeedCandidateItem & { status?: string }
    >;

    const seedItemIds: number[] = [];
    let scoutQueryCount = 0;

    for (const item of payload) {
      if (item.status === "killed") continue;

      const seedItem = await storage.createSeedItem({
        companyId,
        label: item.label,
        description: item.description,
        geography: item.geography,
        productCategoryLink: item.productCategoryLink,
        territoryTag: item.territoryTag,
        strategicCentrality: item.strategicCentrality,
        actionableAt: item.actionableAt,
        groundedIn: item.groundedIn,
        status: "pending",
      });

      seedItemIds.push(seedItem.id);

      // Generate or use existing scout queries
      let queries = item.seedQueries ?? [];

      // If we have a context snapshot, regenerate with fresher queries
      try {
        if (companyContextSnapshot && Object.keys(companyContextSnapshot).length > 0) {
          const freshQueries = await generateScoutQueriesForSeed(
            item,
            companyContextSnapshot
          );
          if (freshQueries.length > 0) {
            queries = freshQueries;
          }
        }
      } catch (err) {
        logger.warn({ err, label: item.label }, "Scout query generation failed, using payload queries");
      }

      for (const q of queries) {
        await storage.createScoutQuery({
          companyId,
          seedItemId: seedItem.id,
          topicLabel: item.label,
          geography: item.geography,
          language: q.language,
          keywords: q.keywords,
          hashtags: q.hashtags,
          active: false,
        });
        scoutQueryCount++;
      }
    }

    // Mark candidate as committed
    await storage.updateSeedCandidates(candidateId, {
      status: "committed",
      committedAt: new Date(),
    });

    res.json({ success: true, seedItemIds, scoutQueryCount });
  } catch (err: any) {
    logger.error({ err }, "Failed to commit seeds");
    res.status(500).json({ error: err.message });
  }
}

router.post("/companies/:id/seeds/commit", commitSeeds);

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/seed-items
// ---------------------------------------------------------------------------
router.get("/companies/:id/seed-items", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const items = await storage.getSeedItems(companyId);
    res.json(items);
  } catch (err: any) {
    logger.error({ err }, "Failed to get seed items");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/pipeline/companies/:id/seed-items/:seedId
// ---------------------------------------------------------------------------
router.patch("/companies/:id/seed-items/:seedId", async (req, res) => {
  try {
    const seedId = parseInt(req.params.seedId!, 10);
    const data = req.body;
    const updated = await storage.updateSeedItem(seedId, data);
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, "Failed to update seed item");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/pipeline/companies/:id/seed-items/:seedId
// ---------------------------------------------------------------------------
router.delete("/companies/:id/seed-items/:seedId", async (req, res) => {
  try {
    const seedId = parseInt(req.params.seedId!, 10);
    await storage.deleteSeedItem(seedId);
    res.json({ success: true });
  } catch (err: any) {
    logger.error({ err }, "Failed to delete seed item");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/scout-queries
// Optional filters: ?geography=&language=&active=&seedItemId=
// ---------------------------------------------------------------------------
router.get("/companies/:id/scout-queries", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const filters: {
      geography?: string;
      language?: string;
      active?: boolean;
      seedItemId?: number;
    } = {};
    if (req.query.geography) filters.geography = req.query.geography as string;
    if (req.query.language) filters.language = req.query.language as string;
    if (req.query.active !== undefined)
      filters.active = req.query.active === "true";
    if (req.query.seedItemId)
      filters.seedItemId = parseInt(req.query.seedItemId as string, 10);

    const queries = await storage.getScoutQueries(companyId, filters);
    res.json(queries);
  } catch (err: any) {
    logger.error({ err }, "Failed to get scout queries");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/pipeline/scout-queries/:id
// ---------------------------------------------------------------------------
router.patch("/scout-queries/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id!, 10);
    const data = req.body;
    const updated = await storage.updateScoutQuery(id, data);
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, "Failed to update scout query");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/pipeline/scout-queries/:id
// ---------------------------------------------------------------------------
router.delete("/scout-queries/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id!, 10);
    await storage.deleteScoutQuery(id);
    res.json({ success: true });
  } catch (err: any) {
    logger.error({ err }, "Failed to delete scout query");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/pipeline/companies/:id/scout-queries/bulk
// Body: { queryIds: number[] }
// ---------------------------------------------------------------------------
router.delete("/companies/:id/scout-queries/bulk", async (req, res) => {
  try {
    const { queryIds } = req.body as { queryIds: number[] };
    if (!Array.isArray(queryIds) || queryIds.length === 0) {
      res.status(400).json({ error: "queryIds must be a non-empty array" });
      return;
    }
    await storage.deleteScoutQueries(queryIds);
    res.json({ success: true });
  } catch (err: any) {
    logger.error({ err }, "Failed to bulk delete scout queries");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/scout-queries/:id/test-fire
// Simulation: returns mock data
// ---------------------------------------------------------------------------
router.post("/scout-queries/:id/test-fire", async (req, res) => {
  try {
    const id = parseInt(req.params.id!, 10);
    const query = await storage.getScoutQuery(id);
    if (!query) {
      res.status(404).json({ error: "Scout query not found" });
      return;
    }

    const mockItem = {
      id: `mock_${Date.now()}`,
      platform: "instagram",
      text: `Loving this ${query.topicLabel} trend! #${query.hashtags[0] ?? "trending"}`,
      author: "@mock_user",
      likes: 142,
      comments: 23,
      posted_at: new Date().toISOString(),
      hashtags: query.hashtags.slice(0, 3),
      url: `https://instagram.com/p/mock_${Date.now()}`,
    };

    const mockNormalised = {
      sourceId: mockItem.id,
      platform: "instagram",
      text: mockItem.text,
      hashtags: mockItem.hashtags,
      engagementScore: mockItem.likes + mockItem.comments * 3,
      language: query.language,
      geography: query.geography,
      topicLabel: query.topicLabel,
    };

    res.json({
      items: [mockItem],
      normalised: [mockNormalised],
      droppedCount: 0,
      dropReasons: {},
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to test-fire scout query");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/scout-queries/launch
// ---------------------------------------------------------------------------
router.post("/companies/:id/scout-queries/launch", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const { queryIds } = (req.body ?? {}) as { queryIds?: number[] };

    const result = await launchBatch(companyId, {
      kind: "manual",
      queryIds,
    });

    res.json({
      success: true,
      batchId: result.batchId,
      actorRunIds: result.actorRunIds,
      queriesLaunched: result.queriesLaunched,
    });
  } catch (err: any) {
    if (err.message === "No queries to launch") {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error({ err }, "Failed to launch scout queries");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/pipeline/companies/:id/actor-runs
// Body: { runIds: number[] }  — deletes the specified run records from the DB.
// ---------------------------------------------------------------------------
router.delete("/companies/:id/actor-runs", async (req, res) => {
  try {
    const { runIds } = req.body as { runIds?: number[] };
    if (!runIds || runIds.length === 0) {
      res.status(400).json({ error: "runIds array required" });
      return;
    }
    await storage.deleteActorRuns(runIds);
    res.json({ deleted: runIds.length });
  } catch (err: any) {
    logger.error({ err }, "Failed to delete actor runs");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/actor-runs
// ---------------------------------------------------------------------------
router.get("/companies/:id/actor-runs", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const filters: { platform?: string; status?: string; scoutQueryId?: number } =
      {};
    if (req.query.platform) filters.platform = req.query.platform as string;
    if (req.query.status) filters.status = req.query.status as string;
    if (req.query.scoutQueryId)
      filters.scoutQueryId = parseInt(req.query.scoutQueryId as string, 10);

    const runs = await storage.getActorRuns(companyId, filters);
    res.json(runs);
  } catch (err: any) {
    logger.error({ err }, "Failed to get actor runs");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/actor-runs/:id
// ---------------------------------------------------------------------------
router.get("/actor-runs/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id!, 10);
    const run = await storage.getActorRun(id);
    if (!run) {
      res.status(404).json({ error: "Actor run not found" });
      return;
    }
    res.json(run);
  } catch (err: any) {
    logger.error({ err }, "Failed to get actor run");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/actor-runs/:id/sample-signals
// ---------------------------------------------------------------------------
router.get("/actor-runs/:id/sample-signals", async (req, res) => {
  try {
    const id = parseInt(req.params.id!, 10);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const signals = await storage.getRawSignals(id, limit);
    res.json(signals);
  } catch (err: any) {
    logger.error({ err }, "Failed to get sample signals");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/actor-runs/:id/output
// Fetches up to 50 items from the Apify dataset for a completed run.
// ---------------------------------------------------------------------------
router.get("/actor-runs/:id/output", async (req, res) => {
  try {
    const id = parseInt(req.params.id!, 10);
    const run = await storage.getActorRun(id);
    if (!run) {
      res.status(404).json({ error: "Actor run not found" });
      return;
    }
    if (!run.apifyDatasetId) {
      res.status(404).json({ error: "No dataset available for this run" });
      return;
    }
    const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10), 200);
    const result = await getApifyClient()
      .dataset(run.apifyDatasetId)
      .listItems({ limit });
    res.json({ items: result.items, total: result.total, count: result.count });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch run output");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/actor-runs/:id/retry
// ---------------------------------------------------------------------------
router.post("/actor-runs/:id/retry", async (req, res) => {
  try {
    const id = parseInt(req.params.id!, 10);
    const run = await storage.getActorRun(id);
    if (!run) {
      res.status(404).json({ error: "Actor run not found" });
      return;
    }

    // Defense-in-depth: only allow retry for genuinely retryable runs.
    // Re-launching a succeeded run reuses the same row and runs into the
    // dedup index on raw_signals; re-launching an active run fights with
    // the in-flight Apify call. Billing-cap failures will just fail again
    // until the user upgrades their Apify plan, so block those too.
    if (run.status !== "failed" && run.status !== "timeout") {
      res.status(409).json({
        error: `Run is ${run.status}; only failed or timed-out runs can be retried.`,
      });
      return;
    }
    if (run.errorMessage?.toLowerCase().includes("maximum usage")) {
      res.status(409).json({
        error:
          "Run was aborted by Apify's billing cap; retrying will not help. Upgrade your Apify plan or wait for the cycle reset.",
      });
      return;
    }

    // Reset record first.
    // We also reset ingestionStatus to "pending" so that when the relaunched
    // run finishes, claimIngestion() can succeed. Without this, any retry of a
    // run whose previous attempt had already ingested (status='done') or
    // explicitly failed ingestion (status='failed') would skip ingestion of
    // the new dataset and silently leave recordsUsable stale.
    await storage.updateActorRun(id, {
      status: "queued",
      apifyRunId: null,
      apifyDatasetId: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      recordsFetched: 0,
      recordsUsable: 0,
      recordsDropped: 0,
      costUsd: null,
      ingestionStatus: "pending",
    } as any);

    const webhookBaseUrl = getWebhookBaseUrl();
    const webhookUrl = webhookBaseUrl
      ? `${webhookBaseUrl}/api/pipeline/webhooks/apify`
      : null;

    const queryInput = run.inputPayload as {
      keywords: string[];
      hashtags: string[];
      language: string;
      geography: string;
      topicLabel: string;
    };
    const actorInput = buildActorInput(run.actorSlug, run.runMode, queryInput);

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

    const apifyRun = await getApifyClient()
      .actor(run.actorSlug)
      .start(actorInput, { memory: getActorMemoryMb(run.actorSlug), webhooks });

    const updated = await storage.updateActorRun(id, {
      apifyRunId: apifyRun.id,
      apifyDatasetId: apifyRun.defaultDatasetId ?? null,
      status: "running",
      startedAt: new Date(),
    });

    logger.info({ runId: id, apifyRunId: apifyRun.id }, "Actor run retried");
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, "Failed to retry actor run");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/actor-runs/:id/cancel
// Aborts the Apify run if active, marks DB record as cancelled.
// ---------------------------------------------------------------------------
router.post("/actor-runs/:id/cancel", async (req, res) => {
  try {
    const id = parseInt(req.params.id!, 10);
    const run = await storage.getActorRun(id);
    if (!run) {
      res.status(404).json({ error: "Actor run not found" });
      return;
    }

    // Abort on Apify if it has an active run
    if (run.apifyRunId && (run.status === "running" || run.status === "queued")) {
      try {
        await getApifyClient().run(run.apifyRunId).abort();
      } catch (e: any) {
        // Log but don't fail — we still want to mark it cancelled locally
        logger.warn({ err: e, apifyRunId: run.apifyRunId }, "Apify abort call failed");
      }
    }

    const updated = await storage.updateActorRun(id, {
      status: "failed",
      errorMessage: "Cancelled by user",
      completedAt: new Date(),
    });

    // Cancellation may be the last terminal transition for a launch batch.
    // Mark ingestion done (no dataset to process) and try to finalize so the
    // post-batch chain still runs.
    if (run.launchBatchId) {
      try {
        await storage.markIngestionDone(id, {
          usable: 0,
          dropped: 0,
          oldestPostedAt: null,
          newestPostedAt: null,
        });
      } catch (e) {
        logger.warn({ err: e, runId: id }, "markIngestionDone after cancel failed");
      }
      finalizeBatchIfDone(run.launchBatchId).catch((e) =>
        logger.error({ err: e, runId: id }, "Batch finalize after cancel failed")
      );
    }

    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, "Failed to cancel actor run");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/actor-runs/bulk-cancel
// Body: { runIds: number[] }
// ---------------------------------------------------------------------------
router.post("/companies/:id/actor-runs/bulk-cancel", async (req, res) => {
  try {
    const { runIds } = req.body as { runIds: number[] };
    if (!Array.isArray(runIds) || runIds.length === 0) {
      res.status(400).json({ error: "runIds must be a non-empty array" });
      return;
    }

    const batchIdsToFinalize = new Set<string>();
    const results = await Promise.allSettled(
      runIds.map(async (id) => {
        const run = await storage.getActorRun(id);
        if (!run) return null;

        if (run.apifyRunId && (run.status === "running" || run.status === "queued")) {
          try {
            await getApifyClient().run(run.apifyRunId).abort();
          } catch (e: any) {
            logger.warn({ err: e, apifyRunId: run.apifyRunId }, "Apify abort call failed");
          }
        }

        const updated = await storage.updateActorRun(id, {
          status: "failed",
          errorMessage: "Cancelled by user",
          completedAt: new Date(),
        });

        if (run.launchBatchId) {
          try {
            await storage.markIngestionDone(id, {
              usable: 0,
              dropped: 0,
              oldestPostedAt: null,
              newestPostedAt: null,
            });
          } catch (e) {
            logger.warn({ err: e, runId: id }, "markIngestionDone after bulk-cancel failed");
          }
          batchIdsToFinalize.add(run.launchBatchId);
        }

        return updated;
      })
    );

    // Try to finalize each affected batch once (deduped) so the post-batch
    // chain runs after a bulk cancel terminates the last in-flight runs.
    for (const batchId of batchIdsToFinalize) {
      finalizeBatchIfDone(batchId).catch((e) =>
        logger.error({ err: e, batchId }, "Batch finalize after bulk-cancel failed")
      );
    }

    const cancelled = results.filter((r) => r.status === "fulfilled" && r.value).length;
    res.json({ success: true, cancelled });
  } catch (err: any) {
    logger.error({ err }, "Failed to bulk cancel actor runs");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/actor-runs/summary
// ---------------------------------------------------------------------------
router.get("/companies/:id/actor-runs/summary", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const windowHours = req.query.windowHours
      ? parseInt(req.query.windowHours as string, 10)
      : undefined;
    const summary = await storage.getActorRunSummary(companyId, windowHours);
    res.json(summary);
  } catch (err: any) {
    logger.error({ err }, "Failed to get actor run summary");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/webhooks/apify
// ---------------------------------------------------------------------------
router.post("/webhooks/apify", async (req, res) => {
  // Always respond 200 immediately so Apify doesn't retry
  res.status(200).json({ ok: true });

  try {
    const body = req.body as {
      eventType?: string;
      internalRunId?: number;
      resource?: {
        id?: string;
        status?: string;
        defaultDatasetId?: string;
        stats?: { netRxBytes?: number };
        usageTotalUsd?: number;
        exitCode?: number;
        statusMessage?: string;
      };
    };

    logger.info({ eventType: body.eventType, apifyRunId: body.resource?.id }, "Apify webhook received");

    const apifyRunId = body.resource?.id;
    const apifyStatus = body.resource?.status;
    if (!apifyRunId || !apifyStatus) return;

    // Look up our run record — prefer the internalRunId embedded in the webhook payload
    let run = body.internalRunId
      ? await storage.getActorRun(body.internalRunId)
      : undefined;
    if (!run) {
      run = await storage.getActorRunByApifyRunId(apifyRunId);
    }
    if (!run) {
      logger.warn({ apifyRunId }, "Received Apify webhook for unknown run");
      return;
    }

    const newStatus = mapApifyStatus(apifyStatus);
    const isTerminal = newStatus !== "running";

    const update: Record<string, unknown> = { status: newStatus };

    if (isTerminal) {
      update.completedAt = new Date();

      // Pull final stats from the Apify run resource
      if (body.resource?.usageTotalUsd != null) {
        update.costUsd = body.resource.usageTotalUsd;
      }
      if (body.resource?.statusMessage) {
        update.errorMessage = newStatus !== "succeeded" ? body.resource.statusMessage : null;
      }

      // Fetch dataset item count for succeeded runs
      if (newStatus === "succeeded" && body.resource?.defaultDatasetId) {
        try {
          const dataset = await getApifyClient()
            .dataset(body.resource.defaultDatasetId)
            .get();
          if (dataset) {
            update.recordsFetched = dataset.itemCount ?? 0;
          }
        } catch (e: any) {
          logger.warn({ err: e }, "Could not fetch dataset item count");
        }
      }
    }

    await storage.updateActorRun(run.id, update as any);
    logger.info({ runId: run.id, apifyRunId, newStatus }, "Actor run updated from webhook");

    // Kick off ingestion asynchronously for succeeded runs. Ingestion will
    // call finalizeBatchIfDone when it's done so the post-batch chain
    // (timeseries -> state machine) sees this run's freshly-extracted entities.
    // Use try/finally so finalize runs even if ingestion throws — the run
    // is already terminal in DB, so the batch must still get to finalize.
    if (newStatus === "succeeded" && body.resource?.defaultDatasetId) {
      const launchBatchId = run.launchBatchId;
      const datasetId = body.resource.defaultDatasetId;
      const runIdForLog = run.id;
      void (async () => {
        try {
          await triggerIngestion(runIdForLog, datasetId);
        } catch (e) {
          logger.error({ err: e, runId: runIdForLog }, "Ingestion trigger failed");
        } finally {
          try {
            await finalizeBatchIfDone(launchBatchId);
          } catch (e) {
            logger.error(
              { err: e, runId: runIdForLog },
              "Batch finalize after ingestion failed"
            );
          }
        }
      })();
    } else if (isTerminal && run.launchBatchId) {
      // Terminal-without-ingestion: failed/timeout, OR succeeded-with-no-dataset.
      // These never go through triggerIngestion, so mark ingestion as done
      // (with zero counts) before attempting finalize — otherwise the SQL
      // guard (succeeded => ingestion_status IN done|failed) would block the
      // batch forever.
      const launchBatchId = run.launchBatchId;
      const runIdForLog = run.id;
      void (async () => {
        try {
          await storage.markIngestionDone(runIdForLog, {
            usable: 0,
            dropped: 0,
            oldestPostedAt: null,
            newestPostedAt: null,
          });
        } catch (e) {
          logger.warn(
            { err: e, runId: runIdForLog },
            "markIngestionDone for terminal-no-ingestion run failed"
          );
        }
        try {
          await finalizeBatchIfDone(launchBatchId);
        } catch (e) {
          logger.error({ err: e, runId: runIdForLog }, "Batch finalize on failure failed");
        }
      })();
    }
  } catch (err: any) {
    logger.error({ err }, "Failed to process Apify webhook");
  }
});

// ---------------------------------------------------------------------------
// Ingestion trigger helper (async, not awaited from webhook)
// ---------------------------------------------------------------------------
async function triggerIngestion(runId: number, datasetId: string): Promise<void> {
  const run = await storage.getActorRun(runId);
  if (!run) return;

  logger.info({ runId, datasetId }, "Fetching dataset for ingestion");
  const items = await getApifyClient().dataset(datasetId).listItems({ limit: 1000 });
  const data = items.items ?? [];

  // Google Trends has its own narrow target table; everything else flows
  // through the standard social-mention ingestion + entity extraction path.
  if (run.platform === "google_trends") {
    await ingestGoogleTrendsRun(run, data);
    return;
  }

  // Defer markIngestionDone until AFTER entity extraction completes. Otherwise
  // a sibling failed-run's finalizeBatchIfDone could pass the SQL guard
  // (ingestion_status='done') while extraction is still running, causing the
  // post-batch chain to run on stale entities.
  const stats = await ingestActorRun(run, data, { skipMarkDone: true });

  // If we lost the race to claim ingestion, another worker owns this run's
  // post-processing — do not run extraction or mark done here, or we'd
  // release the finalize guard early while the real owner is still working.
  if (!stats.claimed) return;

  // Run entity extraction. If it throws, mark ingestion FAILED so the
  // finalize SQL guard ('done'|'failed') can still release. Without this,
  // extraction errors would leave ingestion_status='processing' forever and
  // the batch would never finalize.
  try {
    await runEntityExtraction(run.companyId, { actorRunId: runId });
  } catch (err) {
    await storage.markIngestionFailed(
      runId,
      `Entity extraction failed: ${(err as Error).message ?? "unknown"}`
    );
    throw err;
  }

  // Now mark ingestion done — this is what releases the finalize SQL guard.
  await storage.markIngestionDone(runId, {
    usable: stats.usable,
    dropped: stats.dropped,
    oldestPostedAt: stats.oldestPostedAt,
    newestPostedAt: stats.newestPostedAt,
  });
}

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/pipeline-config
// ---------------------------------------------------------------------------
router.get("/companies/:id/pipeline-config", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const config = await storage.getPipelineConfig(companyId);
    res.json(config);
  } catch (err: any) {
    logger.error({ err }, "Failed to get pipeline config");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/pipeline/companies/:id/pipeline-config
// ---------------------------------------------------------------------------
const entityTypeSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "id must be lowercase letters, digits, or underscores"),
  label: z.string().min(1).max(64),
  description: z.string().max(500).optional().default(""),
  examples: z.string().max(500).optional().default(""),
  color: z.string().min(1).max(200),
});

const patchConfigSchema = z
  .object({
    entityTypes: z
      .array(entityTypeSchema)
      .min(1, "At least one entity type is required")
      .max(50)
      .refine(
        (arr) => new Set(arr.map((t) => t.id)).size === arr.length,
        { message: "Entity type ids must be unique" }
      )
      .optional(),
    coreVocabulary: z
      .array(z.string().trim().min(1).max(120))
      .max(500)
      .optional(),
    scoutPullCadence: z
      .enum(["manual", "weekly", "biweekly", "monthly"])
      .optional(),
    scoutPullDow: z.number().int().min(0).max(6).optional(),
    scoutPullHourUtc: z.number().int().min(0).max(23).optional(),
  })
  .passthrough();

router.patch("/companies/:id/pipeline-config", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const parsed = patchConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid pipeline config",
        details: parsed.error.flatten(),
      });
      return;
    }
    const updated = await storage.updatePipelineConfig(companyId, parsed.data);
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, "Failed to update pipeline config");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/pipeline-config/reset-tier
// Body: { tier: 1 | 2 | 3 }
// ---------------------------------------------------------------------------
router.post("/companies/:id/pipeline-config/reset-tier", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const { tier } = req.body as { tier?: 1 | 2 | 3 };
    if (!tier || ![1, 2, 3].includes(tier)) {
      res.status(400).json({ error: "tier must be 1, 2, or 3" });
      return;
    }

    let defaults: Partial<import("@workspace/db").TpPipelineConfig> = {};

    if (tier === 1) {
      defaults = {
        noiseFloor: 3,
        commercialIntentThreshold: 0.75,
        languageConfidenceThreshold: 0.7,
        engagementWeights: {
          instagram: { likes: 1, comments: 3, shares: 5, views: 0.1 },
          tiktok: { likes: 1, comments: 5, shares: 3, views: 0.05 },
          reddit: { score: 1, comments: 2, shares: 0, views: 0 },
          xiaohongshu: {
            likes: 1,
            comments: 3,
            shares: 2,
            views: 0.1,
            saves: 4,
          },
          google_trends: { views: 1, likes: 0, comments: 0, shares: 0 },
        },
        authorTierWeights: { nano: 0.5, micro: 1.0, mid: 1.5, macro: 2.0 },
        scrapeDepthLimits: {
          instagram_hashtag: 500,
          tiktok: 1000,
          reddit: 500,
          xiaohongshu: 300,
          google_trends: 1,
        },
      };
    } else if (tier === 2) {
      defaults = {
        dedupCosineThreshold: 0.8,
        candidateToEmergingMinWeeks: 2,
        candidateToEmergingMinWowGrowth: 0.3,
        candidateToEmergingMinVolume: 9,
        crossSourceCoOccurrenceMultiplier: 0.3,
        scrapeCadence: {
          instagram_hashtag: "daily",
          tiktok: "daily",
          reddit: "3x_week",
          xiaohongshu: "daily",
          google_trends: "weekly",
        },
        volatilityTolerance: 1.5,
        minEvidenceForKnowledgeItem: 5,
      };
    } else if (tier === 3) {
      defaults = {
        peakingWeeksNegVelocity: 2,
        decliningWeeksNegVelocity: 3,
        dormantThresholdWeeks: 4,
        baselineWindowDays: 30,
        baselineExclusionDays: 7,
        radarSurfaceMinSignalStrength: 40,
        platformWeights: {
          instagram: 1,
          tiktok: 1,
          reddit: 1,
          xiaohongshu: 1,
          google_trends: 1,
        },
      };
    }

    const updated = await storage.updatePipelineConfig(companyId, defaults);
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, "Failed to reset pipeline config tier");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/entity-synonyms
// ---------------------------------------------------------------------------
router.get("/companies/:id/entity-synonyms", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const filters: { language?: string; entityType?: string } = {};
    if (req.query.language) filters.language = req.query.language as string;
    if (req.query.entityType)
      filters.entityType = req.query.entityType as string;

    const synonyms = await storage.getEntitySynonyms(companyId, filters);
    res.json(synonyms);
  } catch (err: any) {
    logger.error({ err }, "Failed to get entity synonyms");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/entity-synonyms
// ---------------------------------------------------------------------------
router.post("/companies/:id/entity-synonyms", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const { alias, canonicalLabel, language, entityType, source } =
      req.body as {
        alias: string;
        canonicalLabel: string;
        language?: string;
        entityType: string;
        source?: string;
      };

    if (!alias || !canonicalLabel || !entityType) {
      res.status(400).json({ error: "alias, canonicalLabel, and entityType are required" });
      return;
    }

    const synonym = await storage.createEntitySynonym({
      companyId,
      alias,
      canonicalLabel,
      language,
      entityType,
      source: source ?? "manual",
    });
    res.status(201).json(synonym);
  } catch (err: any) {
    logger.error({ err }, "Failed to create entity synonym");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/pipeline/companies/:id/entity-synonyms/:synonymId
// ---------------------------------------------------------------------------
router.delete(
  "/companies/:id/entity-synonyms/:synonymId",
  async (req, res) => {
    try {
      const synonymId = parseInt(req.params.synonymId!, 10);
      await storage.deleteEntitySynonym(synonymId);
      res.json({ success: true });
    } catch (err: any) {
      logger.error({ err }, "Failed to delete entity synonym");
      res.status(500).json({ error: err.message });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/trends
// Returns enriched trends (entity state + knowledge item joined)
// ---------------------------------------------------------------------------
router.get("/companies/:id/trends", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const archived = req.query.archived !== undefined ? req.query.archived === "true" : undefined;
    const trends = await storage.getTrendsEnriched(companyId, { archived });
    res.json(trends);
  } catch (err: any) {
    logger.error({ err }, "Failed to get trends");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/trends/:trendId
// Returns enriched trend detail with evidence
// ---------------------------------------------------------------------------
router.get("/companies/:id/trends/:trendId", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const trendId = parseInt(req.params.trendId!, 10);
    const trend = await storage.getTrendDetail(companyId, trendId);
    if (!trend) {
      res.status(404).json({ error: "Trend not found" });
      return;
    }
    res.json(trend);
  } catch (err: any) {
    logger.error({ err }, "Failed to get trend detail");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/trends/:trendId/timeseries
// Returns combined social-mentions + Google-Trends interest series for the
// trend's primary entity. Both series are aligned by date.
// ---------------------------------------------------------------------------
router.get(
  "/companies/:id/trends/:trendId/timeseries",
  async (req, res) => {
    try {
      const companyId = parseInt(req.params.id!, 10);
      const trendId = parseInt(req.params.trendId!, 10);
      const windowDays = Math.min(
        Math.max(Number(req.query.windowDays ?? 90), 7),
        365
      );
      const series = await storage.getTrendTimeseries(
        companyId,
        trendId,
        windowDays
      );
      res.json(series);
    } catch (err: any) {
      req.log.error({ err }, "Failed to get trend timeseries");
      res.status(500).json({ error: err.message });
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/pipeline/trends/:id/status
// ---------------------------------------------------------------------------
router.patch("/trends/:id/status", async (req, res) => {
  try {
    const id = parseInt(req.params.id!, 10);
    const { status } = req.body as { status?: string };
    if (!status) {
      res.status(400).json({ error: "status is required" });
      return;
    }
    const updated = await storage.updateKnowledgeItem(id, { status });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, "Failed to update trend status");
    res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// AUDIT ROUTES — for observability into the pipeline
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/signals
// ?platform=&entityExtractionStatus=&limit=&offset=
// ---------------------------------------------------------------------------
router.get("/companies/:id/signals", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const filters: any = {
      limit: Math.min(Number(req.query.limit ?? 100), 500),
      offset: Number(req.query.offset ?? 0),
    };
    if (req.query.platform) filters.platform = req.query.platform as string;
    if (req.query.actorRunId) filters.actorRunId = Number(req.query.actorRunId);
    if (req.query.entityExtractionStatus) filters.entityExtractionStatus = req.query.entityExtractionStatus as string;

    const [signals, total] = await Promise.all([
      storage.getRawSignalsByCompany(companyId, filters),
      storage.getRawSignalCount(companyId, filters),
    ]);
    res.json({ signals, total });
  } catch (err: any) {
    logger.error({ err }, "Failed to get signals");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/signals/bulk-delete
// Body: { signalIds: number[] }
// Using POST instead of DELETE because some proxy layers strip DELETE request bodies.
// ---------------------------------------------------------------------------
router.post("/companies/:id/signals/bulk-delete", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const { signalIds } = req.body as { signalIds?: number[] };
    if (!Array.isArray(signalIds) || signalIds.length === 0) {
      res.status(400).json({ error: "signalIds must be a non-empty array" });
      return;
    }
    const deleted = await storage.deleteRawSignals(signalIds);
    res.json({ deleted });
  } catch (err: any) {
    logger.error({ err }, "Failed to bulk delete signals");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/entities
// ?entityType=
// ---------------------------------------------------------------------------
router.get("/companies/:id/entities", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const filters: any = {};
    if (req.query.entityType) filters.entityType = req.query.entityType as string;
    const entities = await storage.getEntities(companyId, filters);
    res.json(entities);
  } catch (err: any) {
    logger.error({ err }, "Failed to get entities");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/entity-states
// ?state=&geography=
// ---------------------------------------------------------------------------
router.get("/companies/:id/entity-states", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const filters: any = {};
    if (req.query.state) filters.state = req.query.state as string;
    if (req.query.geography) filters.geography = req.query.geography as string;
    const states = await storage.getEntityStateWithEntity(companyId, filters);
    res.json(states);
  } catch (err: any) {
    logger.error({ err }, "Failed to get entity states");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/entities/:id/timeseries?windowDays=90
// ---------------------------------------------------------------------------
router.get("/entities/:id/timeseries", async (req, res) => {
  try {
    const entityId = parseInt(req.params.id!, 10);
    const windowDays = Math.min(Number(req.query.windowDays ?? 90), 365);
    const rows = await storage.getEntityTimeseries(entityId, windowDays);
    res.json(rows);
  } catch (err: any) {
    logger.error({ err }, "Failed to get entity timeseries");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/run-ingestion
// Manually re-trigger ingestion for a specific actor run
// Body: { runId: number }
// ---------------------------------------------------------------------------
router.post("/companies/:id/run-ingestion", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const { runId } = req.body as { runId?: number };
    if (!runId) {
      res.status(400).json({ error: "runId is required" });
      return;
    }
    const run = await storage.getActorRun(runId);
    if (!run || run.companyId !== companyId) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    if (!run.apifyDatasetId) {
      res.status(400).json({ error: "Run has no dataset ID" });
      return;
    }

    // Reset ingestion status so it can be re-claimed
    await storage.updateActorRun(runId, { ingestionStatus: "pending" } as any);

    res.json({ ok: true, message: "Ingestion triggered" });

    // Fire async
    triggerIngestion(runId, run.apifyDatasetId).catch((e) =>
      logger.error({ err: e, runId }, "Manual ingestion trigger failed")
    );
  } catch (err: any) {
    logger.error({ err }, "Failed to trigger ingestion");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pipeline/companies/:id/run-status
// Returns live scope counts + last-run timestamps for the three manual
// pipeline steps (extraction, timeseries, state machine), plus per-run
// caps/defaults so the UI can show realistic time estimates.
// ---------------------------------------------------------------------------
router.get("/companies/:id/run-status", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const status = await storage.getPipelineRunStatus(companyId);
    res.json({
      ...status,
      // Per-run caps and timing assumptions used by the UI for estimates.
      // Keep these in sync with entity-extraction.ts defaults.
      meta: {
        extractionBatchSize: 20,
        extractionMaxBatches: 50,
        // Empirical: one OpenAI batch (20 signals) typically returns in 5-12s.
        // Use 8s as the midpoint for estimates.
        extractionSecondsPerBatch: 8,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to get pipeline run status");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/run-entity-extraction
// Manually run entity extraction pass
// ---------------------------------------------------------------------------
router.post("/companies/:id/run-entity-extraction", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    res.json({ ok: true, message: "Entity extraction started" });
    runEntityExtraction(companyId).catch((e) =>
      logger.error({ err: e, companyId }, "Manual entity extraction failed")
    );
  } catch (err: any) {
    logger.error({ err }, "Failed to start entity extraction");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/run-timeseries
// Manually trigger timeseries aggregation
// ---------------------------------------------------------------------------
router.post("/companies/:id/run-timeseries", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    res.json({ ok: true, message: "Timeseries aggregation started" });
    runTimeseriesAggregation(companyId)
      .then(() => storage.setLastTimeseriesRunAt(companyId))
      .catch((e) =>
        logger.error({ err: e, companyId }, "Manual timeseries aggregation failed")
      );
  } catch (err: any) {
    logger.error({ err }, "Failed to start timeseries aggregation");
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pipeline/companies/:id/run-state-machine
// Manually trigger state machine
// ---------------------------------------------------------------------------
router.post("/companies/:id/run-state-machine", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    res.json({ ok: true, message: "State machine started" });
    runStateMachine(companyId)
      .then(() => storage.setLastStateMachineRunAt(companyId))
      .catch((e) =>
        logger.error({ err: e, companyId }, "Manual state machine failed")
      );
  } catch (err: any) {
    logger.error({ err }, "Failed to start state machine");
    res.status(500).json({ error: err.message });
  }
});

export default router;
