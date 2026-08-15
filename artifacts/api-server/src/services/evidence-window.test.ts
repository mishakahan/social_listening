import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evidenceCutoff,
  EVIDENCE_WINDOW_DAYS,
  recentEvidenceCount,
} from "./evidence-window.js";

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

// Regression coverage for the fix-round-1 finding: evidenceRecentCount must
// never be derived by counting a capped evidence-row array (the detail
// query is LIMIT 20). It must come from the knowledge item's evidenceCount,
// the same column the Trends list "Evidence (30d)" cell already renders.
test("recent count reflects the true (uncapped) volume, not a LIMIT-20 row count", () => {
  // What a LIMIT 20 evidence query returns for a high-volume entity —
  // cafe-style, ~120 mentions in 30 days, but the array is capped at 20.
  const cappedEvidenceRowCount = 20;
  const trueEvidenceCount = 120; // ki.evidenceCount, set from metrics.volume30d
  const result = recentEvidenceCount(trueEvidenceCount);
  assert.equal(result, 120);
  assert.notEqual(
    result,
    cappedEvidenceRowCount,
    "must not silently fall back to the capped row count"
  );
});

test("a lower-volume entity (creatine-style, ~28) is also unaffected by the cap", () => {
  assert.equal(recentEvidenceCount(28), 28);
});

test("falls back to 0 when the knowledge item has no evidenceCount recorded", () => {
  assert.equal(recentEvidenceCount(null), 0);
  assert.equal(recentEvidenceCount(undefined), 0);
});
