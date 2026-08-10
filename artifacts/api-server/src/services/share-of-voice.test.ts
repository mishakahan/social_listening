import { test } from "node:test";
import assert from "node:assert/strict";
import { combinePlatformGrowths } from "./share-of-voice.js";

// Cases anchored to figures measured on the 2026-08-09 sweep, not invented.

test("a platform-mix shift cannot manufacture growth", () => {
  // THE confound this exists for. X went from ~1% of our sample to 81%, so an
  // entity's raw X mentions explode. But its share WITHIN X is unchanged, so
  // it must read as flat.
  const r = combinePlatformGrowths([
    { platform: "x", recentN: 810, recentTotal: 81000, priorN: 10, priorTotal: 1000 },
    { platform: "tiktok", recentN: 150, recentTotal: 15000, priorN: 980, priorTotal: 98000 },
  ]);
  assert.equal(r.growthPct, 0, "identical within-platform share must be zero growth");
});

test("scrape volume cancels within a platform", () => {
  const r = combinePlatformGrowths([
    { platform: "tiktok", recentN: 1000, recentTotal: 10000, priorN: 100, priorTotal: 1000 },
    { platform: "x", recentN: 500, recentTotal: 5000, priorN: 50, priorTotal: 500 },
  ]);
  assert.equal(r.growthPct, 0);
});

test("growth on one platform only is NOT reported — it needs corroboration", () => {
  // A single-platform spike is the shape of a sampling artifact. Requiring two
  // platforms is what makes this a trend claim rather than a scraper claim.
  const r = combinePlatformGrowths([
    { platform: "tiktok", recentN: 200, recentTotal: 10000, priorN: 10, priorTotal: 10000 },
    { platform: "x", recentN: 5, recentTotal: 10000, priorN: 1, priorTotal: 10000 },
  ]);
  assert.equal(r.growthPct, null, "x has only 1 prior mention, below the floor");
  assert.equal(r.platformsUsed, 1);
});

test("real corroborated growth survives", () => {
  const r = combinePlatformGrowths([
    { platform: "tiktok", recentN: 60, recentTotal: 10000, priorN: 10, priorTotal: 10000 },
    { platform: "x", recentN: 40, recentTotal: 10000, priorN: 8, priorTotal: 10000 },
  ]);
  assert.ok(r.growthPct! > 100, `expected strong growth, got ${r.growthPct}`);
  assert.equal(r.platformsUsed, 2);
});

test("thin prior counts are excluded, killing the 1->3 mention ranking", () => {
  // The 30-day version produced a run of identical 237.7% / 162.7% values
  // driven entirely by 1->2 and 1->3 jumps.
  const r = combinePlatformGrowths([
    { platform: "tiktok", recentN: 3, recentTotal: 10000, priorN: 1, priorTotal: 10000 },
    { platform: "x", recentN: 2, recentTotal: 10000, priorN: 1, priorTotal: 10000 },
  ]);
  assert.equal(r.growthPct, null);
});

test("the median is used, so one odd platform cannot carry the verdict", () => {
  const r = combinePlatformGrowths([
    { platform: "a", recentN: 10, recentTotal: 1000, priorN: 10, priorTotal: 1000 },   //   0%
    { platform: "b", recentN: 11, recentTotal: 1000, priorN: 10, priorTotal: 1000 },   // +10%
    { platform: "c", recentN: 900, recentTotal: 1000, priorN: 10, priorTotal: 1000 },  // +8900%
  ]);
  // Tolerance, not equality: 11/1000 / (10/1000) - 1 is 10.000000000000009.
  assert.ok(
    Math.abs(r.growthPct! - 10) < 1e-6,
    `median must resist the outlier (expected ~10%, got ${r.growthPct})`
  );
  assert.ok(r.growthPct! < 100, "the +8900% outlier must not carry the verdict");
});

test("a decline is reported as a decline", () => {
  const r = combinePlatformGrowths([
    { platform: "tiktok", recentN: 5, recentTotal: 10000, priorN: 20, priorTotal: 10000 },
    { platform: "x", recentN: 4, recentTotal: 10000, priorN: 16, priorTotal: 10000 },
  ]);
  assert.ok(r.growthPct! < -50, `expected a clear decline, got ${r.growthPct}`);
});

test("per-platform detail is exposed so a verdict can be audited", () => {
  const r = combinePlatformGrowths([
    { platform: "tiktok", recentN: 20, recentTotal: 10000, priorN: 10, priorTotal: 10000 },
    { platform: "x", recentN: 30, recentTotal: 10000, priorN: 10, priorTotal: 10000 },
  ]);
  assert.equal(r.byPlatform.length, 2);
  assert.ok(r.byPlatform.every((p) => typeof p.growthPct === "number" && p.priorMentions >= 3));
});
