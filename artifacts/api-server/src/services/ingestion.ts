import { franc } from "franc";
import { logger } from "../lib/logger.js";
import * as storage from "../storage/index.js";
import type {
  TpActorRun,
  TpPipelineConfig,
  InsertTpRawSignal,
  InsertTpKeywordInterest,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// Author tier classification
// ---------------------------------------------------------------------------

function classifyAuthorTier(followers: number | null | undefined): string {
  if (!followers || followers < 1_000) return "nano";
  if (followers < 10_000) return "micro";
  if (followers < 100_000) return "mid";
  if (followers < 1_000_000) return "macro";
  return "mega";
}

// ---------------------------------------------------------------------------
// Engagement scoring per platform
// ---------------------------------------------------------------------------

interface EngagementValues {
  likes: number;
  comments: number;
  shares: number;
  views: number;
  saves: number;
}

function computeEngagement(
  platform: string,
  values: EngagementValues,
  weights: Record<string, Record<string, number>>
): { score: number; composite: number } {
  const w = weights[platform] ?? weights["instagram"] ?? {};
  let score = 0;
  // Reddit's weight config uses "score" as the key for upvotes; all other platforms use "likes"
  score += values.likes * (w["likes"] ?? w["score"] ?? 0);
  score += values.comments * (w["comments"] ?? 0);
  score += values.shares * (w["shares"] ?? 0);
  score += values.views * (w["views"] ?? 0);
  score += values.saves * (w["saves"] ?? 0);
  return { score: Math.round(score), composite: score };
}

// ---------------------------------------------------------------------------
// Language detection (franc returns ISO 639-3 codes)
// ---------------------------------------------------------------------------

// franc returns ISO 639-3; scout queries use ISO 639-1. Map the common ones.
const ISO3_TO_ISO1: Record<string, string> = {
  eng: "en", deu: "de", fra: "fr", ita: "it", spa: "es", por: "pt",
  nld: "nl", zho: "zh-CN", jpn: "ja", kor: "ko", rus: "ru", arb: "ar",
};

function detectLanguage(text: string | null | undefined): { language: string | null; confidence: number } {
  if (!text || text.length < 20) return { language: null, confidence: 0 };
  try {
    const lang3 = franc(text, { minLength: 10 });
    if (lang3 === "und") return { language: null, confidence: 0 };
    const language = ISO3_TO_ISO1[lang3] ?? lang3;
    const confidence = Math.min(0.5 + text.length / 500, 0.99);
    return { language, confidence };
  } catch {
    return { language: null, confidence: 0 };
  }
}

// ---------------------------------------------------------------------------
// Per-platform normalizers
// Each returns null if the item should be dropped (malformed / no useful content)
// ---------------------------------------------------------------------------

type NormalizedSignal = Omit<InsertTpRawSignal, "companyId" | "actorRunId" | "scoutQueryId">;

function normalizeInstagram(item: Record<string, unknown>): NormalizedSignal | null {
  const sourceId = String(item["id"] ?? item["shortCode"] ?? "");
  if (!sourceId) return null;
  const text = String(item["caption"] ?? item["text"] ?? "");
  const { language, confidence } = detectLanguage(text);
  const authorFollowers = Number(item["ownerFollowersCount"] ?? 0) || null;
  const hashtags = Array.isArray(item["hashtags"]) ? item["hashtags"].map(String) : [];
  const mentions = Array.isArray(item["mentions"]) ? item["mentions"].map(String) : [];
  const postedAt = item["timestamp"] ? new Date(String(item["timestamp"])) : null;
  const engLikes    = Number(item["likesCount"] ?? 0);
  const engComments = Number(item["commentsCount"] ?? 0);
  const engShares   = Number(item["sharesCount"] ?? item["reposts"] ?? 0);
  const engViews    = Number(item["videoViewCount"] ?? 0);
  const { score, composite } = computeEngagement("instagram",
    { likes: engLikes, comments: engComments, shares: engShares, views: engViews, saves: 0 },
    { instagram: { likes: 1, comments: 3, shares: 5, views: 0.1 } }
  );
  return {
    platform: "instagram",
    sourceActor: "apify/instagram-scraper",
    sourceId,
    sourceUrl: item["url"] ? String(item["url"]) : null,
    postedAt,
    authorHandle: item["ownerUsername"] ? String(item["ownerUsername"]) : null,
    authorFollowers,
    authorTier: classifyAuthorTier(authorFollowers),
    authorVerified: Boolean(item["verified"] ?? false),
    text: text || null,
    hashtags,
    mentions,
    language,
    languageConfidence: confidence || null,
    geography: null,
    engagementLikes: engLikes || null,
    engagementComments: engComments || null,
    engagementShares: engShares || null,
    engagementViews: engViews || null,
    engagementSaves: null,
    engagementScore: score,
    engagementComposite: composite,
    commercialIntent: false,
    commercialIntentConfidence: null,
    backfillDerived: false,
    retainReason: null,
    raw: item,
    metadata: {},
  };
}

function normalizeTikTok(item: Record<string, unknown>): NormalizedSignal | null {
  const sourceId = String(item["id"] ?? "");
  if (!sourceId) return null;
  const text = String(item["text"] ?? item["desc"] ?? "");
  const { language, confidence } = detectLanguage(text);
  const authorMeta = item["authorMeta"] as Record<string, unknown> | undefined;
  const authorFollowers = Number(authorMeta?.["fans"] ?? item["authorFollowers"] ?? 0) || null;
  const hashtags = Array.isArray(item["hashtags"])
    ? item["hashtags"].map((h: unknown) => (typeof h === "object" && h !== null && "name" in h ? String((h as any)["name"]) : String(h)))
    : [];
  const postedAt = item["createTime"]
    ? new Date(Number(item["createTime"]) * 1000)
    : item["createTimeISO"]
    ? new Date(String(item["createTimeISO"]))
    : null;
  // Apify TikTok scraper uses diggCount/commentCount/shareCount/playCount
  const engLikes    = Number(item["diggCount"] ?? item["likesCount"] ?? 0);
  const engComments = Number(item["commentCount"] ?? item["commentsCount"] ?? 0);
  const engShares   = Number(item["shareCount"] ?? item["sharesCount"] ?? 0);
  const engViews    = Number(item["playCount"] ?? item["videoViewCount"] ?? 0);
  const { score, composite } = computeEngagement("tiktok",
    { likes: engLikes, comments: engComments, shares: engShares, views: engViews, saves: 0 },
    { tiktok: { likes: 1, comments: 5, shares: 3, views: 0.05 } }
  );
  return {
    platform: "tiktok",
    sourceActor: "clockworks/tiktok-scraper",
    sourceId,
    sourceUrl: item["webVideoUrl"] ? String(item["webVideoUrl"]) : null,
    postedAt,
    authorHandle: authorMeta?.["name"] ? String(authorMeta["name"]) : null,
    authorFollowers,
    authorTier: classifyAuthorTier(authorFollowers),
    authorVerified: Boolean(authorMeta?.["verified"] ?? false),
    text: text || null,
    hashtags,
    mentions: [],
    language,
    languageConfidence: confidence || null,
    geography: null,
    engagementLikes: engLikes || null,
    engagementComments: engComments || null,
    engagementShares: engShares || null,
    engagementViews: engViews || null,
    engagementSaves: null,
    engagementScore: score,
    engagementComposite: composite,
    commercialIntent: false,
    commercialIntentConfidence: null,
    backfillDerived: false,
    retainReason: null,
    raw: item,
    metadata: {},
  };
}

function normalizeReddit(item: Record<string, unknown>): NormalizedSignal | null {
  const sourceId = String(item["id"] ?? "");
  if (!sourceId) return null;
  const title = String(item["title"] ?? "");
  const body = String(item["body"] ?? item["selftext"] ?? "");
  const text = [title, body].filter(Boolean).join(" ");
  const { language, confidence } = detectLanguage(text);
  const postedAt = item["createdAt"]
    ? new Date(String(item["createdAt"]))
    : item["created"]
    ? new Date(Number(item["created"]) * 1000)
    : null;
  // trudax/reddit-scraper-lite uses upVotes, numberOfComments, username, link
  const engScore    = Number(item["upVotes"] ?? item["score"] ?? item["ups"] ?? 0);
  const engComments = Number(item["numberOfComments"] ?? item["numComments"] ?? item["num_comments"] ?? 0);
  const { score, composite } = computeEngagement("reddit",
    { likes: engScore, comments: engComments, shares: 0, views: 0, saves: 0 },
    { reddit: { score: 1, comments: 2 } }
  );
  return {
    platform: "reddit",
    sourceActor: "trudax/reddit-scraper-lite",
    sourceId,
    sourceUrl: String(item["link"] ?? item["url"] ?? ""),
    postedAt,
    authorHandle: String(item["username"] ?? item["author"] ?? "") || null,
    authorFollowers: null,
    authorTier: "nano",
    authorVerified: false,
    text: text || null,
    hashtags: [],
    mentions: [],
    language,
    languageConfidence: confidence || null,
    geography: null,
    engagementLikes: engScore || null,
    engagementComments: engComments || null,
    engagementShares: null,
    engagementViews: null,
    engagementSaves: null,
    engagementScore: score,
    engagementComposite: composite,
    commercialIntent: false,
    commercialIntentConfidence: null,
    backfillDerived: false,
    retainReason: null,
    raw: item,
    metadata: {},
  };
}

function normalizeXhs(item: Record<string, unknown>): NormalizedSignal | null {
  const sourceId = String(item["id"] ?? item["noteId"] ?? "");
  if (!sourceId) return null;
  const text = String(item["title"] ?? item["desc"] ?? item["content"] ?? "");
  const { language, confidence } = detectLanguage(text);
  const userMeta = item["user"] as Record<string, unknown> | undefined;
  const authorFollowers = Number(userMeta?.["fans"] ?? item["authorFollowers"] ?? 0) || null;
  const hashtags = Array.isArray(item["tagList"])
    ? item["tagList"].map((t: unknown) => (typeof t === "object" && t !== null && "name" in t ? String((t as any)["name"]) : String(t)))
    : [];
  const postedAt = item["time"] ? new Date(Number(item["time"]) * 1000) : null;
  const engLikes    = Number(item["likes"] ?? item["likedCount"] ?? 0);
  const engComments = Number(item["comments"] ?? item["commentCount"] ?? 0);
  const engShares   = Number(item["shares"] ?? item["shareCount"] ?? 0);
  const engSaves    = Number(item["collected"] ?? item["collectedCount"] ?? item["saves"] ?? 0);
  const { score, composite } = computeEngagement("xiaohongshu",
    { likes: engLikes, comments: engComments, shares: engShares, views: 0, saves: engSaves },
    { xiaohongshu: { likes: 1, comments: 3, shares: 2, views: 0.1, saves: 4 } }
  );
  return {
    platform: "xiaohongshu",
    sourceActor: "easyapi/all-in-one-rednote-xiaohongshu-scraper",
    sourceId,
    sourceUrl: item["url"] ? String(item["url"]) : null,
    postedAt,
    authorHandle: userMeta?.["nickname"] ? String(userMeta["nickname"]) : null,
    authorFollowers,
    authorTier: classifyAuthorTier(authorFollowers),
    authorVerified: Boolean(userMeta?.["verified"] ?? false),
    text: text || null,
    hashtags,
    mentions: [],
    language,
    languageConfidence: confidence || null,
    geography: "CN",
    engagementLikes: engLikes || null,
    engagementComments: engComments || null,
    engagementShares: engShares || null,
    engagementViews: null,
    engagementSaves: engSaves || null,
    engagementScore: score,
    engagementComposite: composite,
    commercialIntent: false,
    commercialIntentConfidence: null,
    backfillDerived: false,
    retainReason: null,
    raw: item,
    metadata: {},
  };
}

// Google Trends is handled via a separate writer (not normalizeItem) because
// its data shape is a relative 0-100 search-interest time series, not social
// posts. See `extractKeywordInterestRows` and `ingestGoogleTrendsRun` below.

function normalizeItem(
  platform: string,
  item: Record<string, unknown>
): NormalizedSignal | null {
  switch (platform) {
    case "instagram": return normalizeInstagram(item);
    case "tiktok": return normalizeTikTok(item);
    case "reddit": return normalizeReddit(item);
    case "xiaohongshu": return normalizeXhs(item);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Google Trends extraction → tp_keyword_interest rows
// ---------------------------------------------------------------------------

function toIsoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const str = String(value);
  // Apify google-trends emits ISO strings like "2025-04-12T00:00:00.000Z" and
  // also formatted strings like "Apr 12, 2025". Try Date parse for both.
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

interface ExtractedInterestRow {
  keyword: string;
  geo: string;
  bucketDate: string;
  interestValue: number;
}

function clampInterest(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

interface ExtractStats {
  rows: ExtractedInterestRow[];
  itemsWithRows: number;   // dataset items that produced at least one row
  itemsDropped: number;    // dataset items that produced zero rows
}

function extractKeywordInterestRowsWithStats(
  items: unknown[]
): ExtractStats {
  const rows: ExtractedInterestRow[] = [];
  let itemsWithRows = 0;
  let itemsDropped = 0;

  for (const raw of items) {
    if (!raw || typeof raw !== "object") {
      itemsDropped++;
      continue;
    }
    const item = raw as Record<string, unknown>;
    const before = rows.length;

    // Top-level fields shared across most google-trends-scraper output shapes.
    const geo = String(item["geo"] ?? item["country"] ?? "");
    const topKeyword = item["keyword"] ?? item["searchTerm"] ?? item["term"];
    const topKeywordStr = topKeyword == null ? null : String(topKeyword).trim() || null;

    // The scraper sometimes ships an array of keywords for a multi-keyword query
    // (parallel arrays with `values`/`value`). Capture it for that case.
    const itemKeywords: string[] | null = (() => {
      const k = item["keywords"] ?? item["queries"];
      if (Array.isArray(k)) return k.map((v) => String(v).trim()).filter(Boolean);
      return null;
    })();

    // Shape A: each item already represents a single (keyword, date, value).
    const flatDate = toIsoDate(item["date"] ?? item["formattedTime"] ?? item["time"]);
    const flatValue = item["value"] ?? item["extractedValue"];
    if (topKeywordStr && flatDate && flatValue != null && !Array.isArray(flatValue)) {
      const num = Number(flatValue);
      if (Number.isFinite(num)) {
        rows.push({
          keyword: topKeywordStr,
          geo,
          bucketDate: flatDate,
          interestValue: clampInterest(num),
        });
      }
      if (rows.length > before) itemsWithRows++;
      else itemsDropped++;
      continue;
    }

    // Shape B: item carries an `interestOverTime` (or similar) array of points.
    const series =
      (item["interestOverTime"] as unknown) ??
      (item["interest_over_time"] as unknown) ??
      (item["timelineData"] as unknown) ??
      (item["data"] as unknown);
    if (!Array.isArray(series)) {
      itemsDropped++;
      continue;
    }

    for (const pointRaw of series) {
      if (!pointRaw || typeof pointRaw !== "object") continue;
      const point = pointRaw as Record<string, unknown>;
      const date = toIsoDate(point["date"] ?? point["formattedTime"] ?? point["time"]);
      if (!date) continue;

      // Possible value shapes inside a point:
      //   { value: number }                                        -> single (uses topKeyword)
      //   { value: number[] }                                      -> parallel array (uses itemKeywords / topKeyword)
      //   { values: number[] }                                     -> parallel array (uses itemKeywords / topKeyword)
      //   { values: [{ keyword, value }, ...] }                    -> tagged objects
      //   { [keyword]: number, ... }                               -> keyed map (rare)
      const values = point["values"];
      const value = point["value"];

      // (1) values is an array of tagged objects
      if (Array.isArray(values) && values.length > 0 && typeof values[0] === "object" && values[0] !== null) {
        for (const v of values) {
          if (!v || typeof v !== "object") continue;
          const vv = v as Record<string, unknown>;
          const kw = String(vv["keyword"] ?? vv["query"] ?? topKeywordStr ?? "").trim();
          const num = Number(vv["value"] ?? vv["extractedValue"]);
          if (!kw || !Number.isFinite(num)) continue;
          rows.push({ keyword: kw, geo, bucketDate: date, interestValue: clampInterest(num) });
        }
        continue;
      }

      // (2) values is an array of numbers (parallel to itemKeywords/topKeyword)
      if (Array.isArray(values) && values.every((v) => typeof v === "number")) {
        const nums = values as number[];
        const keywordsForPoint =
          itemKeywords && itemKeywords.length === nums.length
            ? itemKeywords
            : topKeywordStr
              ? Array(nums.length).fill(topKeywordStr)
              : null;
        if (!keywordsForPoint) continue;
        for (let i = 0; i < nums.length; i++) {
          const kw = keywordsForPoint[i];
          if (!kw || !Number.isFinite(nums[i]!)) continue;
          rows.push({ keyword: kw, geo, bucketDate: date, interestValue: clampInterest(nums[i]!) });
        }
        continue;
      }

      // (3) value is an array of numbers (parallel array variant)
      if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
        const nums = value as number[];
        const keywordsForPoint =
          itemKeywords && itemKeywords.length === nums.length
            ? itemKeywords
            : topKeywordStr
              ? Array(nums.length).fill(topKeywordStr)
              : null;
        if (!keywordsForPoint) continue;
        for (let i = 0; i < nums.length; i++) {
          const kw = keywordsForPoint[i];
          if (!kw || !Number.isFinite(nums[i]!)) continue;
          rows.push({ keyword: kw, geo, bucketDate: date, interestValue: clampInterest(nums[i]!) });
        }
        continue;
      }

      // (4) single scalar value -> pair with topKeyword
      const scalar = value ?? point["extractedValue"];
      if (scalar != null && !Array.isArray(scalar) && topKeywordStr) {
        const num = Number(scalar);
        if (Number.isFinite(num)) {
          rows.push({ keyword: topKeywordStr, geo, bucketDate: date, interestValue: clampInterest(num) });
        }
        continue;
      }

      // (5) keyed-map shape: every other own-property is a number keyed by keyword
      const keyedRows: ExtractedInterestRow[] = [];
      for (const [k, v] of Object.entries(point)) {
        if (k === "date" || k === "formattedTime" || k === "time" || k === "value" || k === "values" || k === "extractedValue") continue;
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        keyedRows.push({ keyword: k, geo, bucketDate: date, interestValue: clampInterest(v) });
      }
      if (keyedRows.length > 0) rows.push(...keyedRows);
    }

    if (rows.length > before) itemsWithRows++;
    else itemsDropped++;
  }

  return { rows, itemsWithRows, itemsDropped };
}

// Internal export for unit smoke tests only — not part of the public API.
export const __testExtract = extractKeywordInterestRowsWithStats;

export async function ingestGoogleTrendsRun(
  run: TpActorRun,
  datasetItems: unknown[]
): Promise<{ usable: number; dropped: number }> {
  const claimed = await storage.claimIngestion(run.id);
  if (!claimed) {
    logger.info({ runId: run.id }, "Ingestion already claimed by another worker — skipping");
    return { usable: 0, dropped: 0 };
  }

  try {
    const { rows: extracted, itemsDropped } = extractKeywordInterestRowsWithStats(datasetItems);

    const rows: InsertTpKeywordInterest[] = extracted.map((e) => ({
      companyId: run.companyId,
      actorRunId: run.id,
      keyword: e.keyword,
      geo: e.geo,
      bucketDate: e.bucketDate,
      interestValue: e.interestValue,
    }));

    const { upserted } = await storage.bulkUpsertKeywordInterest(rows);
    const usable = upserted;
    // Count dropped at the *dataset-item* level so the metric stays
    // comparable across runs that produce many time-buckets per item.
    const dropped = itemsDropped;

    const dates = extracted.map((e) => new Date(e.bucketDate).getTime()).filter((n) => Number.isFinite(n));
    const oldestPostedAt = dates.length ? new Date(Math.min(...dates)) : null;
    const newestPostedAt = dates.length ? new Date(Math.max(...dates)) : null;

    await storage.markIngestionDone(run.id, { usable, dropped, oldestPostedAt, newestPostedAt });

    if (run.scoutQueryId) {
      await storage.incrementScoutQueryCounters(run.scoutQueryId, {
        fetched: datasetItems.length,
        usable,
      });
    }

    logger.info(
      { runId: run.id, platform: run.platform, usable, dropped },
      "Google Trends ingestion complete"
    );
    return { usable, dropped };
  } catch (err: any) {
    await storage.markIngestionFailed(run.id, err.message ?? "Unknown ingestion error");
    logger.error({ err, runId: run.id }, "Google Trends ingestion failed");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Noise filter
// ---------------------------------------------------------------------------

function passesNoiseFloor(
  signal: NormalizedSignal,
  config: TpPipelineConfig
): boolean {
  return (signal.engagementScore ?? 0) >= config.noiseFloor;
}

function passesLanguageFilter(
  signal: NormalizedSignal,
  config: TpPipelineConfig,
  targetLanguages: string[]
): boolean {
  // If no target languages configured, accept everything
  if (targetLanguages.length === 0) return true;
  // Reddit posts are often in English regardless of query language, so only filter out
  // high-confidence language mismatches (require 0.8+ confidence before rejecting).
  if (signal.platform === "reddit") {
    if (!signal.language || signal.languageConfidence == null || signal.languageConfidence < 0.8) return true;
    return targetLanguages.includes(signal.language);
  }
  // If no language detected, accept (we don't want to over-filter)
  if (!signal.language) return true;
  // Check if language confidence meets threshold
  if (
    signal.languageConfidence != null &&
    signal.languageConfidence < config.languageConfidenceThreshold
  ) {
    return true; // low confidence → don't use language to reject
  }
  return targetLanguages.includes(signal.language);
}

// ---------------------------------------------------------------------------
// Main ingestion entry point
// ---------------------------------------------------------------------------

export async function ingestActorRun(
  run: TpActorRun,
  datasetItems: unknown[],
  options: { skipMarkDone?: boolean } = {}
): Promise<{
  claimed: boolean;
  usable: number;
  dropped: number;
  oldestPostedAt: Date | null;
  newestPostedAt: Date | null;
}> {
  const claimed = await storage.claimIngestion(run.id);
  if (!claimed) {
    logger.info({ runId: run.id }, "Ingestion already claimed by another worker — skipping");
    return { claimed: false, usable: 0, dropped: 0, oldestPostedAt: null, newestPostedAt: null };
  }

  try {
    const config = await storage.getPipelineConfig(run.companyId);
    const query = run.scoutQueryId
      ? await storage.getScoutQuery(run.scoutQueryId)
      : null;
    const targetLanguages: string[] = (query?.language ? [query.language] : []);

    const signals: InsertTpRawSignal[] = [];
    let dropped = 0;

    for (const rawItem of datasetItems) {
      if (!rawItem || typeof rawItem !== "object") { dropped++; continue; }
      const item = rawItem as Record<string, unknown>;

      const normalized = normalizeItem(run.platform, item);
      if (!normalized) { dropped++; continue; }

      if (!passesNoiseFloor(normalized, config)) { dropped++; continue; }
      if (!passesLanguageFilter(normalized, config, targetLanguages)) { dropped++; continue; }

      signals.push({
        ...normalized,
        companyId: run.companyId,
        actorRunId: run.id,
        scoutQueryId: run.scoutQueryId ?? undefined,
      } as InsertTpRawSignal);
    }

    const { inserted } = await storage.bulkInsertRawSignals(signals);
    const usable = inserted;
    dropped += signals.length - inserted; // duplicates

    // Compute date range
    const datedSignals = signals.filter((s) => s.postedAt instanceof Date);
    const dates = datedSignals.map((s) => (s.postedAt as Date).getTime());
    const oldestPostedAt = dates.length ? new Date(Math.min(...dates)) : null;
    const newestPostedAt = dates.length ? new Date(Math.max(...dates)) : null;

    if (!options.skipMarkDone) {
      await storage.markIngestionDone(run.id, { usable, dropped, oldestPostedAt, newestPostedAt });
    }

    // Update scout query counters
    if (run.scoutQueryId) {
      await storage.incrementScoutQueryCounters(run.scoutQueryId, {
        fetched: datasetItems.length,
        usable,
      });
    }

    logger.info(
      { runId: run.id, platform: run.platform, usable, dropped, deferred: !!options.skipMarkDone },
      "Ingestion complete"
    );
    return { claimed: true, usable, dropped, oldestPostedAt, newestPostedAt };
  } catch (err: any) {
    await storage.markIngestionFailed(run.id, err.message ?? "Unknown ingestion error");
    logger.error({ err, runId: run.id }, "Ingestion failed");
    throw err;
  }
}
