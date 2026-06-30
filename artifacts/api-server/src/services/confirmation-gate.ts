// Confirmation gate: pure, deterministic, no I/O.
// Decides whether a flagged candidate should surface to the Radar.
//
// This module is the "fourth stage" — it sits between the growth state
// machine and the Radar knowledge base. It is descriptive and reversible:
// it only decides pass/hold for surfacing, and never mutates upstream data.

export interface GateConfig {
  significanceAlpha: number; // e.g. 0.05
  permutations: number; // e.g. 1000
  minSourceEntropyBits: number; // e.g. 1.0
  minUniqueAuthors: number; // e.g. 3
  enabled: boolean; // master toggle (revert behaviour)
}

export function sourceBreadth(): never {
  throw new Error("not implemented");
}
