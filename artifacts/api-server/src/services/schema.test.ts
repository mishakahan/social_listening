import { test } from "node:test";
import assert from "node:assert/strict";
// Import from the schema entrypoint, not the package root — the root runs
// db connection code that requires DATABASE_URL, which these pure tests omit.
import { tpEntityState, tpPipelineConfig } from "@workspace/db/schema";

test("tp_entity_state has confirmationVerdict column", () => {
  assert.ok("confirmationVerdict" in tpEntityState, "column missing");
});

// ---------------------------------------------------------------------------
// Gate columns on tp_pipeline_config.
//
// gateConfigFromPipeline has always READ these keys, but they were never DB
// columns, so they read as undefined and fell through to env/defaults — which
// is why the Control Panel could expose 45 keys and still not reach the gate.
//
// The defaults below are load-bearing: they must reproduce the CURRENTLY LIVE
// behaviour exactly. No GATE_* env override is set in this deployment, so the
// live radar (135 items for company 2, as of the 2026-08-09 sweep) was computed
// at 1.0 bits with the significance test required. A column defaulting to
// anything else would silently change every verdict on the next recompute.
// ---------------------------------------------------------------------------

const gateColumnDefaults: Array<[string, unknown]> = [
  ["gateEnabled", true],
  ["gateMinSourceEntropyBits", 1.0],
  ["gateRequireSignificance", true],
];

for (const [column, expected] of gateColumnDefaults) {
  test(`tp_pipeline_config.${column} exists and defaults to shipped behaviour`, () => {
    assert.ok(column in tpPipelineConfig, `column ${column} missing`);
    const col = (tpPipelineConfig as unknown as Record<string, { default: unknown; notNull: boolean }>)[column]!;
    assert.equal(col.notNull, true, `${column} must be NOT NULL so the gate always has a value`);
    assert.equal(
      col.default,
      expected,
      `${column} default must reproduce live behaviour, not a new preference`
    );
  });
}
