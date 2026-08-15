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

// Apify can't reach localhost / private hosts, and rejects such webhook URLs
// at launch. Treat those as "no public URL" so the pipeline falls back to
// polling instead of sending an unreachable webhook.
function isPubliclyReachable(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

// Derive the public webhook URL from environment. Returns null when there is no
// publicly reachable URL (e.g. local dev), so runs are polled instead.
export function getWebhookBaseUrl(): string | null {
  if (process.env.SERVER_URL && isPubliclyReachable(process.env.SERVER_URL)) {
    return process.env.SERVER_URL;
  }
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

// Per-actor result cap. Env-overridable so a cheap verification pass can use a
// small cap (e.g. 40) before a full-depth run at the default 200.
export const RESULT_CAP = Number(process.env.BACKFILL_RESULT_CAP ?? "200") || 200;

// Instagram is by far the most expensive actor per result (~85% of scrape
// cost), so it gets its own, smaller cap. Trend detection needs enough posts
// to measure volume + author diversity, not hundreds. Env-overridable.
export const IG_RESULT_CAP = Number(process.env.IG_RESULT_CAP ?? "40") || 40;

// Cap how many hashtag variants we expand to on IG — each variant is a
// separate (billed) scrape, so we keep this small. Popular tags don't need
// singular+plural both; this mainly helps sparse/niche tags.
export const IG_MAX_VARIANT_TAGS = Number(process.env.IG_MAX_VARIANT_TAGS ?? "4") || 4;

// YouTube gets its OWN result cap, separate from the shared RESULT_CAP.
//
// MEASURED 2026-08-07: streamers/youtube-scraper applies `maxResults` PER
// SEARCH QUERY, not per run. Across all 41 successful YouTube runs in the DB,
// records_fetched / keyword count is exactly the cap (40.0 at cap 40, 50.0 at
// cap 50) and cost_usd / keyword count is exactly $0.12 (at cap 40) — i.e.
// a YouTube run's records, and therefore its cost, are
// (keywords x cap), not (cap). Company 2's single YouTube run fetched
// 38 keywords x 40 = 1,520 records and cost $4.56 in tp_actor_runs.cost_usd,
// which itself undercounts real Apify billing ~4x (~$18 real for ONE run).
//
// Letting YouTube inherit the shared RESULT_CAP of 200 therefore multiplies
// its bill by 5x against the only setting we have ever actually measured.
// Default 40: the value every measured YouTube run used, and the one that
// produced this project's best entity yield of any platform (320 distinct
// entities from a single 38-keyword run). Raise it only alongside a
// correspondingly lower YOUTUBE_MAX_KEYWORDS — the product of the two is what
// gets billed.
export const YOUTUBE_RESULT_CAP =
  Number(process.env.YOUTUBE_RESULT_CAP ?? "40") || 40;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Returns { afterDate, beforeDate } for a BACKFILL_MONTHS window ending at `today`.
function backfillWindow(today: Date): { afterDate: string; beforeDate: string } {
  const after = new Date(today);
  after.setMonth(after.getMonth() - BACKFILL_MONTHS);
  return { afterDate: ymd(after), beforeDate: ymd(today) };
}

// Instagram matches EXACT hashtag strings, so #functionalgummies and
// #functionalgummy are different tags. To avoid missing a variant the
// generator didn't emit, expand each tag into a small, bounded set of common
// morphological variants (singular/plural). Empty tags on IG just return
// nothing, so extra variants are cheap.
export function expandHashtagVariants(raw: string): string[] {
  // normalize: drop leading #, spaces, underscores, hyphens; lowercase
  const base = raw.replace(/^#+/, "").replace(/[\s_-]+/g, "").toLowerCase();
  if (!base) return [];
  const out = new Set<string>([base]);
  // plural/singular toggles
  if (base.endsWith("ies")) {
    out.add(base.slice(0, -3) + "y"); // gummies -> gummy
  } else if (base.endsWith("s")) {
    out.add(base.slice(0, -1)); // pastilles -> pastille
  } else {
    out.add(base + "s"); // pastille -> pastilles
    if (base.endsWith("y")) out.add(base.slice(0, -1) + "ies"); // gummy -> gummies
  }
  return [...out];
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
    case "apify/instagram-scraper": {
      // apify/instagram-scraper v3+ expects directUrls for hashtag exploration.
      // Expand each hashtag into its common variants so we don't miss
      // #functionalgummy just because the generator produced #functionalgummies.
      // Cap the number of tag variants — each is a separately-billed scrape.
      const expanded = [...new Set(tags.flatMap((h) => expandHashtagVariants(h)))]
        .slice(0, IG_MAX_VARIANT_TAGS);
      return {
        directUrls: expanded.map(
          (h) => `https://www.instagram.com/explore/tags/${encodeURIComponent(h)}/`
        ),
        resultsType: runMode === "backfill:ig_reels" ? "reels" : "posts",
        resultsLimit: IG_RESULT_CAP,
        addParentData: false,
      };
    }

    case "clockworks/tiktok-scraper":
      return {
        hashtags: tags,
        keywords: kws,
        maxItems: RESULT_CAP,
        ...(geo ? { countryCode: geo } : {}),
      };

    case "scrapeforge/tiktok-posts": {
      // Takes a single keyword + single hashtag (not arrays). Use the primary
      // of each. datePosted is a preset window, not exact dates — TikTok can't
      // do precise date boundaries, so "last-6-months" is the closest match.
      const primaryKw = (kws.find((k) => k.trim().length > 0) ?? input.topicLabel).trim();
      const primaryTag = tags.find((t) => t.trim().length > 0) ?? "";
      return {
        // Must set scrapeMode explicitly — it defaults to "profiles", which
        // searches for a USER named e.g. "gummies" and returns nothing.
        scrapeMode: "keyword",
        keyword: primaryKw,
        hashtag: primaryTag,
        datePosted: "last-6-months",
        maxResults: RESULT_CAP,
        sortBy: "relevance",
        ...(geo ? { region: geo } : {}),
      };
    }

    case "streamers/youtube-scraper": {
      // YouTube has deep, date-queryable history (videos back years), which is
      // the point of adding it: it can supply the historical depth the
      // significance test needs, unlike recent-only IG/Reddit. Free-text search
      // over the keyword variants; oldestPostDate sets the earliest video date.
      const { afterDate } = backfillWindow(today);
      return {
        searchQueries: kws,
        oldestPostDate: afterDate,
        sortingOrder: "date",
        // Per SEARCH QUERY, not per run — see YOUTUBE_RESULT_CAP above. This
        // run fetches (kws.length x YOUTUBE_RESULT_CAP) records.
        maxResults: YOUTUBE_RESULT_CAP,
      };
    }

    case "xquik/x-tweet-scraper": {
      // X is free-text search (not hashtag-bound), so we pass all keyword
      // variants as searchTerms — no hashtag-variant preprocessing needed here.
      // X wants dates as YYYY-MM-DD_HH:MM:SS_UTC.
      const { afterDate, beforeDate } = backfillWindow(today);
      const xDate = (d: string) => `${d}_00:00:00_UTC`;
      return {
        searchTerms: kws,
        since: xDate(afterDate),
        until: xDate(beforeDate),
        maxItems: RESULT_CAP,
        ...(input.language ? { lang: input.language } : {}),
      };
    }

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
        maxPosts: RESULT_CAP,
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
        maxItems: RESULT_CAP,
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
