import { test } from "node:test";
import assert from "node:assert/strict";
// Import from the schema entrypoint, not the package root — the root runs
// db connection code that requires DATABASE_URL, which these pure tests omit.
import { tpEntityState } from "@workspace/db/schema";

test("tp_entity_state has confirmationVerdict column", () => {
  assert.ok("confirmationVerdict" in tpEntityState, "column missing");
});
