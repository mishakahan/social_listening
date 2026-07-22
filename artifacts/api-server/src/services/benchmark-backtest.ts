// Backtest the confirmation gate against the Exploding Topics benchmark
// (Schedule B). The benchmark is a list of things that *genuinely* trended, so
// the gate SHOULD pass them once they have social data. We scrape the benchmark
// terms, run the pipeline, and compare.
//
// This module is the pure comparison/reporting logic. It takes benchmark trends
// and the pipeline's entity verdicts and produces a documented result table.

import { canonicalizeLabel } from "./entity-canonical.js";

export interface BenchmarkTrend {
  name: string;
  growth?: string;
  description?: string;
}

// One evaluated entity from the pipeline: its label, whether it got a gate
// verdict, and what the verdict was.
export interface EntityVerdict {
  label: string;
  hadData: boolean; // did the pipeline see any social signal for it
  decision: "pass" | "hold" | null; // null = never reached the gate
  significanceP?: number;
  entropyBits?: number;
}

export type BacktestOutcome =
  | "confirmed" // benchmark trend + gate passed it -> correct
  | "held-no-signal" // no social data, so held (honest limitation, not a miss)
  | "held-flat" // had data but gate held it (may be a miss, or genuinely not trending on social)
  | "not-found"; // never surfaced as an entity at all

export interface BacktestRow {
  trend: string;
  outcome: BacktestOutcome;
  decision: "pass" | "hold" | null;
  note: string;
}

// Match a benchmark trend name to a scraped entity label. Canonicalize both
// (lowercase, singularize) and compare; also allow a benchmark name to match an
// entity that contains it (e.g. "Athletic Brewing" ~ "athletic brewing co").
export function matchTrendToEntity(
  trendName: string,
  entities: EntityVerdict[]
): EntityVerdict | null {
  const t = canonicalizeLabel(trendName);
  // exact canonical match first
  let m = entities.find((e) => canonicalizeLabel(e.label) === t);
  if (m) return m;
  // Containment only for MULTI-WORD trend names (specific brands like
  // "athletic brewing" ~ "athletic brewing co"). A single generic word ("milk")
  // must match exactly, or it would wrongly hoover up any entity that contains
  // it ("non-homogenized milk").
  if (t.includes(" ")) {
    m = entities.find((e) => {
      const el = canonicalizeLabel(e.label);
      return el.includes(t) || t.includes(el);
    });
  }
  return m ?? null;
}

export function evaluateTrend(
  trend: BenchmarkTrend,
  entities: EntityVerdict[]
): BacktestRow {
  const match = matchTrendToEntity(trend.name, entities);
  if (!match) {
    return {
      trend: trend.name,
      outcome: "not-found",
      decision: null,
      note: "never surfaced as an entity (no social presence in the scrape)",
    };
  }
  if (!match.hadData || match.decision === null) {
    return {
      trend: trend.name,
      outcome: "held-no-signal",
      decision: match.decision,
      note: "found but too little social signal to evaluate",
    };
  }
  if (match.decision === "pass") {
    return {
      trend: trend.name,
      outcome: "confirmed",
      decision: "pass",
      note: `gate confirmed (p=${match.significanceP?.toFixed(3)}, bits=${match.entropyBits?.toFixed(2)})`,
    };
  }
  return {
    trend: trend.name,
    outcome: "held-flat",
    decision: "hold",
    note: `held despite being a known trend (p=${match.significanceP?.toFixed(3)}, bits=${match.entropyBits?.toFixed(2)}) — check if it has real social movement`,
  };
}

export interface BacktestSummary {
  total: number;
  confirmed: number;
  heldNoSignal: number;
  heldFlat: number;
  notFound: number;
  rows: BacktestRow[];
}

export function runBacktest(
  trends: BenchmarkTrend[],
  entities: EntityVerdict[]
): BacktestSummary {
  const rows = trends.map((t) => evaluateTrend(t, entities));
  return {
    total: rows.length,
    confirmed: rows.filter((r) => r.outcome === "confirmed").length,
    heldNoSignal: rows.filter((r) => r.outcome === "held-no-signal").length,
    heldFlat: rows.filter((r) => r.outcome === "held-flat").length,
    notFound: rows.filter((r) => r.outcome === "not-found").length,
    rows,
  };
}
