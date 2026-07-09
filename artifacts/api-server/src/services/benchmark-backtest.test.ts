import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchTrendToEntity,
  evaluateTrend,
  runBacktest,
  type EntityVerdict,
} from "./benchmark-backtest.js";

const entities: EntityVerdict[] = [
  { label: "Athletic Brewing", hadData: true, decision: "pass", significanceP: 0.01, entropyBits: 1.4 },
  { label: "high noon", hadData: true, decision: "hold", significanceP: 0.6, entropyBits: 0.9 },
  { label: "Kombuchas", hadData: false, decision: null },
];

test("matches benchmark name to entity via canonicalization + containment", () => {
  assert.equal(matchTrendToEntity("Athletic Brewing", entities)?.label, "Athletic Brewing");
  // case-insensitive
  assert.equal(matchTrendToEntity("High Noon", entities)?.label, "high noon");
  // no match
  assert.equal(matchTrendToEntity("Nonexistent Brand", entities), null);
});

test("single generic words match EXACTLY only (no loose containment)", () => {
  const ents: EntityVerdict[] = [
    { label: "Non-Homogenized Milk", hadData: true, decision: "pass" },
    { label: "Milk", hadData: true, decision: "hold" },
  ];
  // "Milk" should match the "Milk" entity, NOT "non-homogenized milk"
  assert.equal(matchTrendToEntity("Milk", ents)?.label, "Milk");
  // if only the compound entity exists, a single generic word does NOT match it
  const onlyCompound: EntityVerdict[] = [
    { label: "Non-Homogenized Milk", hadData: true, decision: "pass" },
  ];
  assert.equal(matchTrendToEntity("Milk", onlyCompound), null);
});

test("multi-word trend names still match via containment (brand variants)", () => {
  const ents: EntityVerdict[] = [
    { label: "athletic brewing co", hadData: true, decision: "hold" },
  ];
  assert.equal(matchTrendToEntity("Athletic Brewing", ents)?.label, "athletic brewing co");
});

test("evaluateTrend: confirmed when a known trend passed the gate", () => {
  const r = evaluateTrend({ name: "Athletic Brewing" }, entities);
  assert.equal(r.outcome, "confirmed");
  assert.equal(r.decision, "pass");
});

test("evaluateTrend: held-flat when a known trend had data but was held", () => {
  const r = evaluateTrend({ name: "High Noon" }, entities);
  assert.equal(r.outcome, "held-flat");
  assert.equal(r.decision, "hold");
});

test("evaluateTrend: held-no-signal when found but no data to evaluate", () => {
  const r = evaluateTrend({ name: "Kombucha" }, entities);
  assert.equal(r.outcome, "held-no-signal");
});

test("evaluateTrend: not-found when the trend never surfaced", () => {
  const r = evaluateTrend({ name: "Mystery Brand" }, entities);
  assert.equal(r.outcome, "not-found");
  assert.equal(r.decision, null);
});

test("runBacktest tallies outcomes", () => {
  const s = runBacktest(
    [{ name: "Athletic Brewing" }, { name: "High Noon" }, { name: "Kombucha" }, { name: "Mystery Brand" }],
    entities
  );
  assert.equal(s.total, 4);
  assert.equal(s.confirmed, 1);
  assert.equal(s.heldFlat, 1);
  assert.equal(s.heldNoSignal, 1);
  assert.equal(s.notFound, 1);
});
