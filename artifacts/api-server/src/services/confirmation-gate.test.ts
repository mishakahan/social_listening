import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sourceBreadth,
  significanceTest,
  confirmationVerdict,
  gateConfigFromPipeline,
  type GateConfig,
  type SourceObservation,
} from "./confirmation-gate.js";

// deterministic RNG (mulberry32) so significance tests are stable
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cfg: GateConfig = {
  significanceAlpha: 0.05,
  permutations: 1000,
  minSourceEntropyBits: 1.0,
  minUniqueAuthors: 3,
  enabled: true,
  // Current shipped behaviour: significance is required. Set explicitly so
  // this baseline never drifts if the default changes.
  requireSignificance: true,
};

test("single dominant source -> low entropy -> hold", () => {
  const obs: SourceObservation[] = [
    { platform: "tiktok", uniqueAuthors: 1, mentions: 10 },
    { platform: "youtube", uniqueAuthors: 0, mentions: 0 },
  ];
  const r = sourceBreadth(obs, cfg);
  assert.ok(r.entropyBits < 0.5, `expected low entropy, got ${r.entropyBits}`);
  assert.equal(r.pass, false);
});

test("broad spread across authors/platforms -> high entropy -> pass", () => {
  const obs: SourceObservation[] = [
    { platform: "tiktok", uniqueAuthors: 8, mentions: 30 },
    { platform: "youtube", uniqueAuthors: 7, mentions: 25 },
    { platform: "googletrends", uniqueAuthors: 5, mentions: 12 },
  ];
  const r = sourceBreadth(obs, cfg);
  assert.ok(r.entropyBits >= 1.0, `expected high entropy, got ${r.entropyBits}`);
  assert.equal(r.pass, true);
});

test("empty observations -> hold, no crash", () => {
  const r = sourceBreadth([], cfg);
  assert.equal(r.pass, false);
  assert.equal(r.totalAuthors, 0);
});

test("flat noisy series -> not significant -> hold", () => {
  const flat = Array.from({ length: 60 }, (_, i) => 5 + (i % 2));
  const r = significanceTest(flat, cfg, seeded(1));
  assert.ok(r.pValue > 0.05, `expected high p, got ${r.pValue}`);
  assert.equal(r.pass, false);
});

test("clear recent spike -> significant -> pass", () => {
  const series = Array.from({ length: 60 }, () => 2);
  for (let i = 53; i < 60; i++) series[i] = 40; // sharp recent surge
  const r = significanceTest(series, cfg, seeded(1));
  assert.ok(r.pValue <= 0.05, `expected low p, got ${r.pValue}`);
  assert.equal(r.pass, true);
});

test("too little history -> hold, no crash", () => {
  const r = significanceTest([1, 2, 3], cfg, seeded(1));
  assert.equal(r.pass, false);
});

test("passes only when BOTH significance and breadth pass", () => {
  const spike = Array.from({ length: 60 }, () => 2);
  for (let i = 53; i < 60; i++) spike[i] = 40;
  // 3 sources so entropy comfortably clears 1.0 bits — 2 sources cap at 1.0
  // bit even on a perfect split, which the 1.0 threshold would reject.
  const broad: SourceObservation[] = [
    { platform: "tiktok", uniqueAuthors: 8, mentions: 30 },
    { platform: "youtube", uniqueAuthors: 7, mentions: 25 },
    { platform: "googletrends", uniqueAuthors: 5, mentions: 12 },
  ];
  const v = confirmationVerdict(
    { dailyMentions: spike, sources: broad },
    cfg,
    seeded(1)
  );
  assert.equal(v.decision, "pass");
});

test("significant but single-source -> hold", () => {
  const spike = Array.from({ length: 60 }, () => 2);
  for (let i = 53; i < 60; i++) spike[i] = 40;
  const narrow: SourceObservation[] = [
    { platform: "tiktok", uniqueAuthors: 1, mentions: 40 },
  ];
  const v = confirmationVerdict(
    { dailyMentions: spike, sources: narrow },
    cfg,
    seeded(1)
  );
  assert.equal(v.decision, "hold");
});

test("disabled gate always passes", () => {
  const v = confirmationVerdict(
    { dailyMentions: [1, 1, 1], sources: [] },
    { ...cfg, enabled: false },
    seeded(1)
  );
  assert.equal(v.decision, "pass");
  assert.ok(v.reasons.includes("gate disabled"));
});

// ---------------------------------------------------------------------------
// requireSignificance — the breadth-only configuration.
//
// Measured 2026-08-08 (holdout-validate.ts / gate-variants.ts): across three
// cutoffs the significance test's passed and held cohorts grew identically
// (1.00x, p=0.73 on 760 entities), while requiring it halved coverage. This
// flag makes that a config decision instead of a code change — but it must
// default to the CURRENT behaviour, because the significance test is a
// contracted deliverable and must never switch off by accident.
// ---------------------------------------------------------------------------

// An entity with real, broad author spread but a flat (non-significant) series
// — exactly the population the holdout showed is being wrongly held.
const broadButFlat = {
  dailyMentions: Array.from({ length: 60 }, () => 1),
  sources: [
    { platform: "tiktok", uniqueAuthors: 6, mentions: 20 },
    { platform: "youtube", uniqueAuthors: 6, mentions: 20 },
    { platform: "reddit", uniqueAuthors: 6, mentions: 20 },
    { platform: "x", uniqueAuthors: 6, mentions: 20 },
  ],
};

test("by default the significance test is still required (shipped behaviour unchanged)", () => {
  const v = confirmationVerdict(broadButFlat, cfg, seeded(1));
  assert.equal(v.significance.pass, false, "fixture must be non-significant to be a valid test");
  assert.equal(v.breadth.pass, true, "fixture must pass breadth to isolate the significance effect");
  assert.equal(v.decision, "hold");
});

test("requireSignificance=false surfaces a broad entity whose series is flat", () => {
  const v = confirmationVerdict(broadButFlat, { ...cfg, requireSignificance: false }, seeded(1));
  assert.equal(v.decision, "pass");
  // The significance result must still be computed and reported, so the
  // verdict stays auditable and the decision can be re-run both ways.
  assert.equal(v.significance.pass, false);
  assert.ok(
    v.reasons.some((r) => r.includes("not required")),
    `verdict must say significance was not required, got: ${JSON.stringify(v.reasons)}`
  );
});

test("breadth still holds a concentrated entity even when significance is not required", () => {
  const concentrated = {
    dailyMentions: broadButFlat.dailyMentions,
    sources: [{ platform: "tiktok", uniqueAuthors: 24, mentions: 80 }],
  };
  const v = confirmationVerdict(concentrated, { ...cfg, requireSignificance: false }, seeded(1));
  assert.equal(v.decision, "hold", "breadth-only must not become a rubber stamp");
  assert.equal(v.breadth.pass, false);
});

test("gateConfigFromPipeline keeps significance required unless explicitly disabled", () => {
  const prev = process.env.GATE_REQUIRE_SIGNIFICANCE;
  try {
    // Unset, empty, and a typo must all leave the gate at full strength — only
    // an exact "false" may weaken it.
    for (const val of [undefined, "", "true", "FALSE", "0", "no"]) {
      if (val === undefined) delete process.env.GATE_REQUIRE_SIGNIFICANCE;
      else process.env.GATE_REQUIRE_SIGNIFICANCE = val;
      const c = gateConfigFromPipeline({} as any);
      assert.equal(
        c.requireSignificance,
        true,
        `GATE_REQUIRE_SIGNIFICANCE=${JSON.stringify(val)} must NOT disable the significance test`
      );
    }
    process.env.GATE_REQUIRE_SIGNIFICANCE = "false";
    assert.equal(gateConfigFromPipeline({} as any).requireSignificance, false);
  } finally {
    if (prev === undefined) delete process.env.GATE_REQUIRE_SIGNIFICANCE;
    else process.env.GATE_REQUIRE_SIGNIFICANCE = prev;
  }
});
