# Confirmation Gate + Clean Data Regeneration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regenerate clean trend history from a fresh scrape, then insert a confirmation gate between the growth state machine and the Radar so a candidate must pass a significance test (beats its own noise) and a source-breadth test (spread across authors/platforms) before it becomes a Radar knowledge item.

**Architecture:** Two phases. **Phase A** stands up a fresh Neon DB, runs the existing pipeline (`launchBatch` → Apify → `ingestActorRun` → `runEntityExtraction` → `runTimeseriesAggregation`) to populate `tp_entity_timeseries` with clean data, and snapshots it so backtests are reproducible. **Phase B** adds a pure, well-tested `confirmation-gate.ts` module (significance + source-breadth), wires it into `runStateMachine` right before `ensureKnowledgeItem` (state-machine.ts:274), persists a verdict, and backtests it against the Schedule B test set. The gate is **descriptive and reversible**: it only decides pass/hold for Radar surfacing; it never deletes data or alters upstream state.

**Tech Stack:** TypeScript (ESM, NodeNext), Express 5, Drizzle ORM over Neon Postgres, `apify-client`, `openai`, `pino`. Test runner: **node:test** + `tsx` (no test runner currently installed; Task 0 adds the minimal harness). Package manager: **pnpm** (enforced by preinstall hook).

## Global Constraints

- Package manager is **pnpm only** — the root `preinstall` hook hard-fails on npm/yarn. Every install/run command uses `pnpm`.
- All server code is **ESM with `.js` import specifiers** (NodeNext): import local files as `"./foo.js"` even though the source is `foo.ts`.
- The api-server reads `process.env` directly (no dotenv). Run anything that needs env with Node's native loader: `--env-file=<path-to>/.env`.
- **Never write to the Company's production DB from local.** All Phase A scraping targets a **fresh, separate Neon database** whose URL lives only in local `.env`. The production `helium` URL is not used.
- Secrets live in `.env` (gitignored). Never commit secrets, never log full key values.
- The confirmation gate is **additive and non-destructive**: it must not modify upstream pipeline tables, must not delete signals, and must be toggleable off via config so the system reverts to current behaviour.
- Platform history reality (Schedule A): TikTok / YouTube / Google Trends have real backfill; Reddit / Instagram are now-only. The significance backtest leans on sources with real depth.
- Acceptance bar (contract §1.2 / Schedule B): the gate runs, applies the significance and source-breadth tests, and produces **documented, backtested verdicts** on the agreed test set. An honest "hold" / "did not pass" verdict is a valid output — **no specific accuracy figure is required**.

---

## File Structure

**Phase A — data regeneration (mostly operational, scripted):**
- Create: `artifacts/api-server/src/scripts/regenerate-history.ts` — orchestrates flush → launch → poll → ingest → extract → aggregate against the fresh DB, with a `--dry-run` guard.
- Create: `artifacts/api-server/src/scripts/snapshot-timeseries.ts` — dumps `tp_entity_timeseries` (+ entities) to a versioned JSON/CSV under `artifacts/api-server/data-snapshots/` for reproducible backtests.
- Create: `docs/data-regeneration.md` — what was scraped, which actors/queries, date coverage per platform, known history limits.

**Phase B — the confirmation gate (the contract core):**
- Create: `artifacts/api-server/src/services/confirmation-gate.ts` — pure functions: `significanceTest`, `sourceBreadth`, `confirmationVerdict`. No DB, no I/O. This is where the math lives and where all unit tests point.
- Create: `artifacts/api-server/src/services/confirmation-gate.test.ts` — unit tests for the pure functions (synthetic series, no DB).
- Modify: `artifacts/api-server/src/services/state-machine.ts` — call the gate before `ensureKnowledgeItem` (line ~274); skip surfacing on "hold"; thread author/platform data into the gate.
- Modify: `lib/db/src/schema/index.ts` — add an optional `confirmationVerdict` JSON column to `tp_entity_states` (verdict + reasons), additive/nullable.
- Create: `artifacts/api-server/src/scripts/backtest-gate.ts` — runs the gate over the snapshot + Schedule B test set, prints a verdict table (confirmed-should-pass / noise-should-hold) and writes `docs/backtest-results.md`.
- Create: `artifacts/api-server/src/services/confirmation-gate.fixtures.ts` — small hand-built series used by both unit tests and the backtest harness (single-author spike, broad organic rise, flat noise).

---

## Task 0: Test harness + module skeleton

**Files:**
- Modify: `artifacts/api-server/package.json` (add `test` script + `tsx` is already a devDep)
- Create: `artifacts/api-server/src/services/confirmation-gate.ts`
- Test: `artifacts/api-server/src/services/confirmation-gate.test.ts`

**Interfaces:**
- Produces: `export type GateConfig`, and the three function stubs `significanceTest`, `sourceBreadth`, `confirmationVerdict` (signatures defined in later tasks). This task only proves the test runner works.

- [ ] **Step 1: Add a test script to the api-server package**

In `artifacts/api-server/package.json`, add to `"scripts"`:

```json
"test": "node --env-file=../../.env --import tsx --test \"src/**/*.test.ts\""
```

- [ ] **Step 2: Write a trivial failing test**

Create `artifacts/api-server/src/services/confirmation-gate.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceBreadth } from "./confirmation-gate.js";

test("module loads and sourceBreadth is callable", () => {
  assert.equal(typeof sourceBreadth, "function");
});
```

- [ ] **Step 3: Run it to verify it fails (module missing)**

Run: `cd artifacts/api-server && pnpm test`
Expected: FAIL — cannot find module `./confirmation-gate.js`.

- [ ] **Step 4: Create the skeleton module**

Create `artifacts/api-server/src/services/confirmation-gate.ts`:

```typescript
// Confirmation gate: pure, deterministic, no I/O.
// Decides whether a flagged candidate should surface to the Radar.

export interface GateConfig {
  significanceAlpha: number;   // e.g. 0.05
  permutations: number;        // e.g. 1000
  minSourceEntropyBits: number; // e.g. 1.0
  minUniqueAuthors: number;    // e.g. 3
  enabled: boolean;            // master toggle (revert behaviour)
}

export function sourceBreadth(): never {
  throw new Error("not implemented");
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd artifacts/api-server && pnpm test`
Expected: PASS — `typeof sourceBreadth === "function"`.

- [ ] **Step 6: Commit**

```bash
git add artifacts/api-server/package.json artifacts/api-server/src/services/confirmation-gate.ts artifacts/api-server/src/services/confirmation-gate.test.ts
git commit -m "chore: add node:test harness + confirmation-gate skeleton"
```

---

## Task 1: Source-breadth test (entropy + unique authors)

**Files:**
- Modify: `artifacts/api-server/src/services/confirmation-gate.ts`
- Test: `artifacts/api-server/src/services/confirmation-gate.test.ts`

**Interfaces:**
- Consumes: `GateConfig` from Task 0.
- Produces:
  ```typescript
  export interface SourceObservation { platform: string; uniqueAuthors: number; mentions: number; }
  export interface BreadthResult { entropyBits: number; totalAuthors: number; pass: boolean; reason: string; }
  export function sourceBreadth(obs: SourceObservation[], cfg: GateConfig): BreadthResult;
  ```
  Entropy is Shannon entropy (bits) over the distribution of `uniqueAuthors` across the `obs` rows. `pass = entropyBits >= cfg.minSourceEntropyBits && totalAuthors >= cfg.minUniqueAuthors`. This is the check that holds the "one coffee shop posts 10 times" case: a single dominant source yields ~0 bits.

- [ ] **Step 1: Write the failing tests**

Replace the body of `confirmation-gate.test.ts` with:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceBreadth, type GateConfig, type SourceObservation } from "./confirmation-gate.js";

const cfg: GateConfig = {
  significanceAlpha: 0.05, permutations: 1000,
  minSourceEntropyBits: 1.0, minUniqueAuthors: 3, enabled: true,
};

test("single dominant source -> low entropy -> hold", () => {
  const obs: SourceObservation[] = [
    { platform: "tiktok", uniqueAuthors: 1, mentions: 10 },
    { platform: "youtube", uniqueAuthors: 0, mentions: 0 },
  ];
  const r = sourceBreadth(obs, cfg);
  assert.ok(r.entropyBits < 0.5, `expected low entropy, got ${r.entropyBits}`);
  assert.equal(r.pass, false);
});

test("broad spread across authors/platforms -> high entropy -> pass", () => {
  const obs: SourceObservation[] = [
    { platform: "tiktok", uniqueAuthors: 8, mentions: 30 },
    { platform: "youtube", uniqueAuthors: 7, mentions: 25 },
    { platform: "googletrends", uniqueAuthors: 5, mentions: 12 },
  ];
  const r = sourceBreadth(obs, cfg);
  assert.ok(r.entropyBits >= 1.0, `expected high entropy, got ${r.entropyBits}`);
  assert.equal(r.pass, true);
});

test("empty observations -> hold, no crash", () => {
  const r = sourceBreadth([], cfg);
  assert.equal(r.pass, false);
  assert.equal(r.totalAuthors, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd artifacts/api-server && pnpm test`
Expected: FAIL — `sourceBreadth` throws "not implemented".

- [ ] **Step 3: Implement `sourceBreadth`**

In `confirmation-gate.ts`, replace the stub:

```typescript
export interface SourceObservation { platform: string; uniqueAuthors: number; mentions: number; }
export interface BreadthResult { entropyBits: number; totalAuthors: number; pass: boolean; reason: string; }

export function sourceBreadth(obs: SourceObservation[], cfg: GateConfig): BreadthResult {
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
```

- [ ] **Step 4: Run to verify pass**

Run: `cd artifacts/api-server && pnpm test`
Expected: PASS — all three tests green.

- [ ] **Step 5: Commit**

```bash
git add artifacts/api-server/src/services/confirmation-gate.ts artifacts/api-server/src/services/confirmation-gate.test.ts
git commit -m "feat: source-breadth test (entropy over authors/platforms)"
```

---

## Task 2: Significance test (permutation / shuffle null)

**Files:**
- Modify: `artifacts/api-server/src/services/confirmation-gate.ts`
- Test: `artifacts/api-server/src/services/confirmation-gate.test.ts`

**Interfaces:**
- Consumes: `GateConfig`.
- Produces:
  ```typescript
  export interface SignificanceResult { observedStat: number; pValue: number; pass: boolean; reason: string; }
  // dailyMentions: the entity's own daily series (chronological). rng optional for determinism.
  export function significanceTest(dailyMentions: number[], cfg: GateConfig, rng?: () => number): SignificanceResult;
  ```
  The statistic is the most-recent-7-day sum minus the mean 7-day sum over history. The null is built by shuffling the entity's *own* daily series `cfg.permutations` times and recomputing the statistic; `pValue` = fraction of shuffles with a statistic ≥ observed. `pass = pValue <= cfg.significanceAlpha`. This replaces "growth > fixed threshold" with "bigger than this entity's own noise."

- [ ] **Step 1: Write the failing tests**

Append to `confirmation-gate.test.ts`:

```typescript
import { significanceTest } from "./confirmation-gate.js";

// deterministic RNG (mulberry32) so tests are stable
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("flat noisy series -> not significant -> hold", () => {
  const flat = Array.from({ length: 60 }, (_, i) => 5 + (i % 2));
  const r = significanceTest(flat, cfg, seeded(1));
  assert.ok(r.pValue > 0.05, `expected high p, got ${r.pValue}`);
  assert.equal(r.pass, false);
});

test("clear recent spike -> significant -> pass", () => {
  const series = Array.from({ length: 60 }, () => 2);
  for (let i = 53; i < 60; i++) series[i] = 40; // sharp recent surge
  const r = significanceTest(series, cfg, seeded(1));
  assert.ok(r.pValue <= 0.05, `expected low p, got ${r.pValue}`);
  assert.equal(r.pass, true);
});

test("too little history -> hold, no crash", () => {
  const r = significanceTest([1, 2, 3], cfg, seeded(1));
  assert.equal(r.pass, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd artifacts/api-server && pnpm test`
Expected: FAIL — `significanceTest` is not exported.

- [ ] **Step 3: Implement `significanceTest`**

Append to `confirmation-gate.ts`:

```typescript
export interface SignificanceResult { observedStat: number; pValue: number; pass: boolean; reason: string; }

function last7Stat(series: number[]): number {
  const n = series.length;
  const recent = series.slice(n - 7).reduce((s, v) => s + v, 0);
  // mean 7-day sum across all complete 7-windows
  let windows = 0, total = 0;
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

export function significanceTest(
  dailyMentions: number[],
  cfg: GateConfig,
  rng: () => number = Math.random
): SignificanceResult {
  if (dailyMentions.length < 14) {
    return { observedStat: 0, pValue: 1, pass: false, reason: "insufficient history (<14d)" };
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
```

- [ ] **Step 4: Run to verify pass**

Run: `cd artifacts/api-server && pnpm test`
Expected: PASS — flat series holds, spike passes, short series holds.

- [ ] **Step 5: Commit**

```bash
git add artifacts/api-server/src/services/confirmation-gate.ts artifacts/api-server/src/services/confirmation-gate.test.ts
git commit -m "feat: significance test via permutation null on entity's own series"
```

---

## Task 3: Combined verdict

**Files:**
- Modify: `artifacts/api-server/src/services/confirmation-gate.ts`
- Test: `artifacts/api-server/src/services/confirmation-gate.test.ts`

**Interfaces:**
- Consumes: `significanceTest`, `sourceBreadth`, `GateConfig`.
- Produces:
  ```typescript
  export interface GateInput { dailyMentions: number[]; sources: SourceObservation[]; }
  export interface GateVerdict {
    decision: "pass" | "hold";
    significance: SignificanceResult;
    breadth: BreadthResult;
    reasons: string[];
  }
  export function confirmationVerdict(input: GateInput, cfg: GateConfig, rng?: () => number): GateVerdict;
  ```
  When `cfg.enabled === false`, decision is always `"pass"` with reason `"gate disabled"` (revert switch). Otherwise `decision = "pass"` only if **both** sub-tests pass.

- [ ] **Step 1: Write the failing tests**

Append to `confirmation-gate.test.ts`:

```typescript
import { confirmationVerdict } from "./confirmation-gate.js";

test("passes only when BOTH significance and breadth pass", () => {
  const spike = Array.from({ length: 60 }, () => 2);
  for (let i = 53; i < 60; i++) spike[i] = 40;
  const broad = [
    { platform: "tiktok", uniqueAuthors: 8, mentions: 30 },
    { platform: "youtube", uniqueAuthors: 7, mentions: 25 },
  ];
  const v = confirmationVerdict({ dailyMentions: spike, sources: broad }, cfg, seeded(1));
  assert.equal(v.decision, "pass");
});

test("significant but single-source -> hold", () => {
  const spike = Array.from({ length: 60 }, () => 2);
  for (let i = 53; i < 60; i++) spike[i] = 40;
  const narrow = [{ platform: "tiktok", uniqueAuthors: 1, mentions: 40 }];
  const v = confirmationVerdict({ dailyMentions: spike, sources: narrow }, cfg, seeded(1));
  assert.equal(v.decision, "hold");
});

test("disabled gate always passes", () => {
  const v = confirmationVerdict(
    { dailyMentions: [1,1,1], sources: [] },
    { ...cfg, enabled: false }, seeded(1)
  );
  assert.equal(v.decision, "pass");
  assert.ok(v.reasons.includes("gate disabled"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd artifacts/api-server && pnpm test`
Expected: FAIL — `confirmationVerdict` not exported.

- [ ] **Step 3: Implement `confirmationVerdict`**

Append to `confirmation-gate.ts`:

```typescript
export interface GateInput { dailyMentions: number[]; sources: SourceObservation[]; }
export interface GateVerdict {
  decision: "pass" | "hold";
  significance: SignificanceResult;
  breadth: BreadthResult;
  reasons: string[];
}

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
```

- [ ] **Step 4: Run to verify pass**

Run: `cd artifacts/api-server && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add artifacts/api-server/src/services/confirmation-gate.ts artifacts/api-server/src/services/confirmation-gate.test.ts
git commit -m "feat: combined confirmation verdict (significance AND breadth, with disable switch)"
```

---

## Task 4: Schema column for the verdict (additive, nullable)

**Files:**
- Modify: `lib/db/src/schema/index.ts` (the `tpEntityStates` table)
- Test: `artifacts/api-server/src/services/schema.test.ts` (new — asserts the column exists in the Drizzle object)

**Interfaces:**
- Produces: `tpEntityStates.confirmationVerdict` — a nullable `jsonb` column holding `{ decision, reasons, significanceP, entropyBits, evaluatedAt }`. Nullable + additive so existing rows and current behaviour are untouched.

- [ ] **Step 1: Locate the `tpEntityStates` table**

Run: `grep -n "tpEntityStates\|tp_entity_states" lib/db/src/schema/index.ts | head`
Expected: a `pgTable("tp_entity_states", { ... })` definition.

- [ ] **Step 2: Write the failing test**

Create `artifacts/api-server/src/services/schema.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { tpEntityStates } from "@workspace/db";

test("tp_entity_states has confirmationVerdict column", () => {
  assert.ok("confirmationVerdict" in tpEntityStates, "column missing");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd artifacts/api-server && pnpm test`
Expected: FAIL — `confirmationVerdict` not in table.

- [ ] **Step 4: Add the column**

In `lib/db/src/schema/index.ts`, inside the `tpEntityStates` columns object, add (ensure `jsonb` is imported from `drizzle-orm/pg-core`):

```typescript
  confirmationVerdict: jsonb("confirmation_verdict"),
```

- [ ] **Step 5: Run to verify pass**

Run: `cd artifacts/api-server && pnpm test`
Expected: PASS.

- [ ] **Step 6: Push the column to the fresh DB**

Run: `cd /Users/jjpardo/Documents/social_listening && pnpm --filter @workspace/db exec drizzle-kit push`
Expected: prompts/migrates and adds `confirmation_verdict` to the **fresh** DB (DATABASE_URL from local `.env`). If drizzle-kit is not configured, generate SQL and apply: `ALTER TABLE tp_entity_states ADD COLUMN confirmation_verdict jsonb;`

- [ ] **Step 7: Commit**

```bash
git add lib/db/src/schema/index.ts artifacts/api-server/src/services/schema.test.ts
git commit -m "feat: add nullable confirmation_verdict column to tp_entity_states"
```

---

## Task 5: Wire the gate into runStateMachine

**Files:**
- Modify: `artifacts/api-server/src/services/state-machine.ts` (around lines 222-276)
- Modify: `artifacts/api-server/src/services/confirmation-gate.ts` (add a config builder from `TpPipelineConfig`)
- Test: `artifacts/api-server/src/services/state-machine-gate.test.ts` (new — exercises the gate-application helper with synthetic rows)

**Interfaces:**
- Consumes: `confirmationVerdict`, `GateVerdict`, `GateConfig` (Task 3); `TpEntityTimeseries` rows already loaded in `runStateMachine`.
- Produces:
  ```typescript
  // pure helper, unit-testable without DB:
  export function gateConfigFromPipeline(config: TpPipelineConfig): GateConfig;
  export function buildGateInput(rows: TpEntityTimeseries[]): GateInput;
  ```
  `buildGateInput` collapses the per-(platform,geo,day) rows into a chronological daily mention series + per-platform `SourceObservation[]` (summing `uniqueAuthors` and `mentions` per platform over the window).

- [ ] **Step 1: Write the failing test for the helpers**

Create `artifacts/api-server/src/services/state-machine-gate.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGateInput } from "./confirmation-gate.js";
import type { TpEntityTimeseries } from "@workspace/db";

function row(date: string, platform: string, mentions: number, authors: number): TpEntityTimeseries {
  return {
    id: 0, companyId: 1, entityId: 1, platform, geography: "Global",
    territoryTag: null, bucketDate: date, mentions, uniqueAuthors: authors,
    engagementSum: 0, engagementMedian: 0, backfillDerived: false,
    computedAt: new Date(),
  } as TpEntityTimeseries;
}

test("buildGateInput produces chronological series + per-platform sources", () => {
  const rows = [
    row("2026-06-01", "tiktok", 5, 3),
    row("2026-06-02", "tiktok", 7, 4),
    row("2026-06-02", "youtube", 2, 2),
  ];
  const input = buildGateInput(rows);
  assert.deepEqual(input.dailyMentions, [5, 9]); // 2026-06-02 sums 7+2
  const tiktok = input.sources.find(s => s.platform === "tiktok")!;
  assert.equal(tiktok.uniqueAuthors, 7);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd artifacts/api-server && pnpm test`
Expected: FAIL — `buildGateInput` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `confirmation-gate.ts`:

```typescript
import type { TpEntityTimeseries, TpPipelineConfig } from "@workspace/db";

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
    ([platform, v]) => ({ platform, uniqueAuthors: v.authors, mentions: v.mentions })
  );
  return { dailyMentions, sources };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd artifacts/api-server && pnpm test`
Expected: PASS.

- [ ] **Step 5: Apply the gate in `runStateMachine`**

In `state-machine.ts`, add imports at the top:

```typescript
import { confirmationVerdict, buildGateInput, gateConfigFromPipeline } from "./confirmation-gate.js";
```

Then in `runStateMachine`, replace the single line `await ensureKnowledgeItem(...)` (currently line ~274) with:

```typescript
      const gateCfg = gateConfigFromPipeline(config);
      const surfacingStates = ["emerging", "confirmed", "peaking", "resurgent"];
      let verdict = null as ReturnType<typeof confirmationVerdict> | null;
      if (surfacingStates.includes(nextState)) {
        verdict = confirmationVerdict(buildGateInput(rows), gateCfg);
        await storage.updateEntityState(entityState.id, {
          confirmationVerdict: {
            decision: verdict.decision,
            reasons: verdict.reasons,
            significanceP: verdict.significance.pValue,
            entropyBits: verdict.breadth.entropyBits,
            evaluatedAt: new Date().toISOString(),
          },
        } as any);
      }

      if (!verdict || verdict.decision === "pass") {
        await ensureKnowledgeItem(companyId, entityState.id, updated, metrics, config.radarSurfaceMinSignalStrength);
      } else {
        logger.info(
          { entityId: entity.id, label: entity.canonicalLabel, geography, reasons: verdict.reasons },
          "Confirmation gate HOLD — not surfacing to radar"
        );
      }
      processed++;
```

(Remove the old standalone `await ensureKnowledgeItem(...)` and the old `processed++;` so they are not duplicated.)

- [ ] **Step 6: Typecheck the server**

Run: `cd /Users/jjpardo/Documents/social_listening && pnpm --filter @workspace/api-server run typecheck`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add artifacts/api-server/src/services/confirmation-gate.ts artifacts/api-server/src/services/state-machine.ts artifacts/api-server/src/services/state-machine-gate.test.ts
git commit -m "feat: apply confirmation gate before radar surfacing in runStateMachine"
```

---

## Task 6: Backtest harness against the Schedule B test set

**Files:**
- Create: `artifacts/api-server/src/services/confirmation-gate.fixtures.ts`
- Create: `artifacts/api-server/src/scripts/backtest-gate.ts`
- Create: `docs/backtest-results.md` (generated output, committed)

**Interfaces:**
- Consumes: `confirmationVerdict`, `GateConfig`, `GateInput`.
- Produces: a CLI that loads (a) labelled fixtures and (b) optionally a timeseries snapshot, runs the gate, and prints a table: for each labelled case, expected (`should-pass` / `should-hold`) vs actual, plus a summary count. Writes the same to `docs/backtest-results.md`. **No accuracy threshold is enforced** — the deliverable is the documented verdict table (contract §1.2).

- [ ] **Step 1: Create labelled fixtures**

Create `artifacts/api-server/src/services/confirmation-gate.fixtures.ts`:

```typescript
import type { GateInput } from "./confirmation-gate.js";

export interface LabelledCase {
  name: string;
  expected: "pass" | "hold";
  input: GateInput;
  note: string;
}

const flat60 = Array.from({ length: 60 }, (_, i) => 4 + (i % 2));
const spike60 = (() => {
  const s = Array.from({ length: 60 }, () => 2);
  for (let i = 53; i < 60; i++) s[i] = 40;
  return s;
})();

export const fixtures: LabelledCase[] = [
  {
    name: "single-author-spike",
    expected: "hold",
    input: { dailyMentions: spike60, sources: [{ platform: "tiktok", uniqueAuthors: 1, mentions: 40 }] },
    note: "coffee-shop case: real surge but one account",
  },
  {
    name: "broad-organic-rise",
    expected: "pass",
    input: { dailyMentions: spike60, sources: [
      { platform: "tiktok", uniqueAuthors: 9, mentions: 30 },
      { platform: "youtube", uniqueAuthors: 7, mentions: 22 },
      { platform: "googletrends", uniqueAuthors: 5, mentions: 10 },
    ] },
    note: "real broad trend across sources",
  },
  {
    name: "flat-noise",
    expected: "hold",
    input: { dailyMentions: flat60, sources: [
      { platform: "tiktok", uniqueAuthors: 6, mentions: 20 },
      { platform: "youtube", uniqueAuthors: 5, mentions: 18 },
    ] },
    note: "broad but no real movement",
  },
];
```

- [ ] **Step 2: Create the backtest script**

Create `artifacts/api-server/src/scripts/backtest-gate.ts`:

```typescript
import { writeFileSync } from "node:fs";
import { confirmationVerdict, type GateConfig } from "../services/confirmation-gate.js";
import { fixtures } from "../services/confirmation-gate.fixtures.js";

const cfg: GateConfig = {
  significanceAlpha: 0.05, permutations: 1000,
  minSourceEntropyBits: 1.0, minUniqueAuthors: 3, enabled: true,
};

const lines: string[] = ["# Backtest Results", "", "| case | expected | actual | match | reasons |", "|---|---|---|---|---|"];
let matches = 0;
for (const f of fixtures) {
  const v = confirmationVerdict(f.input, cfg);
  const ok = v.decision === f.expected;
  if (ok) matches++;
  lines.push(`| ${f.name} | ${f.expected} | ${v.decision} | ${ok ? "✅" : "❌"} | ${v.reasons.join("; ")} |`);
}
lines.push("", `**${matches}/${fixtures.length} labelled cases matched expectation.**`);
lines.push("", "_Verdicts are honest descriptive outputs; no accuracy threshold is contractually required._");
const out = lines.join("\n");
console.log(out);
writeFileSync("docs/backtest-results.md", out + "\n");
```

- [ ] **Step 3: Run the backtest**

Run: `cd /Users/jjpardo/Documents/social_listening && pnpm --filter @workspace/api-server exec tsx src/scripts/backtest-gate.ts`
Expected: prints the table; the three fixtures match (hold/pass/hold); writes `docs/backtest-results.md`.

- [ ] **Step 4: Commit**

```bash
git add artifacts/api-server/src/services/confirmation-gate.fixtures.ts artifacts/api-server/src/scripts/backtest-gate.ts docs/backtest-results.md
git commit -m "feat: confirmation-gate backtest harness + labelled fixtures"
```

---

## Task 7 (Phase A): Clean data regeneration script

> Run this once the **fresh Neon DB URL** is in local `.env` and the schema is pushed. This is operational; it calls the existing pipeline endpoints rather than reimplementing them. Keep a `--dry-run` default so it never fires paid Apify runs by accident.

**Files:**
- Create: `artifacts/api-server/src/scripts/regenerate-history.ts`
- Create: `docs/data-regeneration.md`

**Interfaces:**
- Consumes (existing endpoints on the running api-server): `POST /api/pipeline/companies/:id/flush-data`, `POST /api/pipeline/companies/:id/scout-queries/launch`, `GET /api/pipeline/companies/:id/run-status`, `POST /api/pipeline/companies/:id/run-entity-extraction`, `POST /api/pipeline/companies/:id/run-timeseries`, `POST /api/pipeline/companies/:id/run-state-machine`.
- Produces: a documented, ordered regeneration run + `docs/data-regeneration.md` recording actors, queries, and per-platform date coverage.

- [ ] **Step 1: Confirm the fresh DB + booted server**

Run: `cd /Users/jjpardo/Documents/social_listening && pnpm --filter @workspace/api-server exec tsx --env-file=../../.env src/index.ts`
Expected: server boots, logs `Starting server` on the configured port, connects to the **fresh** DB (no `helium`).

- [ ] **Step 2: Write the orchestration script (dry-run default)**

Create `artifacts/api-server/src/scripts/regenerate-history.ts`:

```typescript
const BASE = process.env.SERVER_URL ?? "http://localhost:8080";
const COMPANY_ID = Number(process.env.REGEN_COMPANY_ID ?? "1");
const DRY = process.argv.includes("--execute") ? false : true;

async function post(path: string, body?: unknown) {
  if (DRY) { console.log(`[dry-run] POST ${path}`, body ?? ""); return; }
  const res = await fetch(`${BASE}/api/pipeline${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  console.log(`POST ${path} ok`);
  return res.json().catch(() => ({}));
}

async function main() {
  console.log(DRY ? "DRY RUN (pass --execute to run for real)" : "EXECUTING regeneration");
  await post(`/companies/${COMPANY_ID}/flush-data`, { confirm: true });
  await post(`/companies/${COMPANY_ID}/scout-queries/launch`, {});
  console.log("Apify runs launched; webhooks will ingest as runs complete.");
  console.log("After ingestion settles, run extraction → timeseries → state-machine:");
  await post(`/companies/${COMPANY_ID}/run-entity-extraction`, {});
  await post(`/companies/${COMPANY_ID}/run-timeseries`, {});
  await post(`/companies/${COMPANY_ID}/run-state-machine`, {});
  console.log("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Dry-run it**

Run: `cd /Users/jjpardo/Documents/social_listening && pnpm --filter @workspace/api-server exec tsx src/scripts/regenerate-history.ts`
Expected: prints the ordered `[dry-run] POST ...` steps, fires nothing.

- [ ] **Step 4: Execute for real (spends Apify credits on the Company's token)**

Run: `... tsx src/scripts/regenerate-history.ts --execute`
Expected: flush → launch → (wait for webhooks) → extraction/timeseries/state-machine. Verify rows land via `GET /api/pipeline/companies/1/entities` and `/entity-states`.

- [ ] **Step 5: Document coverage**

Create `docs/data-regeneration.md` recording: which scout queries/actors ran, date span returned per platform (note TikTok/YouTube/GoogleTrends depth vs Reddit/Instagram now-only), row counts in `tp_entity_timeseries`.

- [ ] **Step 6: Commit**

```bash
git add artifacts/api-server/src/scripts/regenerate-history.ts docs/data-regeneration.md
git commit -m "feat: clean-history regeneration script (dry-run safe) + coverage doc"
```

---

## Task 8 (Phase A): Snapshot for reproducible backtests

**Files:**
- Create: `artifacts/api-server/src/scripts/snapshot-timeseries.ts`
- Create: `artifacts/api-server/data-snapshots/.gitkeep`

**Interfaces:**
- Consumes: the fresh DB via `storage.getEntityTimeseriesByCompany` (existing, storage/index.ts:1625).
- Produces: `artifacts/api-server/data-snapshots/timeseries-<YYYY-MM-DD>.json` used to feed `backtest-gate.ts` with real data instead of only fixtures.

- [ ] **Step 1: Write the snapshot script**

Create `artifacts/api-server/src/scripts/snapshot-timeseries.ts`:

```typescript
import { writeFileSync, mkdirSync } from "node:fs";
import * as storage from "../storage/index.js";

async function main() {
  const companyId = Number(process.env.REGEN_COMPANY_ID ?? "1");
  const rows = await storage.getEntityTimeseriesByCompany(companyId);
  mkdirSync("artifacts/api-server/data-snapshots", { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = `artifacts/api-server/data-snapshots/timeseries-${date}.json`;
  writeFileSync(path, JSON.stringify(rows, null, 2));
  console.log(`Wrote ${rows.length} rows -> ${path}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it against the fresh DB**

Run: `cd /Users/jjpardo/Documents/social_listening && pnpm --filter @workspace/api-server exec tsx --env-file=../../.env src/scripts/snapshot-timeseries.ts`
Expected: writes a dated snapshot JSON, prints row count.

- [ ] **Step 3: Commit (script + .gitkeep, not large snapshots)**

```bash
echo "*.json" > artifacts/api-server/data-snapshots/.gitignore
echo "!.gitkeep" >> artifacts/api-server/data-snapshots/.gitignore
touch artifacts/api-server/data-snapshots/.gitkeep
git add artifacts/api-server/src/scripts/snapshot-timeseries.ts artifacts/api-server/data-snapshots/.gitkeep artifacts/api-server/data-snapshots/.gitignore
git commit -m "feat: timeseries snapshot script for reproducible backtests"
```

---

## Self-Review

**Spec coverage:**
- Significance test (beats own noise) → Task 2 ✅
- Source-breadth / diversity (authors + platforms) → Task 1 ✅
- Gate inserts between state machine and Radar → Task 5 (before `ensureKnowledgeItem`, state-machine.ts:274) ✅
- Backtest against test set incl. Schedule B framing → Task 6 ✅
- Clean data regeneration from scratch (Jonathan's directive) → Task 7 ✅
- Reproducible backtest data → Task 8 ✅
- Acceptance = documented honest verdicts, no accuracy bar → Task 6 output statement ✅
- Non-destructive / revertible → `enabled` switch (Task 3), additive nullable column (Task 4) ✅
- Cross-source corroboration + specificity → **intentionally deferred** (contract: best-effort within term). Not in this plan; would be Tasks 9-10 in a follow-up.

**Placeholder scan:** No TBD/TODO; every code step has full code. ✅

**Type consistency:** `GateConfig`, `SourceObservation`, `BreadthResult`, `SignificanceResult`, `GateInput`, `GateVerdict` are defined once (Tasks 0-3) and reused with identical names in Tasks 5-8. `confirmationVerdict`, `sourceBreadth`, `significanceTest`, `buildGateInput`, `gateConfigFromPipeline` signatures are stable across tasks. ✅

**Open risks (flag to Jonathan/Asad, not blockers):**
1. The significance test needs ≥14 days of history per entity; the pipeline's rolling 90-day window (per Asad) is enough, but freshly-scraped Reddit/Instagram will start thin — backtest leans on TikTok/YouTube/GoogleTrends.
2. Gate config keys (`gateEnabled`, etc.) are read defensively from `TpPipelineConfig` with defaults; if you want them editable from the control panel, they must be added to the config schema (small follow-up).
3. `drizzle-kit push` (Task 4) must target the **fresh** DB; double-check `DATABASE_URL` before running.
