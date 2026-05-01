# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Trend Pipeline notes

- Per-company pipeline tuning lives in `tp_pipeline_config`. Most knobs are
  single columns (noise floor, growth thresholds, lifecycle weeks, etc.); the
  author allowlist and the entity-type taxonomy are stored as JSONB.
- The 13-type entity taxonomy is **user-editable** from `/radar/control-panel`
  (Entity Types accordion). Defaults live in `lib/db/src/schema/index.ts` as
  `DEFAULT_ENTITY_TYPES`; existing rows keep their stored type id even if the
  user removes/renames it.
- Entity extraction (`artifacts/api-server/src/services/entity-extraction.ts`)
  builds the LLM system prompt per-company from this config. Unknown LLM
  outputs fall back to "other" if present, otherwise the entity is dropped
  rather than misclassified.
- The Control Panel auto-saves with a 600ms debounce. PATCH payloads to
  `/api/pipeline/companies/:id/pipeline-config` are validated by a Zod schema
  in `artifacts/api-server/src/routes/pipeline.ts` (id format, required label,
  unique ids, at-least-one type).
- The Entities Audit page (`/radar/audit/entities`) shows a Pipeline panel with
  three numbered steps (Extraction → Timeseries → State Machine). Each row
  shows scope (what will be processed), a rough time estimate, and the last-run
  timestamp. Scope/estimates come from `GET /api/pipeline/companies/:id/run-status`,
  which counts pending/failed signals, joined signal×entity rows in the
  timeseries window, and active (non-deleted) entities. Pipeline jobs are
  fire-and-forget HTTP POSTs; the UI tracks "running" state via
  `usePipelineRunTracker` (in `artifacts/app/src/lib/pipeline-status.ts`),
  which clears each step's running flag when its `lastRunAt` advances or after
  a heuristic timeout (extraction 10 min, timeseries 3 min, state machine 10 min).
  While any step is running, the page polls run-status every 3s and invalidates
  entity-states / signals queries on completion so users see fresh data.
- **Google Trends storage (Option B)**: search-interest data does **not** flow
  through `tp_raw_signals` (which is reserved for actual social mentions with
  per-post engagement counts). It lives in its own narrow table
  `tp_keyword_interest (company_id, actor_run_id, keyword, geo, bucket_date,
  interest_value 0–100, fetched_at)`, dedup'd by
  `(company_id, keyword, geo, bucket_date)` and upserted on re-run.
  Ingestion routing branches on `run.platform === "google_trends"` →
  `ingestGoogleTrendsRun` (in `services/ingestion.ts`); both the Apify webhook
  path (`routes/pipeline.ts: triggerIngestion`) and the orphan-run poll
  fallback (`src/index.ts`) honor the branch. The parser handles all observed
  Apify google-trends-scraper shapes (flat one-row-per-item, `interestOverTime`
  with tagged objects, parallel arrays, scalar-per-point, keyed-map).
- **Scout pull schedule + auto-chained pipeline** (`services/launch-batch.ts`):
  Every launch — manual via `POST /api/pipeline/companies/:id/scout-queries/launch`
  or cron-driven — goes through `launchBatch(companyId, {kind, queryIds?})`. It
  creates a `tp_launch_batches` row (id text PK, kind = "manual"|"cron",
  runs_total), tags every fired actor run with `launch_batch_id`, and stamps
  `lastScoutPullAt`. A `try/finally` reconciles `runs_total` to the actual
  number of `tp_actor_runs` rows written, so finalize works even on mid-loop
  errors. When every run in a batch reaches a terminal state AND every
  succeeded run has finished post-processing (ingestion + entity extraction),
  `finalizeBatchIfDone(batchId)` does an atomic SQL `UPDATE ... WHERE
  finalized_at IS NULL AND runs_total = COUNT(actor_runs) AND NOT EXISTS
  (non-terminal runs OR succeeded-but-ingestion-not-terminal)` — terminal
  status vocabulary `succeeded|failed|timeout` matches what `mapApifyStatus`
  writes; terminal ingestion vocabulary is `done|failed`. On success the
  chain runs `runTimeseriesAggregation` then `runStateMachine`, stamping
  `lastTimeseriesRunAt` / `lastStateMachineRunAt`. `finalizeBatchIfDone` is
  invoked from the Apify webhook (in a `try/finally` so it still fires when
  ingestion throws), the orphan-run poll fallback in `src/index.ts`, manual
  cancel/bulk-cancel handlers, and one defensive call inside `launchBatch`'s
  own `finally` block for batches whose spawn loop throws.
- **Ingestion ordering & ownership** (`services/ingestion.ts`,
  `routes/pipeline.ts triggerIngestion`, polling fallback in `src/index.ts`):
  `ingestActorRun` accepts `{ skipMarkDone?: boolean }` and returns
  `{ claimed, usable, dropped, oldestPostedAt, newestPostedAt }`. Both
  webhook and poll callers pass `skipMarkDone:true`, then check
  `stats.claimed` (skipping downstream work if another worker already owns
  the run), then run entity extraction, then explicitly call
  `markIngestionDone`. If extraction throws they call `markIngestionFailed`
  before re-throwing. This guarantees: (a) the finalize SQL guard only
  releases AFTER extraction is done, so the post-batch chain never sees
  half-extracted entities; (b) duplicate webhook+poll triggers cannot race
  to release the guard early; (c) extraction failures still let the batch
  finalize. Runs that bypass ingestion (failed, timeout, succeeded-with-no-
  dataset, manual cancels) explicitly call `markIngestionDone` with zero
  counts before `finalizeBatchIfDone` so the guard can pass.
- **Cron jobs** (`src/index.ts`): hourly `0 * * * *` checks every company with
  active scout queries; if `scoutPullCadence != 'manual'` and the current UTC
  hour matches `scoutPullDow` + `scoutPullHourUtc` and `lastScoutPullAt`
  is older than `cadenceDays * 24h - 30min` (cadence map weekly=7,
  biweekly=14, monthly=30), it calls `launchBatch(companyId, {kind:'cron'})`.
  Nightly `0 2 * * *` runs timeseries per company **only when**
  `hasFreshActorRunsSince(lastTimeseriesRunAt)` returns true (gated on freshness
  to avoid wasted work). Nightly `30 2 * * *` runs the state machine
  unconditionally (cheap, and a daily lifecycle re-eval is desirable even with
  no new signals). Both nightly jobs stamp their respective `lastRunAt` columns,
  as do the manual `run-timeseries` / `run-state-machine` endpoints.
- **Schedule UI**: `/radar/control-panel` has a "Scout pull schedule" card at the
  top with cadence/day-of-week/hour-UTC selects (auto-saved via PATCH
  `/api/pipeline/companies/:id/pipeline-config`; `patchConfigSchema` validates
  the cadence enum + 0–6 dow + 0–23 hour) plus a computed "Next scheduled pull"
  preview line. The Entities Audit Pipeline panel shows an italic "Auto: ..."
  subtitle on each step describing its automatic trigger.
- The Trend Detail page (`/radar/trends/:id`) shows a "Signal Over Time" chart
  (`pages/radar/trends/trend-timeseries-chart.tsx`) — bars for absolute social
  mentions (left axis, summed across platforms/geographies from
  `tp_entity_timeseries`) and a line for Google search interest (right axis,
  0–100, max across keyword aliases from `tp_keyword_interest`). The header
  copy makes clear the two scales are not directly comparable
  (mentions = supply of conversation, interest = demand). Data comes from
  `GET /api/pipeline/companies/:id/trends/:trendId/timeseries?windowDays=N`,
  which resolves the trend's primary entity via `tp_entity_state` and uses
  `canonicalLabel + aliases` as the keyword set.
