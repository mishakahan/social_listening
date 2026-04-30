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

// Map our generic query payload to the input format each actor expects
export function buildActorInput(
  actorSlug: string,
  runMode: string,
  input: QueryInput
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

    case "trudax/reddit-scraper-lite":
      // Reddit doesn't use hashtags; "site:reddit.com" is Google syntax and breaks native Reddit search.
      // Join all keywords into one focused query rather than running a separate search per term.
      return {
        searches: [kws.join(" ")].filter(Boolean),
        maxItems: 100,
        sort: "relevance",
      };

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
