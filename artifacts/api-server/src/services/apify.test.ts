import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActorInput, expandHashtagVariants } from "./apify.js";
import { normalizeX } from "./ingestion.js";

const baseQuery = {
  keywords: ["functional gummies", "functional gummy", "gummy supplements"],
  hashtags: ["functionalgummies", "gummysupplements"],
  language: "en",
  geography: "US",
  topicLabel: "Functional gummies US",
};

test("expandHashtagVariants covers singular/plural + normalizes input", () => {
  const v = expandHashtagVariants("functionalgummies");
  // always includes the original
  assert.ok(v.includes("functionalgummies"));
  // singular form (drop trailing 'ies' -> 'y', and drop trailing 's')
  assert.ok(v.includes("functionalgummy"), `missing singular: ${v.join(",")}`);
  // no duplicates
  assert.equal(new Set(v).size, v.length);
});

test("expandHashtagVariants adds plural for a singular tag", () => {
  const v = expandHashtagVariants("pastille");
  assert.ok(v.includes("pastille"));
  assert.ok(v.includes("pastilles"), `missing plural: ${v.join(",")}`);
});

test("expandHashtagVariants strips spaces/underscores/hashes and stays bounded", () => {
  const v = expandHashtagVariants("#functional_gummies");
  assert.ok(v.every((x) => !x.includes(" ") && !x.includes("_") && !x.startsWith("#")));
  assert.ok(v.length <= 6, `too many variants: ${v.length}`);
});

test("IG mapping expands hashtags into variant explore/tags urls", () => {
  const input = buildActorInput(
    "apify/instagram-scraper",
    "backfill:ig_posts",
    { ...baseQuery, hashtags: ["functionalgummies"] }
  );
  const urls = input.directUrls as string[];
  // covers both the plural original and the singular variant
  assert.ok(urls.some((u) => u.includes("functionalgummies")));
  assert.ok(urls.some((u) => u.includes("functionalgummy")));
});

test("normalizeX maps xquik tweet output to a NormalizedSignal", () => {
  const tweet = {
    id: "1800000000000000000",
    text: "loving these functional gummies lately #wellness",
    createdAt: "Wed Mar 05 12:00:00 +0000 2026",
    url: "https://x.com/someone/status/1800000000000000000",
    likeCount: 42,
    retweetCount: 5,
    replyCount: 3,
    viewCount: 900,
    author: { username: "someone", followers: 1500, verified: true },
    lang: "en",
  };
  const sig = normalizeX(tweet);
  assert.ok(sig, "should not be null");
  assert.equal(sig!.platform, "x");
  assert.equal(sig!.sourceId, "1800000000000000000");
  assert.equal(sig!.authorHandle, "someone");
  assert.equal(sig!.authorFollowers, 1500);
  assert.equal(sig!.authorVerified, true);
  assert.equal(sig!.engagementLikes, 42);
  assert.equal(sig!.engagementShares, 5); // retweets map to shares
  assert.equal(sig!.engagementComments, 3);
  assert.equal(sig!.engagementViews, 900);
  assert.ok(sig!.postedAt instanceof Date);
});

test("normalizeX returns null when there is no id", () => {
  assert.equal(normalizeX({ text: "no id here" }), null);
});

test("x tweet scraper uses free-text searchTerms + since/until 6mo window + lang", () => {
  const today = new Date("2026-07-05T00:00:00Z");
  const input = buildActorInput(
    "xquik/x-tweet-scraper",
    "backfill:x_search",
    baseQuery,
    today
  );
  // free-text: all keyword variants passed (no hashtag-variant problem on X)
  assert.deepEqual(input.searchTerms, baseQuery.keywords);
  // X date format is YYYY-MM-DD_HH:MM:SS_UTC
  assert.equal(input.since, "2026-01-05_00:00:00_UTC");
  assert.equal(input.until, "2026-07-05_00:00:00_UTC");
  assert.equal(input.lang, "en");
  assert.ok(typeof input.maxItems === "number" && input.maxItems > 0);
});

test("tiktok scrapeforge actor uses primary keyword/hashtag + 6mo preset + region", () => {
  const input = buildActorInput(
    "scrapeforge/tiktok-posts",
    "backfill:tiktok",
    baseQuery
  );
  assert.equal(input.keyword, "functional gummies");
  assert.equal(input.hashtag, "functionalgummies");
  assert.equal(input.datePosted, "last-6-months");
  assert.equal(input.region, "US");
  assert.ok(typeof input.maxResults === "number" && input.maxResults > 0);
});

test("reddit archive actor uses searchQuery + 6mo date window + comments off", () => {
  // deterministic 'today' so afterDate is stable
  const today = new Date("2026-07-05T00:00:00Z");
  const input = buildActorInput(
    "benthepythondev/reddit-archive-scraper",
    "backfill:reddit_search",
    baseQuery,
    today
  );
  // primary keyword becomes the single searchQuery
  assert.equal(input.searchQuery, "functional gummies");
  // 6 months before 2026-07-05 => 2026-01-05
  assert.equal(input.afterDate, "2026-01-05");
  assert.equal(input.beforeDate, "2026-07-05");
  // comments off (cost driver) and a sane post cap
  assert.equal(input.includeComments, false);
  assert.ok(typeof input.maxPosts === "number" && input.maxPosts > 0);
});
