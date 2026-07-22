import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeLabel } from "./entity-canonical.js";

test("merges casing and plural of single-word labels", () => {
  assert.equal(canonicalizeLabel("Gummies"), "gummy");
  assert.equal(canonicalizeLabel("Gummy"), "gummy");
  assert.equal(canonicalizeLabel("gummy"), "gummy");
  assert.equal(canonicalizeLabel("  GUMMIES "), "gummy");
});

test("singularizes other common single words", () => {
  assert.equal(canonicalizeLabel("Mocktails"), "mocktail");
  assert.equal(canonicalizeLabel("Vitamins"), "vitamin");
  assert.equal(canonicalizeLabel("Boxes"), "box");
  assert.equal(canonicalizeLabel("Candies"), "candy");
});

test("strips corporate suffixes so brand variants merge", () => {
  assert.equal(canonicalizeLabel("Athletic Brewing Company"), "athletic brewing");
  assert.equal(canonicalizeLabel("Athletic Brewing Co."), "athletic brewing");
  assert.equal(canonicalizeLabel("Athletic Brewing Co"), "athletic brewing");
  assert.equal(canonicalizeLabel("TALEA Beer Co."), "talea beer");
  assert.equal(canonicalizeLabel("Nomadica Inc"), "nomadica");
  assert.equal(canonicalizeLabel("Some Brand LLC"), "some brand");
  // the base name is unchanged
  assert.equal(canonicalizeLabel("Athletic Brewing"), "athletic brewing");
});

test("suffix strip does NOT eat real product words", () => {
  // "bears", "sauce" etc are not corporate suffixes -> stay
  assert.equal(canonicalizeLabel("Gummy Bears"), "gummy bears");
  assert.equal(canonicalizeLabel("Hot Sauce"), "hot sauce");
  // don't strip a suffix that's the ONLY word or would empty it
  assert.equal(canonicalizeLabel("Company"), "company");
});

test("does NOT collapse distinct multi-word products into the single word", () => {
  // the whole point: these must stay separate from "gummy"
  assert.equal(canonicalizeLabel("Gummy Bears"), "gummy bears");
  assert.equal(canonicalizeLabel("THC Gummies"), "thc gummies");
  assert.equal(canonicalizeLabel("Hot Sauce"), "hot sauce");
});

test("leaves already-singular and mass nouns alone", () => {
  assert.equal(canonicalizeLabel("Chocolate"), "chocolate");
  assert.equal(canonicalizeLabel("Glass"), "glass"); // -ss not stripped
  assert.equal(canonicalizeLabel("Honey"), "honey");
});

// Regression: the trailing-"s" rule stripped these into nonsense, and because
// the mangled form BECAME the canonical label the damage was invisible —
// "citrus" reached the live radar as "citru" with 27 mentions.
test("does not mangle singular words that end in s", () => {
  assert.equal(canonicalizeLabel("Citrus"), "citrus");
  assert.equal(canonicalizeLabel("Hummus"), "hummus");
  assert.equal(canonicalizeLabel("Couscous"), "couscous");
  assert.equal(canonicalizeLabel("Asparagus"), "asparagus");
  assert.equal(canonicalizeLabel("Hibiscus"), "hibiscus");
  assert.equal(canonicalizeLabel("Molasses"), "molasses");
  assert.equal(canonicalizeLabel("Swiss"), "swiss");
});

test("still singularizes real plurals after the -us/-is guard", () => {
  assert.equal(canonicalizeLabel("Chips"), "chip");
  assert.equal(canonicalizeLabel("Dates"), "date");
  assert.equal(canonicalizeLabel("Oats"), "oat");
  assert.equal(canonicalizeLabel("Glasses"), "glass");
  assert.equal(canonicalizeLabel("Gummies"), "gummy");
  assert.equal(canonicalizeLabel("Dishes"), "dish");
});

test("handles empty / whitespace", () => {
  assert.equal(canonicalizeLabel(""), "");
  assert.equal(canonicalizeLabel("   "), "");
});
