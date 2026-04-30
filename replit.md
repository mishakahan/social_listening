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
