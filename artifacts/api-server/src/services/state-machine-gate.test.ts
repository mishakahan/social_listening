import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGateInput } from "./confirmation-gate.js";
import type { TpEntityTimeseries } from "@workspace/db/schema";

function row(
  date: string,
  platform: string,
  mentions: number,
  authors: number
): TpEntityTimeseries {
  return {
    id: 0,
    companyId: 1,
    entityId: 1,
    platform,
    geography: "Global",
    territoryTag: null,
    bucketDate: date,
    mentions,
    uniqueAuthors: authors,
    engagementSum: 0,
    engagementMedian: 0,
    backfillDerived: false,
    computedAt: new Date(),
  } as TpEntityTimeseries;
}

test("buildGateInput sums same-day across platforms + per-platform sources", () => {
  const rows = [
    row("2026-06-01", "tiktok", 5, 3),
    row("2026-06-02", "tiktok", 7, 4),
    row("2026-06-02", "youtube", 2, 2),
  ];
  const input = buildGateInput(rows);
  // consecutive days, no gap -> [5, 9] (2026-06-02 sums 7+2)
  assert.deepEqual(input.dailyMentions, [5, 9]);
  const tiktok = input.sources.find((s) => s.platform === "tiktok")!;
  assert.equal(tiktok.uniqueAuthors, 7);
});

test("buildGateInput ZERO-FILLS gaps between active days", () => {
  // a mention on the 1st and the 5th -> the 2nd,3rd,4th are real zeros, not
  // collapsed away. Otherwise the significance test can't see 'quiet then rise'.
  const rows = [
    row("2026-06-01", "tiktok", 1, 1),
    row("2026-06-05", "tiktok", 4, 3),
  ];
  const input = buildGateInput(rows);
  assert.deepEqual(input.dailyMentions, [1, 0, 0, 0, 4]);
});

test("buildGateInput bounds the window (ancient history doesn't create a huge zero array)", () => {
  // a mention years ago + recent ones: the series is capped to the recent
  // window, not thousands of zeros back to the old date.
  const rows = [
    row("2019-01-01", "tiktok", 1, 1), // ancient
    row("2026-07-01", "tiktok", 2, 2),
    row("2026-07-05", "tiktok", 3, 2),
  ];
  const input = buildGateInput(rows);
  // window is bounded (<= 400 days), so the array is small, not ~2700 long
  assert.ok(input.dailyMentions.length <= 400, `series too long: ${input.dailyMentions.length}`);
  // recent activity is present at the end
  assert.equal(input.dailyMentions[input.dailyMentions.length - 1], 3);
});
