import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceCutoff, EVIDENCE_WINDOW_DAYS } from "./evidence-window.js";

test("cutoff is windowDays before now", () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  assert.equal(
    evidenceCutoff(now, 30).toISOString(),
    "2026-07-06T00:00:00.000Z"
  );
});

test("a zero window returns now unchanged", () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  assert.equal(evidenceCutoff(now, 0).toISOString(), now.toISOString());
});

test("the exported default matches the Evidence column (volume30d)", () => {
  assert.equal(EVIDENCE_WINDOW_DAYS, 30);
});
