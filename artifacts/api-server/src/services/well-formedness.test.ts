import { test } from "node:test";
import assert from "node:assert/strict";
import { isWellFormed, findCompoundParent, isDanglingModifier } from "./well-formedness.js";

test("keeps real product nouns", () => {
  for (const label of ["yuzu", "creatine", "medjool dates", "non-alcoholic beer", "frango desfiado"]) {
    assert.equal(isWellFormed(label).wellFormed, true, `${label} should be kept`);
  }
});

test("drops dangling modifiers", () => {
  for (const label of ["non-alcoholic", "sugar-free", "gluten-free", "handmade"]) {
    assert.equal(isWellFormed(label).wellFormed, false, `${label} should be dropped`);
  }
});

test("drops occasion and claim words", () => {
  for (const label of ["brunch", "graduation", "birthday", "christmas"]) {
    assert.equal(isWellFormed(label).wellFormed, false, `${label} should be dropped`);
  }
});

test("a compound built on a modifier is still well-formed", () => {
  assert.equal(isWellFormed("sugar-free chocolate").wellFormed, true);
  assert.equal(isWellFormed("brunch sandwich").wellFormed, true);
});

test("gives a human-readable reason when it drops something", () => {
  const r = isWellFormed("non-alcoholic");
  assert.equal(r.wellFormed, false);
  assert.ok(r.reason.length > 0);
});

test("finds the compound the modifier belongs to", () => {
  const labels = ["non-alcoholic beer", "creatine", "yuzu"];
  assert.equal(findCompoundParent("non-alcoholic", labels), "non-alcoholic beer");
});

test("prefers the shortest compound when several extend the modifier", () => {
  const labels = ["sugar-free chocolate bar", "sugar-free chocolate"];
  assert.equal(findCompoundParent("sugar-free", labels), "sugar-free chocolate");
});

test("returns null when nothing extends the modifier", () => {
  assert.equal(findCompoundParent("handmade", ["creatine", "yuzu"]), null);
});

test("does not treat an unrelated prefix match as a parent", () => {
  assert.equal(findCompoundParent("brunch", ["brunchette"]), null);
});

// Real data: shortest-string alone picked "non-alcoholic ipa" (1 mention)
// over "non-alcoholic beer" (64 mentions) because "ipa" is a shorter string
// than "beer". Weights must override string length when supplied.
test("prefers the highest-evidence compound over the shortest string when weights are given", () => {
  const labels = ["non-alcoholic ipa", "non-alcoholic beer"];
  const weights = { "non-alcoholic ipa": 1, "non-alcoholic beer": 64 };
  assert.equal(findCompoundParent("non-alcoholic", labels, weights), "non-alcoholic beer");
});

test("falls back to shortest string when weights are tied or missing", () => {
  const labels = ["sugar-free chocolate bar", "sugar-free chocolate"];
  const weights = { "sugar-free chocolate bar": 5, "sugar-free chocolate": 5 };
  assert.equal(findCompoundParent("sugar-free", labels, weights), "sugar-free chocolate");
});

// isDanglingModifier is the gate the merge script uses before ever calling
// findCompoundParent: only a true standalone modifier is eligible to fold
// into a compound. An occasion word standing next to a plausible-looking
// compound ("brunch cocktails") is NOT the same referent — "brunch" is a
// complete concept by itself, unlike "non-alcoholic" which requires a noun.
test("identifies standalone modifiers but not occasions", () => {
  for (const label of ["non-alcoholic", "sugar-free", "handmade", "organic"]) {
    assert.equal(isDanglingModifier(label), true, `${label} should be a dangling modifier`);
  }
  for (const label of ["brunch", "graduation", "birthday", "creatine"]) {
    assert.equal(isDanglingModifier(label), false, `${label} should not be a dangling modifier`);
  }
});

// Round-1 fix: no-hyphen spelling variants are excluded from merge
// eligibility. "nonalcoholic" (17 mentions) folded into "nonalcoholic beer"
// (5) while "non-alcoholic beer" (64) — almost certainly the same real
// trend, spelled differently — sat right next to it, unconsidered. Without
// real cross-spelling normalisation there is no safe way to pick the right
// parent, so these are simply excluded rather than guessed.
test("excludes no-hyphen spelling variants from merge eligibility", () => {
  for (const label of ["nonalcoholic", "sugarfree", "glutenfree"]) {
    assert.equal(isDanglingModifier(label), false, `${label} is a spelling variant and must not be merge-eligible`);
  }
  // the canonical hyphenated spellings remain eligible
  for (const label of ["non-alcoholic", "sugar-free", "gluten-free"]) {
    assert.equal(isDanglingModifier(label), true, `${label} should still be a dangling modifier`);
  }
});

// THE bug that shipped in round 1: "vegan" (479 mentions on Leone) was
// archived into "vegan chocolate" (28) because 28 beat every OTHER
// candidate, but nothing ever compared it to the modifier's own 479. A
// modifier that carries more evidence than every candidate parent is not a
// split fixable by archiving it — this must return null so the caller skips
// the merge instead of forcing it.
test("refuses to merge when the modifier itself has more evidence than every candidate parent", () => {
  const labels = ["vegan chocolate"];
  const weights = { vegan: 479, "vegan chocolate": 28 };
  assert.equal(findCompoundParent("vegan", labels, weights), null);
});

test("still merges when the parent has at least as much evidence as the modifier", () => {
  const labels = ["non-alcoholic beer"];
  const weights = { "non-alcoholic": 64, "non-alcoholic beer": 64 };
  assert.equal(findCompoundParent("non-alcoholic", labels, weights), "non-alcoholic beer");
});

test("skips a large volume disparity even though a compound technically extends the modifier", () => {
  // dairy-free (13) -> dairy-free kids (1) shipped in round 1: a 13x loss.
  const labels = ["dairy-free kids", "dairy-free butter"];
  const weights = { "dairy-free": 13, "dairy-free kids": 1, "dairy-free butter": 1 };
  assert.equal(findCompoundParent("dairy-free", labels, weights), null);
});

// Round-1 fix: the merge script writes the return value straight into
// canonical_label, and resolveSynonym's alias lookup is case-sensitive, so
// the original casing must survive — not the lowercased comparison form.
test("preserves the parent's original casing rather than the lowercased comparison form", () => {
  const labels = ["Non-Alcoholic Beer"];
  const weights = { "non-alcoholic": 10, "non-alcoholic beer": 20 };
  assert.equal(findCompoundParent("non-alcoholic", labels, weights), "Non-Alcoholic Beer");
});

// Round-1 latent bug: a lowercase-only weights map lets a case-duplicate
// entity silently overwrite another's weight ("Artisanal" 1 mention and
// "artisanal" 2 mentions both key to "artisanal"). Keying by the exact
// original label must take priority so each entity's true volume is used
// for the guard, not whichever case variant happened to be inserted last.
test("uses the exact-case weight, not a case-collapsed one, when both are present", () => {
  const labels = ["artisanal chocolate"];
  // "Artisanal" (exact-case key) truly has 500 mentions; only the stale
  // lowercase key says 2 — the exact key must win so the guard correctly
  // refuses this merge (500 > 4).
  const weights = { Artisanal: 500, artisanal: 2, "artisanal chocolate": 4 };
  assert.equal(findCompoundParent("Artisanal", labels, weights), null);
});
