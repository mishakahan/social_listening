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
