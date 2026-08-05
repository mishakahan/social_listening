// Unit tests for the label-instance acceptance gate (fix round 4).
//
// WHY THIS EXISTS: fix round 3's only executed run used SKIP_GENERATION=1,
// which returns before generation, summarize(), and the gate ever run. The
// reported PASS was computed by hand from separately-captured numbers — the
// gate itself had never executed. This task's entire history is plausible-
// looking verdicts that turned out to mean nothing (the substring detector
// that would have passed the OLD prompt, the binary judge that flagged
// abstract words as "instance", an unrun acceptance bar). A hand-graded pass
// is the same failure wearing different clothes. These tests exercise the
// exact function main() calls to print PASS/FAIL, so the code path that
// decides the verdict is the code path under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLabelInstanceGate } from "./eval-seed-breadth.js";

test("the actual observed case: OLD 14.3, NEW 2.9 -> PASS", () => {
  const result = evaluateLabelInstanceGate(14.3, 2.9);
  assert.equal(result.bar, 7.15);
  assert.equal(result.pass, true);
});

test("reviewer's sensitivity case: OLD corrected to 21.4 (Avocado sauces MX counted as instance), NEW 2.9 -> still PASS", () => {
  // 21.4% is round 3's real OLD rate (14.3%) with the judge's miss on
  // "Avocado sauces MX" corrected — i.e. 3/14 instead of 2/14 — the
  // reviewer's own stress test of what happens if the judge's one known
  // miss is fixed. The gate should still pass comfortably: 2.9 is nowhere
  // near half of 21.4 (10.7).
  const result = evaluateLabelInstanceGate(21.4, 2.9);
  assert.equal(result.bar, 10.7);
  assert.equal(result.pass, true);
});

test("a case that must FAIL: NEW just above half of OLD", () => {
  // Half of 14.3 is 7.15; 7.2 is just over that.
  const result = evaluateLabelInstanceGate(14.3, 7.2);
  assert.equal(result.bar, 7.15);
  assert.equal(result.pass, false);
});

test("the exact boundary: NEW exactly equal to half of OLD -> PASS", () => {
  // "At most half" includes exactly half — a clean 2x improvement is the
  // bar being met, not missed. Documented explicitly in
  // evaluateLabelInstanceGate's own comment, verified here so a future
  // edit that flips <= to < gets caught.
  const result = evaluateLabelInstanceGate(14.3, 7.15);
  assert.equal(result.bar, 7.15);
  assert.equal(result.pass, true);
});

test("OLD = 0 (no instance labels at all): bar is 0, PASS only if NEW is also 0", () => {
  const zeroVsZero = evaluateLabelInstanceGate(0, 0);
  assert.equal(zeroVsZero.bar, 0);
  assert.equal(zeroVsZero.pass, true);

  const zeroVsPositive = evaluateLabelInstanceGate(0, 2.9);
  assert.equal(zeroVsPositive.bar, 0);
  assert.equal(
    zeroVsPositive.pass,
    false,
    "there is nothing to halve from a zero baseline — any NEW instance rate above zero is a regression from an already-perfect baseline, not a pass"
  );
});
