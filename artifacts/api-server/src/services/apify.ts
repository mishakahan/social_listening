import { ApifyClient } from "apify-client";
import { logger } from "../lib/logger.js";

let _client: ApifyClient | null = null;

const ACTOR_MEMORY_MB: Record<string, number> = {
  "apify/instagram-scraper": 1024,
  "clockworks/tiktok-scraper": 2048,
  "trudax/reddit-scraper-lite": 1024,
  "easyapi/all-in-one-rednote-xiaohongshu-scraper": 1024,
  "apify/google-trends-scraper": 1024,
};

export function getActorMemoryMb(actorSlug: string): number {
  return ACTOR_MEMORY_MB[actorSlug] ?? 1024;
}



export function getApifyClient(): ApifyClient {
  if (!_client) {
    const token = process.env.APIFY_TOKEN;
    if (!token) throw new Error("APIFY_TOKEN environment variable is not set");
    _client = new ApifyClient({ token });
  }
  return _client;
}

// Derive the public webhook URL from environment
export function getWebhookBaseUrl(): string | null {
  if (process.env.SERVER_URL) return process.env.SERVER_URL;
  // Replit exposes the first domain in REPLIT_DOMAINS
  if (process.env.REPLIT_DOMAINS) {
    const domain = process.env.REPLIT_DOMAINS.split(",")[0]!.trim();
    return `https://${domain}`;
  }
  return null;
}

interface QueryInput {
  keywords: string[];
  hashtags: string[];
  language: string;
  geography: string;
  topicLabel: string;
}

// Normalize geography to a 2-letter ISO code accepted by Google Trends, or "" for global.
function normalizeGeo(geography: string): string {
  if (!geography || geography === "Global") return "";
  if (/^[A-Z]{2}$/.test(geography)) return geography;
  return "";
}

// Default backfill window (months) for actors that support a date range.
const BACKFILL_MONTHS = 6;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Returns { afterDate, beforeDate } for a BACKFILL_MONTHS window ending at `today`.
function backfillWindow(today: Date): { afterDate: string; beforeDate: string } {
  const after = new Date(today);
  after.setMonth(after.getMonth() - BACKFILL_MONTHS);
  return { afterDate: ymd(after), beforeDate: ymd(today) };
}

// Map our generic query payload to the input format each actor expects.
// `today` is injectable for deterministic date-window tests.
export function buildActorInput(
  actorSlug: string,
  runMode: string,
  input: QueryInput,
  today: Date = new Date()
): Record<string, unknown> {
  const tags = input.hashtags.map((h) => (h.startsWith("#") ? h.slice(1) : h));
  const kws = input.keywords;
  const geo = normalizeGeo(input.geography);

  switch (actorSlug) {
    case "apify/instagram-scraper":
      // apify/instagram-scraper v3+ expects directUrls for hashtag exploration
      return {
        directUrls: tags.map((h) => `https://www.instagram.com/explore/tags/${encodeURIComponent(h)}/`),
        resultsType: runMode === "backfill:ig_reels" ? "reels" : "posts",
        resultsLimit: 200,
        addParentData: false,
      };

    case "clockworks/tiktok-scraper":
      return {
        hashtags: tags,
        keywords: kws,
        maxItems: 200,
        ...(geo ? { countryCode: geo } : {}),
      };

    case "benthepythondev/reddit-archive-scraper": {
      // Archive actor (PullPush) supports a true after/before date window, so we
      // can do a real 6-month backfill. It takes a single searchQuery, so we use
      // the primary keyword. Comments are the cost driver and irrelevant to
      // mention counts, so they stay off.
      const primary = (kws.find((k) => k.trim().length > 0) ?? input.topicLabel).trim();
      const { afterDate, beforeDate } = backfillWindow(today);
      return {
        searchQuery: primary,
        afterDate,
        beforeDate,
        maxPosts: 200,
        includeComments: false,
      };
    }

    case "trudax/reddit-scraper-lite": {
      // Reddit doesn't use hashtags. Run one search per keyword instead of joining
      // them into a literal multi-word phrase, which on Reddit's relevance search
      // typically returns near-zero results.
      const searches = kws.map((k) => k.trim()).filter((k) => k.length > 0);
      // Cap maxItems per search so total budget across N searches stays sane (~100 items).
      const perSearchCap = Math.max(10, Math.floor(100 / Math.max(1, searches.length)));
      return {
        searches,
        maxItems: perSearchCap,
        sort: "relevance",
      };
    }

    case "easyapi/all-in-one-rednote-xiaohongshu-scraper":
      return {
        keywords: kws.concat(tags),
        maxItems: 200,
      };

    case "apify/google-trends-scraper":
      return {
        searchTerms: kws.slice(0, 5),
        geo,
        timeRange: "today 3-m",
      };

    default:
      logger.warn({ actorSlug }, "Unknown actor slug — using generic input");
      return { keywords: kws, hashtags: tags };
  }
}

// Map Apify's terminal status strings to our internal status
export function mapApifyStatus(
  apifyStatus: string
): "running" | "succeeded" | "failed" | "timeout" {
  switch (apifyStatus) {
    case "SUCCEEDED":
      return "succeeded";
    case "FAILED":
    case "ABORTED":
      return "failed";
    case "TIMED-OUT":
      return "timeout";
    default:
      return "running";
  }
}
