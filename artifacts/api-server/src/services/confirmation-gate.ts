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

export interface SourceObservation {
  platform: string;
  uniqueAuthors: number;
  mentions: number;
}

export interface BreadthResult {
  entropyBits: number;
  totalAuthors: number;
  pass: boolean;
  reason: string;
}

// Shannon entropy (in bits) over how unique authors are distributed across
// sources. A single dominant source -> ~0 bits -> held. A broad spread of
// authors across platforms -> high bits -> passes. This is what catches the
// "one coffee shop posts 10 times" case the current state machine misses.
export function sourceBreadth(
  obs: SourceObservation[],
  cfg: GateConfig
): BreadthResult {
  const totalAuthors = obs.reduce((s, o) => s + Math.max(0, o.uniqueAuthors), 0);
  if (totalAuthors === 0) {
    return { entropyBits: 0, totalAuthors: 0, pass: false, reason: "no authors" };
  }
  let entropyBits = 0;
  for (const o of obs) {
    const p = o.uniqueAuthors / totalAuthors;
    if (p > 0) entropyBits -= p * Math.log2(p);
  }
  const pass =
    entropyBits >= cfg.minSourceEntropyBits && totalAuthors >= cfg.minUniqueAuthors;
  const reason = pass
    ? `breadth ok: ${entropyBits.toFixed(2)} bits, ${totalAuthors} authors`
    : `too concentrated: ${entropyBits.toFixed(2)} bits, ${totalAuthors} authors`;
  return { entropyBits, totalAuthors, pass, reason };
}
