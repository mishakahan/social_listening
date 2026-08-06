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

export type StageDeps = Record<PipelineStage, (companyId: number) => Promise<void>>;

export interface RunState {
  runId: string;
  companyId: number;
  stage: PipelineStage;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  stageIndex: number;
  totalStages: number;
}

const runs = new Map<number, RunState>();

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

export async function startPipelineRun(
  companyId: number,
  deps: StageDeps
): Promise<RunState> {
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
    try {
      await deps[stage](companyId);
    } catch (e: any) {
      state.status = "failed";
      state.error = e?.message ?? String(e);
      state.finishedAt = new Date().toISOString();
      return state;
    }
  }

  state.status = "done";
  state.stageIndex = PIPELINE_STAGES.length;
  state.finishedAt = new Date().toISOString();
  return state;
}
