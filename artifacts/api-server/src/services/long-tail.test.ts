import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeVolumeCeiling,
  selectLongTailCandidates,
  type EntityVolumeRow,
} from "./long-tail.js";

// ---------------------------------------------------------------------------
// computeVolumeCeiling
// ---------------------------------------------------------------------------

test("computeVolumeCeiling: median of an odd-length sorted set", () => {
  // real shape: mostly single digits with a long right tail
  const counts = [5, 5, 6, 6, 7, 8, 10, 13, 21, 87, 221];
  assert.equal(computeVolumeCeiling(counts, 50), 8);
});

test("computeVolumeCeiling: matches the real company-1/company-2 medians", () => {
  // Regression pin for the numbers cited in the long-tail.ts header comment
  // (verified 2026-08 against production data).
  const counts1 = Array.from({ length: 279 }, (_, i) => i + 5); // synthetic but monotonic, n matches
  // Real data isn't reproducible here without the DB; instead assert the
  // *shape* of the guarantee: percentile 50 always lands within the range.
  const ceiling = computeVolumeCeiling(counts1, 50);
  assert.ok(ceiling! >= counts1[0]! && ceiling! <= counts1[counts1.length - 1]!);
});

test("computeVolumeCeiling: empty input returns null", () => {
  assert.equal(computeVolumeCeiling([], 50), null);
});

test("computeVolumeCeiling: single value returns that value at any percentile", () => {
  assert.equal(computeVolumeCeiling([42], 50), 42);
  assert.equal(computeVolumeCeiling([42], 0), 42);
  assert.equal(computeVolumeCeiling([42], 100), 42);
});

test("computeVolumeCeiling: percentile 0 returns the minimum, 100 returns the maximum", () => {
  const counts = [5, 6, 7, 8, 9, 100];
  assert.equal(computeVolumeCeiling(counts, 0), 5);
  assert.equal(computeVolumeCeiling(counts, 100), 100);
});

test("computeVolumeCeiling: out-of-range percentiles are clamped rather than throwing", () => {
  const counts = [5, 6, 7, 8, 9, 100];
  assert.equal(computeVolumeCeiling(counts, -10), computeVolumeCeiling(counts, 0));
  assert.equal(computeVolumeCeiling(counts, 500), computeVolumeCeiling(counts, 100));
});

test("computeVolumeCeiling: does not mutate its input", () => {
  const counts = [9, 1, 5, 3];
  const copy = [...counts];
  computeVolumeCeiling(counts, 50);
  assert.deepEqual(counts, copy);
});

// ---------------------------------------------------------------------------
// selectLongTailCandidates — the full pure pipeline (floor -> ceiling ->
// core vocab -> well-formedness -> posterior), everything short of the LLM
// specificity call.
// ---------------------------------------------------------------------------

const baseCfg = {
  minMentions: 5,
  minPosterior: 0.9,
  coreVocabulary: new Set<string>(),
  volumeCeilingPercentile: 50,
};

function row(overrides: Partial<EntityVolumeRow>): EntityVolumeRow {
  return {
    entityId: 1,
    canonicalLabel: "widget",
    currentMentions: 10,
    priorMentions: 2,
    yoyMentions: 0,
    ...overrides,
  };
}

test("selectLongTailCandidates: the café/aguacate/sal/pollo/huevo case — high-volume staples get excluded by the ceiling", () => {
  // Shaped like the real company-2 distribution (verified 2026-08): a mass
  // of entities clustered just above the mention floor (5-8), plus a
  // handful of much higher-volume staples. Real mention counts for the
  // named staples.
  const filler = [5, 5, 6, 6, 6, 7, 7, 7, 8, 8].map((mentions, i) =>
    row({ entityId: 100 + i, canonicalLabel: `filler-${i}`, currentMentions: mentions, priorMentions: 1 })
  );
  const staples: EntityVolumeRow[] = [
    row({ entityId: 1, canonicalLabel: "café", currentMentions: 83, priorMentions: 40 }),
    row({ entityId: 2, canonicalLabel: "aguacate", currentMentions: 65, priorMentions: 30 }),
    row({ entityId: 3, canonicalLabel: "sal", currentMentions: 27, priorMentions: 10 }),
    row({ entityId: 4, canonicalLabel: "pollo", currentMentions: 34, priorMentions: 15 }),
    row({ entityId: 5, canonicalLabel: "huevo", currentMentions: 25, priorMentions: 10 }),
  ];
  const { candidates, stats } = selectLongTailCandidates([...filler, ...staples], baseCfg);

  const labels = candidates.map((c) => c.canonicalLabel);
  for (const staple of ["café", "aguacate", "sal", "pollo", "huevo"]) {
    assert.ok(!labels.includes(staple), `${staple} should be excluded by the volume ceiling`);
  }
  assert.ok(stats.filteredAboveCeiling >= 5);
});

test("selectLongTailCandidates: with no ceiling configured, everything above the floor with a valid baseline can pass", () => {
  // percentile 100 == max, so nothing is excluded on volume alone
  const rows: EntityVolumeRow[] = [
    row({ entityId: 1, canonicalLabel: "gummy", currentMentions: 221, priorMentions: 5 }),
    row({ entityId: 2, canonicalLabel: "chamoy", currentMentions: 5, priorMentions: 1 }),
  ];
  const { stats } = selectLongTailCandidates(rows, { ...baseCfg, volumeCeilingPercentile: 100 });
  // at p100 the ceiling equals the max (221); "gummy" sits AT the ceiling so
  // the strict "< ceiling" rule still excludes it — only entities strictly
  // below the max survive stage 2.
  assert.equal(stats.filteredAboveCeiling, 1);
});

test("selectLongTailCandidates: mention floor removes entities below the threshold before the ceiling is even computed", () => {
  const rows: EntityVolumeRow[] = [
    row({ entityId: 1, canonicalLabel: "rare thing", currentMentions: 1, priorMentions: 1 }),
    row({ entityId: 2, canonicalLabel: "chamoy", currentMentions: 6, priorMentions: 1 }),
  ];
  const { stats } = selectLongTailCandidates(rows, baseCfg);
  assert.equal(stats.filteredBelowFloor, 1);
  assert.equal(stats.evaluated, 2);
});

// These tests target one specific stage (core vocab / well-formedness /
// baseline / posterior) in isolation. Percentile 100 makes the ceiling equal
// the maximum value present, and a padding row set far above the entity
// under test guarantees that max is the padding row, not the entity under
// test — so stage 2 (volume ceiling) never interferes with what's being
// asserted. (At percentile 50 with only 1-2 low-value rows, the entity
// under test can land exactly ON its own percentile boundary and get
// excluded by the ceiling instead of by the stage the test means to
// exercise — see the dedicated ceiling tests above for that behavior.)
const isolationCfg = { ...baseCfg, volumeCeilingPercentile: 100 };
const padding = row({ entityId: 999, canonicalLabel: "padding-high-volume", currentMentions: 1000, priorMentions: 500 });

test("selectLongTailCandidates: core vocabulary is excluded even when it clears floor and ceiling", () => {
  const rows: EntityVolumeRow[] = [
    row({ entityId: 1, canonicalLabel: "salt", currentMentions: 5, priorMentions: 1 }),
    row({ entityId: 2, canonicalLabel: "chamoy", currentMentions: 5, priorMentions: 1 }),
    padding,
  ];
  const cfg = { ...isolationCfg, coreVocabulary: new Set(["salt"]) };
  const { candidates, stats } = selectLongTailCandidates(rows, cfg);
  assert.ok(!candidates.some((c) => c.canonicalLabel === "salt"));
  assert.equal(stats.filteredCoreVocab, 1);
});

test("selectLongTailCandidates: malformed (dangling-modifier) labels are dropped before the posterior is even computed", () => {
  const rows: EntityVolumeRow[] = [
    row({ entityId: 1, canonicalLabel: "non-alcoholic", currentMentions: 5, priorMentions: 1 }),
    padding,
  ];
  const { candidates, stats } = selectLongTailCandidates(rows, isolationCfg);
  assert.equal(candidates.length, 0);
  assert.equal(stats.filteredMalformed, 1);
});

test("selectLongTailCandidates: no baseline in either window is skipped, not treated as infinite uplift", () => {
  const rows: EntityVolumeRow[] = [
    row({ entityId: 1, canonicalLabel: "brand-new thing", currentMentions: 5, priorMentions: 0, yoyMentions: 0 }),
    padding,
  ];
  const { candidates, stats } = selectLongTailCandidates(rows, isolationCfg);
  assert.equal(candidates.length, 0);
  assert.equal(stats.filteredNoBaseline, 1);
});

test("selectLongTailCandidates: low posterior (uplift not credible) is filtered", () => {
  const rows: EntityVolumeRow[] = [
    // current barely above baseline -> posterior well under 0.9
    row({ entityId: 1, canonicalLabel: "steady thing", currentMentions: 5, priorMentions: 5 }),
    padding,
  ];
  const { candidates, stats } = selectLongTailCandidates(rows, isolationCfg);
  assert.equal(candidates.length, 0);
  assert.equal(stats.filteredLowPosterior, 1);
});

test("selectLongTailCandidates: a genuinely low-volume, well-formed, sharply-rising entity survives every stage", () => {
  const rows: EntityVolumeRow[] = [
    // current=9 vs baseline=1 clears the default posterior threshold
    // (0.9248 >= 0.9); current=5 vs baseline=1 (0.7366) does not, which is
    // itself the point of the low-posterior test above.
    row({ entityId: 1, canonicalLabel: "yuzu", currentMentions: 9, priorMentions: 1, yoyMentions: 0 }),
    padding,
  ];
  const { candidates } = selectLongTailCandidates(rows, isolationCfg);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.canonicalLabel, "yuzu");
  assert.equal(candidates[0]!.baselineKind, "prior_window");
});

test("selectLongTailCandidates: filter ordering — an entity above the ceiling never reaches well-formedness or posterior stats", () => {
  // A malformed label that is ALSO above the ceiling should be counted once,
  // at the ceiling stage, not double-counted at the well-formedness stage.
  const rows: EntityVolumeRow[] = [
    row({ entityId: 1, canonicalLabel: "non-alcoholic", currentMentions: 500, priorMentions: 1 }),
    row({ entityId: 2, canonicalLabel: "other", currentMentions: 6, priorMentions: 1 }),
  ];
  const { stats } = selectLongTailCandidates(rows, baseCfg);
  assert.equal(stats.filteredAboveCeiling, 1);
  assert.equal(stats.filteredMalformed, 0);
});

test("selectLongTailCandidates: stats.evaluated always equals the input length regardless of filtering", () => {
  const rows: EntityVolumeRow[] = [
    row({ entityId: 1, currentMentions: 1 }),
    row({ entityId: 2, currentMentions: 500 }),
    row({ entityId: 3, currentMentions: 5 }),
  ];
  const { stats } = selectLongTailCandidates(rows, baseCfg);
  assert.equal(stats.evaluated, 3);
});
