import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sourceBreadth,
  type GateConfig,
  type SourceObservation,
} from "./confirmation-gate.js";

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
