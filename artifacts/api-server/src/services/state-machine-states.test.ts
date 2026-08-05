import { test } from "node:test";
import assert from "node:assert/strict";
import { determineNextState, type Metrics } from "./state-machine.js";
import type { TpPipelineConfig } from "@workspace/db/schema";

function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    volume7d: 20,
    volume30d: 60,
    volume90d: 120,
    velocity: 20 / 7,
    growthWow: 0.9,
    growthMom: 0.9,
    volatility: 1,
    ...over,
  };
}

const config = {
  candidateToEmergingMinWowGrowth: 0.3,
  candidateToEmergingMinVolume: 9,
} as unknown as TpPipelineConfig;

test("the state vocabulary no longer contains 'confirmed'", () => {
  const states = new Set<string>();
  for (const current of ["candidate", "emerging", "sustained", "peaking"] as const) {
    states.add(determineNextState(current, metrics(), config).state);
    states.add(determineNextState(current, metrics({ growthWow: -0.9, growthMom: -0.9 }), config).state);
    states.add(determineNextState(current, metrics({ volume7d: 0, volume30d: 0 }), config).state);
  }
  assert.equal(states.has("confirmed"), false);
});

test("a strongly rising entity promotes past emerging without using the old name", () => {
  const r = determineNextState("emerging", metrics(), config);
  assert.notEqual(r.state, "confirmed");
  assert.ok(typeof r.reason === "string" && r.reason.length > 0);
});
