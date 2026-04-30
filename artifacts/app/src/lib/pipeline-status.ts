import { useCallback, useEffect, useRef, useState } from "react";

export interface PipelineRunStatus {
  extraction: {
    pendingSignals: number;
    failedSignals: number;
    totalSignals: number;
    lastExtractionAt: string | null;
  };
  timeseries: {
    signalsInWindow: number;
    windowDays: number;
    lastComputedAt: string | null;
  };
  stateMachine: {
    activeEntities: number;
    lastComputedAt: string | null;
  };
  meta: {
    extractionBatchSize: number;
    extractionMaxBatches: number;
    extractionSecondsPerBatch: number;
  };
}

export async function fetchPipelineRunStatus(
  companyId: number
): Promise<PipelineRunStatus> {
  const res = await fetch(
    `/api/pipeline/companies/${companyId}/run-status`
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 45) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.round(day / 30);
  return `${mo} mo ago`;
}

function formatSeconds(sec: number): string {
  if (sec < 60) return `~${sec}s`;
  const min = sec / 60;
  if (min < 2) return `~${Math.round(sec / 10) * 10}s`;
  return `~${Math.round(min)} min`;
}

function formatRange(low: number, high: number): string {
  const lowStr = low < 60 ? `${low}s` : `${Math.round(low / 60)}m`;
  const highStr = high < 60 ? `${high}s` : `${Math.round(high / 60)}m`;
  return `~${lowStr}–${highStr}`;
}

export interface StepEstimate {
  scope: string;
  estimate: string;
  willDoWork: boolean;
}

export function extractionEstimate(s: PipelineRunStatus): StepEstimate {
  const pending = s.extraction.pendingSignals;
  const failed = s.extraction.failedSignals;
  const total = s.extraction.totalSignals;
  const { extractionBatchSize, extractionMaxBatches, extractionSecondsPerBatch } =
    s.meta;
  if (pending === 0) {
    if (total === 0) {
      return {
        scope: "No signals ingested yet",
        estimate: "nothing to do",
        willDoWork: false,
      };
    }
    if (failed > 0) {
      // Surface failures explicitly — re-running will not retry them; users
      // need to investigate why they failed (Signals page → Extraction filter).
      return {
        scope: `${(total - failed).toLocaleString()} of ${total.toLocaleString()} signals extracted, ${failed.toLocaleString()} failed`,
        estimate: "no pending work — investigate failed signals",
        willDoWork: false,
      };
    }
    return {
      scope: `All ${total.toLocaleString()} signals already extracted`,
      estimate: "nothing to do",
      willDoWork: false,
    };
  }
  const cap = extractionBatchSize * extractionMaxBatches;
  const willProcess = Math.min(pending, cap);
  const batches = Math.ceil(willProcess / extractionBatchSize);
  const sec = batches * extractionSecondsPerBatch;
  const capped = pending > cap;
  const failedSuffix = failed > 0 ? ` (${failed.toLocaleString()} failed earlier)` : "";
  const scope = capped
    ? `${willProcess.toLocaleString()} of ${pending.toLocaleString()} pending signals (capped per run)${failedSuffix}`
    : `${pending.toLocaleString()} pending signal${pending === 1 ? "" : "s"}${failedSuffix}`;
  return {
    scope,
    estimate: `${batches} batch${batches === 1 ? "" : "es"} · ${formatSeconds(sec)}`,
    willDoWork: true,
  };
}

export function timeseriesEstimate(s: PipelineRunStatus): StepEstimate {
  const n = s.timeseries.signalsInWindow;
  if (n === 0) {
    return {
      scope: `No signals in last ${s.timeseries.windowDays} days`,
      estimate: "nothing to do",
      willDoWork: false,
    };
  }
  // DB-only aggregation. Empirical: <5s up to ~5k signals, ~10–20s for larger
  // sets. Give a coarse range based on signal count.
  const low = n < 5000 ? 2 : 5;
  const high = n < 5000 ? 10 : 30;
  return {
    scope: `${n.toLocaleString()} signal${n === 1 ? "" : "s"} from last ${s.timeseries.windowDays} days`,
    estimate: formatRange(low, high),
    willDoWork: true,
  };
}

export function stateMachineEstimate(s: PipelineRunStatus): StepEstimate {
  const n = s.stateMachine.activeEntities;
  if (n === 0) {
    return {
      scope: "No entities yet — run Extraction first",
      estimate: "nothing to do",
      willDoWork: false,
    };
  }
  // Per-entity DB read + compute + upsert. Empirical: ~30–80ms per entity.
  const low = Math.max(2, Math.round((n * 30) / 1000));
  const high = Math.max(5, Math.round((n * 80) / 1000));
  return {
    scope: `${n.toLocaleString()} active entit${n === 1 ? "y" : "ies"}`,
    estimate: formatRange(low, high),
    willDoWork: true,
  };
}

// ---------------------------------------------------------------------------
// usePipelineRunTracker — tracks "is this step actually still running?" for
// fire-and-forget POST endpoints that return immediately. The TanStack mutation
// `isPending` flag only covers the HTTP call, not the background work, so we
// keep our own per-step "started at" timestamps and clear them when the
// matching `lastRunAt` advances OR a heuristic max duration elapses.
// ---------------------------------------------------------------------------

export type PipelineStepKey = "extraction" | "timeseries" | "stateMachine";

// Heuristic upper bounds for how long a manual run can take, in ms.
// Extraction caps at 50 batches * ~8s = 400s; allow buffer.
// State machine for ~10k entities at ~80ms each = 800s; allow buffer.
const MAX_RUN_MS: Record<PipelineStepKey, number> = {
  extraction: 10 * 60_000,
  timeseries: 3 * 60_000,
  stateMachine: 10 * 60_000,
};

function lastRunAtFor(
  step: PipelineStepKey,
  status: PipelineRunStatus | undefined
): string | null {
  if (!status) return null;
  if (step === "extraction") return status.extraction.lastExtractionAt;
  if (step === "timeseries") return status.timeseries.lastComputedAt;
  return status.stateMachine.lastComputedAt;
}

export interface PipelineRunTracker {
  isRunning: (step: PipelineStepKey) => boolean;
  markStarted: (step: PipelineStepKey) => void;
  anyRunning: boolean;
}

/**
 * Tracks per-step run state independently of mutation.isPending. Pass the
 * latest `status` from the server; call `markStarted(step)` when a POST to a
 * /run-* endpoint succeeds. `isRunning(step)` will stay true until either the
 * matching `lastRunAt` advances past the start time or MAX_RUN_MS elapses.
 */
export function usePipelineRunTracker(
  status: PipelineRunStatus | undefined
): PipelineRunTracker {
  // startedAt[step] = ms timestamp when run was kicked off, or null.
  const [startedAt, setStartedAt] = useState<
    Record<PipelineStepKey, number | null>
  >({ extraction: null, timeseries: null, stateMachine: null });

  // Tick state to force re-evaluation on a timer (so the timeout fires even
  // when the polled status doesn't change).
  const [, setTick] = useState(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const anyStarted = (Object.values(startedAt) as Array<number | null>).some(
    (v) => v !== null
  );

  useEffect(() => {
    if (anyStarted && tickerRef.current === null) {
      tickerRef.current = setInterval(() => setTick((n) => n + 1), 2_000);
    } else if (!anyStarted && tickerRef.current !== null) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
    return () => {
      if (tickerRef.current !== null) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
    };
  }, [anyStarted]);

  // Clear startedAt for any step whose lastRunAt has now advanced past it,
  // OR whose timeout has elapsed. Runs whenever status updates or the tick
  // forces a re-render.
  useEffect(() => {
    setStartedAt((prev) => {
      let changed = false;
      const next = { ...prev };
      const now = Date.now();
      for (const step of Object.keys(prev) as PipelineStepKey[]) {
        const t = prev[step];
        if (t === null) continue;
        const lastIso = lastRunAtFor(step, status);
        const lastMs = lastIso ? new Date(lastIso).getTime() : 0;
        const elapsed = now - t;
        if (lastMs > t || elapsed > MAX_RUN_MS[step]) {
          next[step] = null;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [status]);

  const isRunning = useCallback(
    (step: PipelineStepKey) => {
      const t = startedAt[step];
      if (t === null) return false;
      const lastIso = lastRunAtFor(step, status);
      const lastMs = lastIso ? new Date(lastIso).getTime() : 0;
      if (lastMs > t) return false;
      if (Date.now() - t > MAX_RUN_MS[step]) return false;
      return true;
    },
    [startedAt, status]
  );

  const markStarted = useCallback((step: PipelineStepKey) => {
    setStartedAt((prev) => ({ ...prev, [step]: Date.now() }));
  }, []);

  const anyRunning =
    isRunning("extraction") ||
    isRunning("timeseries") ||
    isRunning("stateMachine");

  return { isRunning, markStarted, anyRunning };
}
