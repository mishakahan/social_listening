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
  // Whether a candidate must clear the SIGNIFICANCE test to surface, or only
  // the breadth test. Defaults to true, i.e. current shipped behaviour is
  // unchanged unless this is explicitly turned off.
  //
  // WHY THIS EXISTS (measured 2026-08-08, scripts/holdout-validate.ts and
  // scripts/gate-variants.ts). A retrospective holdout replayed this gate at
  // three past cutoffs and compared what the passed and held cohorts actually
  // did over the following 56 days:
  //
  //   cutoff    shipped (sig AND breadth)   breadth only
  //   Apr 22    1.43x edge, 93 surfaced     1.55x edge, 162 surfaced
  //   May 07    1.44x edge, 82 surfaced     1.50x edge, 162 surfaced
  //   May 22    1.43x edge, 70 surfaced     1.65x edge, 151 surfaced
  //
  // The significance test on its own separates nothing: on 760 Leone entities
  // its passed and held cohorts grew at 1.44x versus 1.44x, a ratio of exactly
  // 1.00 (p=0.73), replicated on Fast Food at 0.91x (p=0.31). Requiring it
  // therefore costs roughly half the coverage and lowers the quality of what
  // survives, at every cutoff tested. Breadth carries the entire edge.
  //
  // It is left ON by default regardless, because the significance test is a
  // CONTRACTED deliverable and removing it is the client's decision, not a
  // silent code change. Turn it off per company once that decision is made.
  requireSignificance: boolean;
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
  // The significance result is ALWAYS computed and always reported, even when
  // it is not required to pass. Keeping it visible means a verdict stays
  // auditable, the backtest can still be run both ways, and turning the
  // requirement back on is a config flip rather than a rebuild.
  const requireSignificance = cfg.requireSignificance !== false;
  const reasons = [
    requireSignificance
      ? significance.reason
      : `${significance.reason} (not required)`,
    breadth.reason,
  ];
  const decision =
    (requireSignificance ? significance.pass : true) && breadth.pass
      ? "pass"
      : "hold";
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
    // Per-company config columns for the gate were never added, so these read as
    // undefined and fall through to the defaults. GATE_MIN_ENTROPY_BITS lets a
    // run override the breadth threshold without a schema change — used to loosen
    // breadth for a deliberately single-platform-heavy scrape (e.g. TikTok fan-out)
    // where 1.0 bits holds almost everything. Default stays 1.0.
    minSourceEntropyBits:
      (c.gateMinSourceEntropyBits as number) ??
      (Number(process.env.GATE_MIN_ENTROPY_BITS) || 1.0),
    minUniqueAuthors: (c.gateMinUniqueAuthors as number) ?? 3,
    enabled: (c.gateEnabled as boolean) ?? true,
    // Same defensive per-company pattern as minSourceEntropyBits above: read a
    // pipeline_config column if one is ever added, else an env override, else
    // the shipped default. GATE_REQUIRE_SIGNIFICANCE=false switches the gate
    // to breadth-only — the configuration the holdout measured as strictly
    // better on both edge and coverage (see GateConfig.requireSignificance).
    // Only an explicit "false" disables it; anything else keeps it on, so a
    // typo or an empty string can never silently weaken the gate.
    requireSignificance:
      (c.gateRequireSignificance as boolean) ??
      (process.env.GATE_REQUIRE_SIGNIFICANCE !== "false"),
  };
}

// Max length of the continuous daily series. Caps the zero-fill so an ancient
// stray mention can't create a series thousands of days long.
const GATE_WINDOW_DAYS = 180;

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000
  );
}

// Turn {date -> mentions} into a continuous, zero-filled daily array ending on
// the last active day, spanning at most GATE_WINDOW_DAYS.
function buildDailySeries(byDate: Map<string, number>): number[] {
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return [];
  const last = dates[dates.length - 1]!;
  const earliest = dates[0]!;
  const span = daysBetween(earliest, last);
  const windowStartOffset = Math.min(span, GATE_WINDOW_DAYS - 1);
  const startDate = new Date(Date.parse(last + "T00:00:00Z") - windowStartOffset * 86400000)
    .toISOString()
    .slice(0, 10);
  const len = windowStartOffset + 1;
  const series = new Array<number>(len).fill(0);
  for (const [d, v] of byDate) {
    const idx = daysBetween(startDate, d);
    if (idx >= 0 && idx < len) series[idx] = (series[idx] ?? 0) + v;
  }
  return series;
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
  // Build a CONTINUOUS daily series (zero-filling days with no mentions) so the
  // significance test can see "quiet historically, then rising" — collapsing to
  // only active days hides exactly the acceleration it should detect. Bound the
  // series to a recent window (from the last active day back at most
  // GATE_WINDOW_DAYS) so ancient history doesn't create a giant all-zero array.
  const dailyMentions = buildDailySeries(byDate);
  const sources: SourceObservation[] = [...byPlatform.entries()].map(
    ([platform, v]) => ({
      platform,
      uniqueAuthors: v.authors,
      mentions: v.mentions,
    })
  );
  return { dailyMentions, sources };
}
