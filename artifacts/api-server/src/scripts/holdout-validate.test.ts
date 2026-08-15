import { test } from "node:test";
import assert from "node:assert/strict";
import { mannWhitney, median } from "./holdout-validate.js";

// The holdout's entire conclusion rests on this p-value, so the statistic is
// checked against cases with known answers BEFORE it is trusted on real data.

test("identical samples show no separation", () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8];
  const { z, p } = mannWhitney(a, [...a]);
  assert.equal(z, 0);
  assert.ok(p > 0.99, `identical samples should give p~1, got ${p}`);
});

test("completely separated samples are detected as significant", () => {
  const low = Array.from({ length: 20 }, (_, i) => i);
  const high = Array.from({ length: 20 }, (_, i) => 100 + i);
  const { p } = mannWhitney(low, high);
  assert.ok(p < 0.001, `disjoint samples should be highly significant, got p=${p}`);
});

test("U statistic matches a hand-computable case", () => {
  // a=[1,2], b=[3,4]: every a is below every b, so U1 = 0.
  const { u } = mannWhitney([1, 2], [3, 4]);
  assert.equal(u, 0);
  // Reversed, a is entirely above b: U1 = n1*n2 = 4.
  assert.equal(mannWhitney([3, 4], [1, 2]).u, 4);
});

test("ties are handled without producing NaN", () => {
  const a = [5, 5, 5, 5, 5];
  const b = [5, 5, 5, 5, 6];
  const { z, p } = mannWhitney(a, b);
  assert.ok(Number.isFinite(z), `z must be finite with heavy ties, got ${z}`);
  assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `p must be a valid probability, got ${p}`);
});

test("an empty cohort cannot manufacture significance", () => {
  const { p } = mannWhitney([], [1, 2, 3]);
  assert.equal(p, 1);
});

test("median handles even and odd lengths and does not mutate its input", () => {
  const xs = [3, 1, 2];
  assert.equal(median(xs), 2);
  assert.deepEqual(xs, [3, 1, 2], "median must not sort in place");
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});
