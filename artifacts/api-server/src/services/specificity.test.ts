import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretSpecificityVerdict } from "./specificity.js";

test("keeps a term that is neither everyday-generic nor a category staple", () => {
  const r = interpretSpecificityVerdict({
    everydayGeneric: false,
    categoryStaple: false,
    reason: "named ingredient",
  });
  assert.equal(r.specific, true);
  assert.equal(r.reason, "named ingredient");
});

test("drops on the everyday-generic axis", () => {
  const r = interpretSpecificityVerdict({
    everydayGeneric: true,
    categoryStaple: false,
    reason: "kitchen staple",
  });
  assert.equal(r.specific, false);
});

test("drops on the category-staple axis alone (the gummy-bears case)", () => {
  const r = interpretSpecificityVerdict({
    everydayGeneric: false,
    categoryStaple: true,
    reason: "default gummy sweet",
  });
  assert.equal(r.specific, false);
  assert.equal(r.reason, "default gummy sweet");
});

test("falls back to an axis name when the model gives no reason", () => {
  assert.match(
    interpretSpecificityVerdict({ everydayGeneric: false, categoryStaple: true }).reason,
    /category-wide staple/
  );
});

test("still reads the legacy single-axis `specific` field (cached verdicts)", () => {
  assert.equal(interpretSpecificityVerdict({ specific: false, reason: "generic" }).specific, false);
  assert.equal(interpretSpecificityVerdict({ specific: true }).specific, true);
});

test("defaults to KEEP on missing/malformed verdict (never silently drop)", () => {
  assert.equal(interpretSpecificityVerdict(null).specific, true);
  assert.equal(interpretSpecificityVerdict(undefined).specific, true);
  assert.equal(interpretSpecificityVerdict({}).specific, true);
  assert.equal(interpretSpecificityVerdict({ specific: "yes" as any }).specific, true);
  // a non-boolean on one axis must not be read as `true` and drop the term
  assert.equal(
    interpretSpecificityVerdict({ everydayGeneric: "yes" as any, categoryStaple: "no" as any })
      .specific,
    true
  );
});

test("one usable axis is enough to decide", () => {
  // model answered only categoryStaple -> that alone can drop
  assert.equal(interpretSpecificityVerdict({ categoryStaple: true }).specific, false);
  // model answered only everydayGeneric=false -> nothing says drop, so keep
  assert.equal(interpretSpecificityVerdict({ everydayGeneric: false }).specific, true);
});
