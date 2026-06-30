// Confirmation gate: pure, deterministic, no I/O.
// Decides whether a flagged candidate should surface to the Radar.
//
// This module is the "fourth stage" — it sits between the growth state
// machine and the Radar knowledge base. It is descriptive and reversible:
// it only decides pass/hold for surfacing, and never mutates upstream data.

import type { TpEntityTimeseries, TpPipelineConfig } from "@workspace/db/schema";

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

export interface GateInput {
  dailyMentions: number[];
  sources: SourceObservation[];
}

export interface GateVerdict {
  decision: "pass" | "hold";
  significance: SignificanceResult;
  breadth: BreadthResult;
  reasons: string[];
}

// A candidate surfaces to the Radar only if it BOTH beats its own noise
// (significance) AND is broad-based (source diversity). When the gate is
// disabled via config, it always passes — reverting to current behaviour.
export function confirmationVerdict(
  input: GateInput,
  cfg: GateConfig,
  rng: () => number = Math.random
): GateVerdict {
  const significance = significanceTest(input.dailyMentions, cfg, rng);
  const breadth = sourceBreadth(input.sources, cfg);
  if (!cfg.enabled) {
    return { decision: "pass", significance, breadth, reasons: ["gate disabled"] };
  }
  const reasons = [significance.reason, breadth.reason];
  const decision = significance.pass && breadth.pass ? "pass" : "hold";
  return { decision, significance, breadth, reasons };
}

// --- Adapters: turn pipeline config + timeseries rows into gate inputs ---

// Reads gate thresholds from the pipeline config defensively, falling back to
// sensible defaults. Keys can later be exposed in the control-panel config
// schema without changing this code.
export function gateConfigFromPipeline(config: TpPipelineConfig): GateConfig {
  const c = config as unknown as Record<string, number | boolean | undefined>;
  return {
    significanceAlpha: (c.gateSignificanceAlpha as number) ?? 0.05,
    permutations: (c.gatePermutations as number) ?? 1000,
    minSourceEntropyBits: (c.gateMinSourceEntropyBits as number) ?? 1.0,
    minUniqueAuthors: (c.gateMinUniqueAuthors as number) ?? 3,
    enabled: (c.gateEnabled as boolean) ?? true,
  };
}

// Collapse per-(platform, geo, day) rows into a chronological daily mention
// series plus per-platform source observations (summing authors/mentions).
export function buildGateInput(rows: TpEntityTimeseries[]): GateInput {
  const byDate = new Map<string, number>();
  const byPlatform = new Map<string, { authors: number; mentions: number }>();
  for (const r of rows) {
    byDate.set(r.bucketDate, (byDate.get(r.bucketDate) ?? 0) + r.mentions);
    const p = byPlatform.get(r.platform) ?? { authors: 0, mentions: 0 };
    p.authors += r.uniqueAuthors;
    p.mentions += r.mentions;
    byPlatform.set(r.platform, p);
  }
  const dailyMentions = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v);
  const sources: SourceObservation[] = [...byPlatform.entries()].map(
    ([platform, v]) => ({
      platform,
      uniqueAuthors: v.authors,
      mentions: v.mentions,
    })
  );
  return { dailyMentions, sources };
}
