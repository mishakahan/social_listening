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

export interface SignificanceResult {
  observedStat: number;
  pValue: number;
  pass: boolean;
  reason: string;
}

// Statistic: (most-recent 7-day sum) minus (mean 7-day sum over history).
// A real surge sits far above the entity's typical window.
function last7Stat(series: number[]): number {
  const n = series.length;
  const recent = series.slice(n - 7).reduce((s, v) => s + v, 0);
  let windows = 0;
  let total = 0;
  for (let i = 0; i + 7 <= n; i++) {
    total += series.slice(i, i + 7).reduce((s, v) => s + v, 0);
    windows++;
  }
  const mean = windows > 0 ? total / windows : 0;
  return recent - mean;
}

function shuffle(arr: number[], rng: () => number): number[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Permutation test against the entity's OWN history. We shuffle the daily
// series many times and rebuild the statistic to form a null distribution.
// The p-value is the fraction of shuffles whose statistic >= observed.
// This replaces "growth > fixed threshold" with "bigger than this entity's
// own noise would plausibly produce."
export function significanceTest(
  dailyMentions: number[],
  cfg: GateConfig,
  rng: () => number = Math.random
): SignificanceResult {
  if (dailyMentions.length < 14) {
    return {
      observedStat: 0,
      pValue: 1,
      pass: false,
      reason: "insufficient history (<14d)",
    };
  }
  const observed = last7Stat(dailyMentions);
  let atLeast = 0;
  for (let k = 0; k < cfg.permutations; k++) {
    if (last7Stat(shuffle(dailyMentions, rng)) >= observed) atLeast++;
  }
  const pValue = (atLeast + 1) / (cfg.permutations + 1); // +1 smoothing
  const pass = pValue <= cfg.significanceAlpha;
  const reason = pass
    ? `significant: p=${pValue.toFixed(3)} (obs=${observed.toFixed(1)})`
    : `not beyond own noise: p=${pValue.toFixed(3)}`;
  return { observedStat: observed, pValue, pass, reason };
}
