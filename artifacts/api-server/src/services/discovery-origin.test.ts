import { test } from "node:test";
import assert from "node:assert/strict";
import { wasSearchedFor, normalizeTerm } from "./discovery-origin.js";

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
