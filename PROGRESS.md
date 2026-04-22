# Trend Pipeline — Build Progress

## 2026-04-22 — Initial implementation started

### PR 0 — Scaffolding
- **Status: completed**
- Monorepo already exists with Express 5, React 19, Drizzle ORM, TailwindCSS v4, Wouter routing
- Adaptations from spec:
  - Using Wouter instead of React Router v6
  - TailwindCSS v4 CSS-based config instead of tailwind.config.ts
  - pnpm workspaces (lib/db for schema, artifacts/api-server for backend, artifacts/app for frontend)

### PR 1 — Schema
- **Status: completed** (2026-04-22)
- All 15 tables in `lib/db/src/schema/index.ts` (692 lines): 4 supporting + 11 tp_* pipeline tables
- Supporting: companies, users, knowledgeItems (22 cols), knowledgeEvidence
- Pipeline: tpSeedCandidates, tpSeedItems, tpScoutQueries, tpActorRuns, tpRawSignals, tpEntities, tpSignalEntities, tpEntityTimeseries, tpEntityState, tpEntitySynonyms, tpPipelineConfig (all 28 config params + budget fields)
- All relations declared; all insert schemas + types exported
- Schema pushed to Neon PostgreSQL (drizzle-kit push succeeded)

### PR 2 — Radar setup bot
- **Status: completed** (2026-04-22)
- `artifacts/api-server/src/services/radar-setup-bot.ts` (267 lines)
- parseBriefToCompanyContext (gpt-4o-mini, temp 0.2, JSON retry up to 2x)
- computeTargetSeedCount (12–45 seeds based on brief richness formula)
- generateSeedItems (gpt-4o-mini, temp 0.4, full CompanyContext in system prompt)
- generateScoutQueriesForSeed (per-language keywords + hashtags generation)

### PR 3 — UI foundation
- **Status: completed** (2026-04-22)
- CSS theme fixed: all placeholder `red` values replaced with proper HSL colors (light + dark modes)
- Pipeline state tokens (candidate/emerging/confirmed/peaking/declining/dormant/resurgent) + platform tokens added
- AppLayout shell: collapsible left nav (w-60) + header breadcrumbs + scrollable main area
- Full routing in App.tsx: 7 radar routes + redirect + fallback (React.lazy + Suspense)

### PR 4 — Seeds + Queries audit UIs
- **Status: completed** (2026-04-22)
- Setup page: brief textarea, 500-char gate with live counter, loading/error states
- Seeds audit: candidate cards with approve/kill toggles, status chips, centrality badges, commit bar, sticky bottom bar
- Queries audit: grouped by topicLabel, keyword/hashtag chips, activate toggle, launch button
- Runs audit: table with platform/status badges, retry button, 15s auto-refresh
- Trends list: signal strength arc, state badges, WoW growth arrows, platform badges, click-through
- Trend detail: full detail view with evidence cards and [Open →] links to source URLs
- Control panel: 3-tier Accordion with auto-saving (500ms debounce) fields + author allowlist chip editor

### PR 5 — Actor dispatcher + webhook
- **Status: partially completed** (2026-04-22)
- Actor run records created per query × platform in `/scout-queries/launch` endpoint
- Platform selection logic: IG×2 (posts+reels), TikTok×1, Reddit×1-2, xhs (zh-CN only), GT (non-CN)
- Webhook receiver at `/api/pipeline/webhooks/apify` updates run status on completion
- Full 5-adapter normalisation + real Apify API integration: pending below

### Storage layer
- **Status: completed** (2026-04-22)
- `artifacts/api-server/src/storage/index.ts` (609 lines)
- All CRUD functions: companies, pipeline config (auto-create), seed candidates, seed items, scout queries, actor runs, raw signals, entities, synonyms, knowledge items + evidence
- Idiomatic Drizzle ORM usage with proper typing

### PR 5b — Full normalisation service (pending)
- `server/services/normalisation.ts` — per-adapter `normalise()` + language gate + commercial-intent classifier
- Full Apify actor `buildInputs()` for all 5 platforms per spec Sections 4.5.1–4.5.5
- `ingestActorRunItems()` full pipeline with engagement composite + author tier

### PR 6 — Entity extractor + canonicalisation (pending)
### PR 7 — Time-series + state-machine crons (pending)
### PR 8 — Synthesis + knowledgeItems (pending)

## ADR Log
- ADR-001 (2026-04-22): Using Wouter instead of React Router v6 (spec says React Router, but project uses Wouter). Wouter is already installed and matches the existing routing pattern.
- ADR-002 (2026-04-22): TailwindCSS v4 CSS-based config instead of tailwind.config.ts. Project uses @tailwindcss/vite with v4, which uses CSS @theme blocks instead of JS config files.
- ADR-003 (2026-04-22): Schema in single file lib/db/src/schema/index.ts (not split into per-model files). The spec's "split into files" guidance is for a larger project; single file is fine for this scale.
- ADR-004 (2026-04-22): Company ID hardcoded as 1 in standalone mode. The spec calls for a getOrCreateDefaultCompany() flow; the API auto-creates the default company on first request.
