import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretSpecificityVerdict } from "./specificity.js";

test("keeps a specific verdict", () => {
  const r = interpretSpecificityVerdict({ specific: true, reason: "named ingredient" });
  assert.equal(r.specific, true);
  assert.equal(r.reason, "named ingredient");
});

test("drops a generic verdict", () => {
  const r = interpretSpecificityVerdict({ specific: false, reason: "everyday word" });
  assert.equal(r.specific, false);
});

test("defaults to KEEP on missing/malformed verdict (never silently drop)", () => {
  assert.equal(interpretSpecificityVerdict(null).specific, true);
  assert.equal(interpretSpecificityVerdict(undefined).specific, true);
  assert.equal(interpretSpecificityVerdict({}).specific, true);
  assert.equal(interpretSpecificityVerdict({ specific: "yes" as any }).specific, true);
});
