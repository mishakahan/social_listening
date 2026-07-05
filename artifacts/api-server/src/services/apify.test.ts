import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActorInput } from "./apify.js";

const baseQuery = {
  keywords: ["functional gummies", "functional gummy", "gummy supplements"],
  hashtags: ["functionalgummies", "gummysupplements"],
  language: "en",
  geography: "US",
  topicLabel: "Functional gummies US",
};

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
