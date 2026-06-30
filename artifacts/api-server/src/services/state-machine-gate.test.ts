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

test("buildGateInput produces chronological series + per-platform sources", () => {
  const rows = [
    row("2026-06-01", "tiktok", 5, 3),
    row("2026-06-02", "tiktok", 7, 4),
    row("2026-06-02", "youtube", 2, 2),
  ];
  const input = buildGateInput(rows);
  assert.deepEqual(input.dailyMentions, [5, 9]); // 2026-06-02 sums 7+2
  const tiktok = input.sources.find((s) => s.platform === "tiktok")!;
  assert.equal(tiktok.uniqueAuthors, 7);
});
