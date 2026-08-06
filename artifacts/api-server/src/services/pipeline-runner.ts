// Chains the five per-stage endpoints behind one call. Stage work is injected
// so the sequencing is testable without a database or Apify.
//
// State is in-process and deliberately so: a run is a foreground operation
// someone is watching. If the server restarts mid-run the run is gone, which is
// honest — the underlying stages are all individually re-runnable.

export const PIPELINE_STAGES = [
  "scrape",
  "ingest",
  "extract",
  "timeseries",
  "state-machine",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// A stage may optionally report how much work it actually found/did. The
// runner acts on this for exactly one case right now: "ingest" reporting
// itemsProcessed === 0. That specifically means nothing was available to
// ingest — which is the normal, expected outcome seconds after "scrape"
// fires, because scrape only *launches* Apify runs (launchBatch resolves as
// soon as the actor calls are started, not when they finish). Real data
// lands hours later via the Apify webhook, which already drives its own
// ingest -> extract -> timeseries -> state-machine chain per batch (see
// launch-batch.ts finalizeBatchIfDone). If we blindly ran extract/
// timeseries/state-machine here anyway, they'd process nothing new (or
// silently reprocess stale data) and the run would report "done" — which is
// a lie about a run that ingested nothing. A stage that returns void (every
// stage in the pre-existing test suite, and any stage with nothing to say)
// is treated as "no opinion" and the pipeline proceeds exactly as before.
export interface StageResult {
  itemsProcessed?: number;
}

export type StageFn = (companyId: number) => Promise<StageResult | void>;
export type StageDeps = Record<PipelineStage, StageFn>;

export interface RunState {
  runId: string;
  companyId: number;
  stage: PipelineStage;
  // "awaiting-data": scrape launched successfully but the ingest safety-net
  // pass found nothing to do — i.e. this run has not ingested anything.
  // Distinct from "done" on purpose; see the itemsProcessed comment above.
  status: "running" | "done" | "failed" | "awaiting-data";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  stageIndex: number;
  totalStages: number;
}

const runs = new Map<number, RunState>();

// Hard ceiling on how long a single stage may run before the pipeline gives
// up on it and marks the run failed, instead of leaving status:"running"
// forever (previously only a server restart could clear a wedged company).
// Generous on purpose: every stage here is bounded work — launchBatch only
// *issues* start calls, and the ingest stage is capped (see
// routes/pipeline.ts) — so 30 minutes is well above any expected duration
// and exists purely as a backstop against a genuinely hung call.
const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60 * 1000;

export function __resetRunsForTest(): void {
  runs.clear();
}

export function nextStage(current: PipelineStage): PipelineStage | null {
  const i = PIPELINE_STAGES.indexOf(current);
  if (i < 0 || i === PIPELINE_STAGES.length - 1) return null;
  return PIPELINE_STAGES[i + 1]!;
}

export function getPipelineRun(companyId: number): RunState | null {
  return runs.get(companyId) ?? null;
}

// Manual escape hatch so a wedged company doesn't require a server restart
// to unstick — a developer (or eventually an admin action) can clear a
// stuck "running" state directly. Replaces the map entry with a new object
// (rather than mutating the existing one in place) so an in-flight
// startPipelineRun loop that eventually resumes can detect it has been
// superseded and stop touching state that something else now owns — see
// the `runs.get(companyId) !== state` guards below.
export function resetPipelineRun(companyId: number): RunState | null {
  const existing = runs.get(companyId);
  if (!existing || existing.status !== "running") return null;
  const reset: RunState = {
    ...existing,
    status: "failed",
    error: "Manually reset",
    finishedAt: new Date().toISOString(),
  };
  runs.set(companyId, reset);
  return reset;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Stage "${label}" timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export async function startPipelineRun(
  companyId: number,
  deps: StageDeps,
  opts?: { stageTimeoutMs?: number }
): Promise<RunState> {
  const stageTimeoutMs = opts?.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;

  const existing = runs.get(companyId);
  if (existing && existing.status === "running") {
    throw new Error(`pipeline already running for company ${companyId}`);
  }

  const state: RunState = {
    runId: `${companyId}-${Date.now()}`,
    companyId,
    stage: PIPELINE_STAGES[0]!,
    status: "running",
    startedAt: new Date().toISOString(),
    stageIndex: 0,
    totalStages: PIPELINE_STAGES.length,
  };
  runs.set(companyId, state);

  for (let i = 0; i < PIPELINE_STAGES.length; i++) {
    const stage = PIPELINE_STAGES[i]!;
    state.stage = stage;
    state.stageIndex = i;

    let result: StageResult | void;
    try {
      result = await withTimeout(deps[stage](companyId), stageTimeoutMs, stage);
    } catch (e: any) {
      // A manual reset (or, in principle, a newer run) may have replaced
      // this run's map entry while we were awaiting. If so, that entry owns
      // the outcome now — don't stomp it with a failure it didn't have.
      if (runs.get(companyId) === state) {
        state.status = "failed";
        state.error = e?.message ?? String(e);
        state.finishedAt = new Date().toISOString();
      }
      return state;
    }

    if (runs.get(companyId) !== state) {
      // Superseded mid-stage — stop mutating a run nothing points at anymore.
      return state;
    }

    if (
      stage === "ingest" &&
      result &&
      typeof result.itemsProcessed === "number" &&
      result.itemsProcessed === 0
    ) {
      state.status = "awaiting-data";
      state.finishedAt = new Date().toISOString();
      return state;
    }
  }

  if (runs.get(companyId) === state) {
    state.status = "done";
    state.stageIndex = PIPELINE_STAGES.length;
    state.finishedAt = new Date().toISOString();
  }
  return state;
}
