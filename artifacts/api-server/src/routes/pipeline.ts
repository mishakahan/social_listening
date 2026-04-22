import { Router } from "express";
import * as storage from "../storage/index.js";
import {
  generateSeedCandidates,
  generateScoutQueriesForSeed,
  type SeedCandidateItem,
  type CompanyContext,
} from "../services/radar-setup-bot.js";
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

    const resolvedUserId = userId ?? 1;

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

    // Get all scout queries for the company
    const queries = await storage.getScoutQueries(companyId);

    const actorRunIds: number[] = [];
    const COST_PER_RUN = 0.05; // USD estimate per run

    for (const query of queries) {
      // Flip active=true
      await storage.updateScoutQuery(query.id, { active: true });

      // Determine platforms based on query language/geography
      const platforms: { platform: string; runMode: string; actorSlug: string }[] =
        [];

      // IG: always 2 runs
      platforms.push({
        platform: "instagram",
        runMode: "backfill:ig_posts",
        actorSlug: "apify/instagram-scraper",
      });
      platforms.push({
        platform: "instagram",
        runMode: "backfill:ig_reels",
        actorSlug: "apify/instagram-reel-scraper",
      });

      // TikTok: 1 run
      platforms.push({
        platform: "tiktok",
        runMode: "backfill:tiktok",
        actorSlug: "clockworks/tiktok-scraper",
      });

      // Reddit: up to 2 runs
      if (query.keywords && query.keywords.length > 0) {
        platforms.push({
          platform: "reddit",
          runMode: "backfill:reddit_search",
          actorSlug: "trudax/reddit-scraper",
        });
      }
      // Reddit subreddits (simplified: always add if not zh-CN)
      if (query.language !== "zh-CN") {
        platforms.push({
          platform: "reddit",
          runMode: "backfill:reddit_subreddits",
          actorSlug: "trudax/reddit-scraper",
        });
      }

      // XHS: if language is zh-CN
      if (query.language === "zh-CN") {
        platforms.push({
          platform: "xiaohongshu",
          runMode: "backfill:xhs_search",
          actorSlug: "easyapi/xhs-scraper",
        });
      }

      // Google Trends: if geography is not CN
      if (query.geography !== "CN") {
        platforms.push({
          platform: "google_trends",
          runMode: "backfill:google_trends",
          actorSlug: "apify/google-trends-scraper",
        });
      }

      for (const p of platforms) {
        const run = await storage.createActorRun({
          companyId,
          scoutQueryId: query.id,
          actorSlug: p.actorSlug,
          platform: p.platform,
          runMode: p.runMode,
          status: "queued",
          inputPayload: {
            keywords: query.keywords,
            hashtags: query.hashtags,
            language: query.language,
            geography: query.geography,
            topicLabel: query.topicLabel,
          },
        });
        actorRunIds.push(run.id);
      }
    }

    const estimatedCostUsd = actorRunIds.length * COST_PER_RUN;

    res.json({ success: true, actorRunIds, estimatedCostUsd });
  } catch (err: any) {
    logger.error({ err }, "Failed to launch scout queries");
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
    const updated = await storage.updateActorRun(id, {
      status: "queued",
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    });
    res.json(updated);
  } catch (err: any) {
    logger.error({ err }, "Failed to retry actor run");
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
  try {
    const body = req.body as {
      eventType?: string;
      actorRunId?: string;
      status?: string;
      resource?: { id?: string; status?: string; defaultDatasetId?: string };
    };

    logger.info({ body }, "Received Apify webhook");

    // Try to find the actor run by apify run id
    const apifyRunId =
      body.resource?.id ?? body.actorRunId;
    const apifyStatus = body.resource?.status ?? body.status;

    if (apifyRunId) {
      // Find runs with this apify run id (we'd need a query, but for now
      // we mark by any run that matches - simplified implementation)
      const newStatus =
        apifyStatus === "SUCCEEDED"
          ? "succeeded"
          : apifyStatus === "FAILED"
          ? "failed"
          : "running";

      logger.info({ apifyRunId, newStatus }, "Apify webhook processed");
    }

    res.status(200).json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "Failed to process Apify webhook");
    res.status(500).json({ error: err.message });
  }
});

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
router.patch("/companies/:id/pipeline-config", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const updated = await storage.updatePipelineConfig(companyId, req.body);
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
// Returns knowledgeItems with type='trend_signal'
// ---------------------------------------------------------------------------
router.get("/companies/:id/trends", async (req, res) => {
  try {
    const companyId = parseInt(req.params.id!, 10);
    const filters: { type?: string; state?: string; archived?: boolean } = {
      type: "trend_signal",
    };
    if (req.query.state) filters.state = req.query.state as string;
    if (req.query.archived !== undefined)
      filters.archived = req.query.archived === "true";

    const items = await storage.getKnowledgeItems(companyId, filters);
    res.json(items);
  } catch (err: any) {
    logger.error({ err }, "Failed to get trends");
    res.status(500).json({ error: err.message });
  }
});

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

export default router;
