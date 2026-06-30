import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceBreadth } from "./confirmation-gate.js";

test("module loads and sourceBreadth is callable", () => {
  assert.equal(typeof sourceBreadth, "function");
});
