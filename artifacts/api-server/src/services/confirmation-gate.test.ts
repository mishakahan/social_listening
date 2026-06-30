import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sourceBreadth,
  significanceTest,
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
