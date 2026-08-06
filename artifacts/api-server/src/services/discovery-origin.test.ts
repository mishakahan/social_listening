import { test } from "node:test";
import assert from "node:assert/strict";
import { wasSearchedFor, normalizeTerm, resolveSeedMatch, type SeedMatch } from "./discovery-origin.js";

const seeds = new Set(
  ["Maionese", "maionese caseira", "#vitaminas", "empanadas a domicilio", "vitamin gummies"]
    .map(normalizeTerm)
);

test("an exact seed match counts as searched for", () => {
  assert.equal(wasSearchedFor("maionese", seeds), true);
});

test("a word inside a multi-word seed counts as searched for", () => {
  assert.equal(wasSearchedFor("empanadas", seeds), true);
  assert.equal(wasSearchedFor("vitamin", seeds), true);
});

test("genuinely unseeded terms are not matched", () => {
  for (const label of ["creatine", "yuzu", "ceviche", "medjool dates"]) {
    assert.equal(wasSearchedFor(label, seeds), false, `${label} should be discovered`);
  }
});

test("normalisation strips hashes, case and accents", () => {
  assert.equal(normalizeTerm("#Vitaminas"), "vitaminas");
  assert.equal(normalizeTerm("  Jamón "), "jamon");
});

test("accent-insensitive matching works both ways", () => {
  const s = new Set(["jamon serrano"].map(normalizeTerm));
  assert.equal(wasSearchedFor("jamón", s), true);
});

// Regression: company 2's live radar badged "empanada" (singular) as
// DISCOVERED even though the seed vocabulary contains "empanadas a
// domicilio" (plural). Word-level matching was exact-string-only, so
// "empanada" !== "empanadas" fell through to "discovered". Fails without the
// singularizeWord-based plural equivalence in wasSearchedFor.
test("a singular label matches a plural word inside a multi-word seed (empanada bug)", () => {
  const s = new Set(["empanadas a domicilio"].map(normalizeTerm));
  assert.equal(wasSearchedFor("empanada", s), true);
});

// This repo already shipped a bug where a naive trailing-"s" strip turned
// "citrus" into "citru" (and similarly mangled "hibiscus", "focus",
// "molasses"), corrupting 30 live entities. entity-canonical.ts's
// singularizeWord carries an isAlreadySingular guard against exactly this.
// Reusing that function (rather than writing new plural logic here) must not
// reintroduce the bug: "citrus" should match only genuine "citrus" seeds,
// never the mangled "citru" form.
test("does not mangle citrus-class words through the matching path", () => {
  const s = new Set(["citrus soda", "hibiscus tea"].map(normalizeTerm));
  assert.equal(wasSearchedFor("citrus", s), true);
  assert.equal(wasSearchedFor("hibiscus", s), true);
  // if the guard were missing, "citrus" would get stemmed to "citru" and a
  // genuinely different word "citru" would wrongly match it
  assert.equal(wasSearchedFor("citru", s), false);
});

// Multi-word label vs multi-word seed is deliberately NOT matched on a
// shared content word: evaluated and rejected, see discovery-origin.ts —
// it flipped the anchor-required "whey protein" (company 1) to seeded via
// the unrelated seed "protein gummies". Locking in the current (unmatched)
// behavior so a future change can't silently reintroduce that regression.
test("a multi-word label is NOT matched against a multi-word seed on a shared word alone", () => {
  const s = new Set(["protein gummies"].map(normalizeTerm));
  assert.equal(wasSearchedFor("whey protein", s), false);
});

test("resolveSeedMatch returns the watch topic and search term of the matching seed", () => {
  const terms = new Set([normalizeTerm("maionese"), normalizeTerm("empanadas a domicilio")]);
  const m = new Map<string, SeedMatch>([
    [normalizeTerm("maionese"), { watchTopic: "Condiments", searchTerm: "Spicy mayo trends BR" }],
    [normalizeTerm("empanadas a domicilio"), { watchTopic: "Snacks", searchTerm: "Food delivery app usage CO" }],
  ]);
  assert.deepEqual(resolveSeedMatch("maionese", terms, m), {
    watchTopic: "Condiments",
    searchTerm: "Spicy mayo trends BR",
  });
  // word-inside-multi-word-seed matching still applies
  assert.deepEqual(resolveSeedMatch("empanadas", terms, m), {
    watchTopic: "Snacks",
    searchTerm: "Food delivery app usage CO",
  });
});

test("resolveSeedMatch returns nulls for a genuinely discovered term", () => {
  const terms = new Set([normalizeTerm("maionese")]);
  const m = new Map<string, SeedMatch>([
    [normalizeTerm("maionese"), { watchTopic: "Condiments", searchTerm: "Spicy mayo trends BR" }],
  ]);
  assert.deepEqual(resolveSeedMatch("yuzu", terms, m), { watchTopic: null, searchTerm: null });
});

// Defensive path: a term the matcher considers part of the vocabulary (it's
// in `seedTerms`) but with no corresponding entry in `termToSeed`. This
// shouldn't happen when both are built together in one pass (see
// getSeedVocabulary), but the fallback must actually be exercised here, not
// just asserted unreachable — a prior version of this test passed an empty
// Map paired with an empty Set, so matchSeedTerm returned null before ever
// reaching the `termToSeed.get(...) ?? NO_MATCH` fallback line.
test("resolveSeedMatch falls back to nulls when a matched term has no map entry", () => {
  const terms = new Set([normalizeTerm("anything")]);
  const m = new Map<string, SeedMatch>(); // deliberately missing the entry
  assert.deepEqual(resolveSeedMatch("anything", terms, m), { watchTopic: null, searchTerm: null });
});
