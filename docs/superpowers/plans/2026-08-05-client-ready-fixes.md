# Client-Ready Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the radar demonstrably client-showable: it discovers instead of confirming guesses, Jonathan can run it himself, and nothing on screen looks unfinished.

**Architecture:** Seven independent fixes against the existing pipeline. Six are surgical (prompt, query filter, state vocabulary, a new pure filter, a computed badge, a schema column). The seventh chains the five existing per-stage endpoints behind one orchestrator so a non-engineer can trigger a full run. No new services, no new infrastructure.

**Tech Stack:** TypeScript, Express, Drizzle ORM + Neon Postgres, React/Vite, `node:test` + `node:assert/strict`, pnpm monorepo.

## Global Constraints

- Repo: `/Users/jjpardo/Documents/social_listening`. Branch: `feat/confirmation-gate`.
- Every command needs `--env-file` — there is no dotenv in code.
- Test runner: `node --test` via tsx. From `artifacts/api-server`: `pnpm test`.
- Single test file: `pnpm exec node --env-file=../../.env --import tsx --test src/services/<name>.test.ts`
- Typecheck: `pnpm --filter @workspace/api-server run typecheck`
- Imports use the `.js` extension even for `.ts` sources (ESM).
- Schema changes are applied with `cd lib/db && pnpm push` (drizzle-kit push, no migration files).
- **One process on the DB at a time.** Do not run probe scripts against a live state-machine run — the probes starve the connection pool and become the slowdown you are measuring.
- **Never re-scrape `BENCH:*` queries** (34 of them) — they are the Schedule B fixture.
- Apify spend: the DB `cost_usd` column undercounts real billing by ~4x. Trust the Apify console, not the DB.

---

### Task 1: Align the evidence window

The Trends list shows `Evidence: 4` (which is `volume30d`) while the drill-down lists every signal ever linked to the entity, capped at 20. Both numbers are correct but they measure different windows, so the UI reads as self-contradictory. Jonathan flagged this directly.

**Resolve by labelling, not by narrowing.** The obvious fix — filtering the drill-down to 30 days — removes the contradiction but makes the evidence look thinner (click "4" and see 4 items instead of 10). That is the wrong direction for a demo. Instead, name both numbers explicitly: the column becomes `Evidence (30d)`, and the drill-down reports the full count alongside the recent one. Same contradiction gone, more evidence visible, nothing overstated.

**Files:**
- Create: `artifacts/api-server/src/services/evidence-window.ts`
- Test: `artifacts/api-server/src/services/evidence-window.test.ts`
- Modify: `artifacts/api-server/src/storage/index.ts` (the evidence query inside `getTrendDetail`, ~line 1969)

**Interfaces:**
- Produces: `EVIDENCE_WINDOW_DAYS: number`, `evidenceCutoff(now: Date, windowDays: number): Date`

- [ ] **Step 1: Write the failing test**

```typescript
// artifacts/api-server/src/services/evidence-window.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceCutoff, EVIDENCE_WINDOW_DAYS } from "./evidence-window.js";

test("cutoff is windowDays before now", () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  assert.equal(
    evidenceCutoff(now, 30).toISOString(),
    "2026-07-06T00:00:00.000Z"
  );
});

test("a zero window returns now unchanged", () => {
  const now = new Date("2026-08-05T00:00:00.000Z");
  assert.equal(evidenceCutoff(now, 0).toISOString(), now.toISOString());
});

test("the exported default matches the Evidence column (volume30d)", () => {
  assert.equal(EVIDENCE_WINDOW_DAYS, 30);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/evidence-window.test.ts`
Expected: FAIL — cannot find module `./evidence-window.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// artifacts/api-server/src/services/evidence-window.ts
// The Trends list "Evidence" column is volume30d. The drill-down must use the
// same window or the two numbers disagree on screen for the same trend.
export const EVIDENCE_WINDOW_DAYS = 30;

export function evidenceCutoff(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/evidence-window.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Report both counts from the detail endpoint**

In `artifacts/api-server/src/storage/index.ts`, add the import at the top of the file:

```typescript
import { evidenceCutoff, EVIDENCE_WINDOW_DAYS } from "../services/evidence-window.js";
```

Leave the existing evidence query alone — it should keep returning the full history, capped at 20. Instead, count how many of those rows fall inside the window, and return it alongside. After the `evidence` array is built in `getTrendDetail`, add:

```typescript
  const recentCutoff = evidenceCutoff(new Date(), EVIDENCE_WINDOW_DAYS);
  const evidenceRecentCount = evidenceRows.filter(
    (r) => r.sig.capturedAt != null && r.sig.capturedAt >= recentCutoff
  ).length;
```

Add `evidenceRecentCount: number;` and `evidenceWindowDays: number;` to the trend-detail return type, and include both in the returned object:

```typescript
    evidenceRecentCount,
    evidenceWindowDays: EVIDENCE_WINDOW_DAYS,
```

- [ ] **Step 6: Label both numbers in the UI**

In `artifacts/app/src/pages/radar/trends/list.tsx`, change the column header from `Evidence` to `Evidence (30d)` so the number is self-describing.

In `artifacts/app/src/pages/radar/trends/detail.tsx`, label the evidence section so the two counts read as complementary rather than contradictory:

```tsx
<h3 className="text-sm font-medium">
  Evidence
  <span className="ml-2 font-normal text-muted-foreground">
    {trend.evidenceRecentCount} in the last {trend.evidenceWindowDays} days
    {trend.evidence.length > trend.evidenceRecentCount &&
      `, ${trend.evidence.length} all time`}
  </span>
</h3>
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @workspace/api-server run typecheck`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add artifacts/api-server/src/services/evidence-window.ts \
        artifacts/api-server/src/services/evidence-window.test.ts \
        artifacts/api-server/src/storage/index.ts \
        artifacts/app/src/pages/radar/trends/list.tsx \
        artifacts/app/src/pages/radar/trends/detail.tsx
git commit -m "fix: label the evidence window instead of hiding older signals"
```

---

### Task 2: Rename the `confirmed` state to `sustained`

The state machine has a state called `confirmed` (3+ weeks of upward trend) while the gate produces a *confirmation verdict*. Two different things, same word — Jonathan asked whether they were even the same concept. Renaming the state removes the collision. The gate verdict keeps its name because it is the contracted deliverable.

**Files:**
- Modify: `artifacts/api-server/src/services/state-machine.ts` (the `TrendState` union at ~line 18-24, and every `"confirmed"` literal)
- Test: `artifacts/api-server/src/services/state-machine-states.test.ts` (create)
- Create: `artifacts/api-server/src/scripts/rename-confirmed-state.ts`
- Modify: `artifacts/app/src/pages/radar/trends/list.tsx` (state badge label/colour map)

**Interfaces:**
- Consumes: `determineNextState(current: TrendState, metrics: Metrics, config: TpPipelineConfig): { state: TrendState; reason: string }` — currently module-private, must be exported by this task.
- Produces: `TrendState` union with `"sustained"` replacing `"confirmed"`.

- [ ] **Step 1: Export the function under test**

In `artifacts/api-server/src/services/state-machine.ts`, change the declaration at ~line 108 from `function determineNextState(` to `export function determineNextState(`. Also export the `Metrics` interface (`export interface Metrics {`) so tests can construct one.

- [ ] **Step 2: Write the failing test**

```typescript
// artifacts/api-server/src/services/state-machine-states.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { determineNextState, type Metrics } from "./state-machine.js";
import type { TpPipelineConfig } from "@workspace/db/schema";

function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    volume7d: 20,
    volume30d: 60,
    volume90d: 120,
    velocity: 20 / 7,
    growthWow: 0.9,
    growthMom: 0.9,
    volatility: 1,
    ...over,
  };
}

const config = {
  candidateToEmergingMinWowGrowth: 0.3,
  candidateToEmergingMinVolume: 9,
} as unknown as TpPipelineConfig;

test("the state vocabulary no longer contains 'confirmed'", () => {
  const states = new Set<string>();
  for (const current of ["candidate", "emerging", "sustained", "peaking"] as const) {
    states.add(determineNextState(current, metrics(), config).state);
    states.add(determineNextState(current, metrics({ growthWow: -0.9, growthMom: -0.9 }), config).state);
    states.add(determineNextState(current, metrics({ volume7d: 0, volume30d: 0 }), config).state);
  }
  assert.equal(states.has("confirmed"), false);
});

test("a strongly rising entity promotes past emerging without using the old name", () => {
  const r = determineNextState("emerging", metrics(), config);
  assert.notEqual(r.state, "confirmed");
  assert.ok(typeof r.reason === "string" && r.reason.length > 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/state-machine-states.test.ts`
Expected: FAIL — `"confirmed"` is still produced, and/or `"sustained"` is not assignable to `TrendState`

- [ ] **Step 4: Rename in the state machine**

In `artifacts/api-server/src/services/state-machine.ts`, update the union:

```typescript
  | "candidate"   // seen < 3 times
  | "emerging"    // consistent growth, not yet sustained
  | "sustained"   // 3+ weeks of upward trend
  | "peaking"     // growth rate decelerating
  | "declining"   // week-over-week volume falling
  | "dormant"     // near-zero activity
  | "resurgent";  // dormant → positive growth again
```

Then replace every remaining `"confirmed"` string literal in this file with `"sustained"`. Verify none remain:

```bash
grep -n '"confirmed"' artifacts/api-server/src/services/state-machine.ts
```

Expected: no output.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/state-machine-states.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Migrate existing rows**

```typescript
// artifacts/api-server/src/scripts/rename-confirmed-state.ts
// One-shot: existing tp_entity_state rows still carry state='confirmed'.
// Run once after the rename lands, then this script is dead weight.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const dryRun = !process.argv.includes("--apply");

async function main() {
  const before = await db.execute(
    sql`select count(*)::int as n from tp_entity_state where state = 'confirmed'`
  );
  const n = (before.rows[0] as { n: number }).n;
  console.log(`rows with state='confirmed': ${n}`);

  if (dryRun) {
    console.log("dry run — pass --apply to write");
    return;
  }

  await db.execute(
    sql`update tp_entity_state set state = 'sustained' where state = 'confirmed'`
  );
  const after = await db.execute(
    sql`select count(*)::int as n from tp_entity_state where state = 'confirmed'`
  );
  console.log(`remaining after update: ${(after.rows[0] as { n: number }).n}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Run the dry run first, then apply:

```bash
cd artifacts/api-server
pnpm exec tsx --env-file=../../.env src/scripts/rename-confirmed-state.ts
pnpm exec tsx --env-file=../../.env src/scripts/rename-confirmed-state.ts --apply
```

Expected: the second run reports `remaining after update: 0`.

- [ ] **Step 7: Update the frontend badge**

In `artifacts/app/src/pages/radar/trends/list.tsx`, find the state badge mapping (the object or switch that maps a state string to a label and colour) and rename the `confirmed` key to `sustained`, with the display label `Sustained`. Keep the existing colour so the visual language is unchanged.

Confirm nothing else in the app still references the old value:

```bash
grep -rn '"confirmed"\|>Confirmed<' artifacts/app/src
```

Expected: no output.

- [ ] **Step 8: Typecheck both packages**

```bash
pnpm --filter @workspace/api-server run typecheck
cd artifacts/app && pnpm exec tsc --noEmit
```

Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add artifacts/api-server/src/services/state-machine.ts \
        artifacts/api-server/src/services/state-machine-states.test.ts \
        artifacts/api-server/src/scripts/rename-confirmed-state.ts \
        artifacts/app/src/pages/radar/trends/list.tsx
git commit -m "refactor: rename state 'confirmed' to 'sustained' to free the word for the gate"
```

---

### Task 3: Well-formedness filter (drop the junk entries)

`handmade`, `brunch`, `graduation` and `non-alcoholic` currently pass the gate. They are neither everyday-generic nor category staples, so the two-axis specificity check correctly lets them through — they fail on a *third* axis: they are not well-formed product nouns. `non-alcoholic` is a dangling modifier (the real trend is "non-alcoholic beer"), and `brunch`/`graduation` are occasions.

This is a pure, deterministic filter — no LLM call, so it costs nothing and cannot regress the specificity evals.

**Dangling modifiers get merged, not deleted.** `non-alcoholic` carries 26 mentions and `non-alcoholic beer` already exists separately on the same radar — the evidence is split, not junk. Simply hiding the modifier makes the screen cleaner while leaving the split in place. Where a compound parent exists, fold the modifier into it so the volume consolidates. Drop it only when nothing on the radar extends it.

**Files:**
- Create: `artifacts/api-server/src/services/well-formedness.ts`
- Test: `artifacts/api-server/src/services/well-formedness.test.ts`
- Modify: `artifacts/api-server/src/services/state-machine.ts` (apply alongside the existing specificity veto, ~line 376)

**Interfaces:**
- Produces: `isWellFormed(label: string): { wellFormed: boolean; reason: string }`, `findCompoundParent(label: string, candidates: string[]): string | null`

- [ ] **Step 1: Write the failing test**

```typescript
// artifacts/api-server/src/services/well-formedness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWellFormed } from "./well-formedness.js";

test("keeps real product nouns", () => {
  for (const label of ["yuzu", "creatine", "medjool dates", "non-alcoholic beer", "frango desfiado"]) {
    assert.equal(isWellFormed(label).wellFormed, true, `${label} should be kept`);
  }
});

test("drops dangling modifiers", () => {
  for (const label of ["non-alcoholic", "sugar-free", "gluten-free", "handmade"]) {
    assert.equal(isWellFormed(label).wellFormed, false, `${label} should be dropped`);
  }
});

test("drops occasion and claim words", () => {
  for (const label of ["brunch", "graduation", "birthday", "christmas"]) {
    assert.equal(isWellFormed(label).wellFormed, false, `${label} should be dropped`);
  }
});

test("a compound built on a modifier is still well-formed", () => {
  assert.equal(isWellFormed("sugar-free chocolate").wellFormed, true);
  assert.equal(isWellFormed("brunch sandwich").wellFormed, true);
});

test("gives a human-readable reason when it drops something", () => {
  const r = isWellFormed("non-alcoholic");
  assert.equal(r.wellFormed, false);
  assert.ok(r.reason.length > 0);
});

test("finds the compound the modifier belongs to", () => {
  const labels = ["non-alcoholic beer", "creatine", "yuzu"];
  assert.equal(findCompoundParent("non-alcoholic", labels), "non-alcoholic beer");
});

test("prefers the shortest compound when several extend the modifier", () => {
  const labels = ["sugar-free chocolate bar", "sugar-free chocolate"];
  assert.equal(findCompoundParent("sugar-free", labels), "sugar-free chocolate");
});

test("returns null when nothing extends the modifier", () => {
  assert.equal(findCompoundParent("handmade", ["creatine", "yuzu"]), null);
});

test("does not treat an unrelated prefix match as a parent", () => {
  assert.equal(findCompoundParent("brunch", ["brunchette"]), null);
});
```

Update the import line at the top of this test file to:

```typescript
import { isWellFormed, findCompoundParent } from "./well-formedness.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/well-formedness.test.ts`
Expected: FAIL — cannot find module `./well-formedness.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// artifacts/api-server/src/services/well-formedness.ts
// A THIRD quality axis, distinct from specificity. Specificity asks "is this
// term too broad to be interesting?". This asks "is this term even a thing?".
//
// The failures it catches, seen on real radars:
//   - dangling modifiers: "non-alcoholic" (the trend is non-alcoholic BEER),
//     "sugar-free", "handmade"
//   - occasions and claims: "brunch", "graduation"
// Both are grammatically fine and genuinely rising; neither is a product a
// client can act on.
//
// Deliberately a closed word list rather than an LLM call: it is deterministic,
// free, and cannot regress the specificity evals. A modifier is only rejected
// when it stands ALONE — "sugar-free chocolate" is a real trend.

const STANDALONE_MODIFIERS = new Set([
  "non-alcoholic", "nonalcoholic", "alcohol-free",
  "sugar-free", "sugarfree", "gluten-free", "glutenfree",
  "dairy-free", "fat-free", "low-carb", "low-fat", "high-protein",
  "handmade", "handcrafted", "homemade", "artisanal", "organic",
  "vegan", "vegetarian", "natural", "premium", "authentic",
]);

const OCCASIONS = new Set([
  "brunch", "breakfast", "lunch", "dinner", "snack", "dessert",
  "graduation", "birthday", "wedding", "christmas", "easter",
  "halloween", "thanksgiving", "party", "picnic", "holiday",
]);

export function isWellFormed(label: string): { wellFormed: boolean; reason: string } {
  const norm = label.trim().toLowerCase();

  if (!norm) return { wellFormed: false, reason: "empty label" };

  // Multi-word labels are compounds and are allowed through: the modifier or
  // occasion is qualifying a real noun ("sugar-free chocolate", "brunch
  // sandwich"), which is exactly the well-formed case.
  if (norm.includes(" ")) return { wellFormed: true, reason: "compound noun phrase" };

  if (STANDALONE_MODIFIERS.has(norm)) {
    return {
      wellFormed: false,
      reason: `"${norm}" is a modifier with nothing to modify — the trend is whatever it describes`,
    };
  }

  if (OCCASIONS.has(norm)) {
    return {
      wellFormed: false,
      reason: `"${norm}" is an occasion, not a product`,
    };
  }

  return { wellFormed: true, reason: "well-formed" };
}

// A dangling modifier is usually a SPLIT, not junk: "non-alcoholic" (26 mentions)
// and "non-alcoholic beer" (39) are the same conversation counted twice. Where a
// compound extends the modifier, the modifier's evidence belongs to it. Shortest
// match wins, so "sugar-free" folds into "sugar-free chocolate" rather than
// "sugar-free chocolate bar". Requires a word boundary so "brunch" does not
// capture "brunchette".
export function findCompoundParent(
  label: string,
  candidates: string[]
): string | null {
  const mod = label.trim().toLowerCase();
  if (!mod || mod.includes(" ")) return null;

  const matches = candidates
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== mod && c.startsWith(mod + " "))
    .sort((a, b) => a.length - b.length);

  return matches[0] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/well-formedness.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Wire it into the gate veto**

In `artifacts/api-server/src/services/state-machine.ts`, add the import:

```typescript
import { isWellFormed } from "./well-formedness.js";
```

Then, immediately **before** the existing specificity veto block (the one reading `if (verdict.decision === "pass" && specificity && !specificity.specific)`), insert:

```typescript
        const wellFormed = isWellFormed(entity.canonicalLabel);
        if (verdict.decision === "pass" && !wellFormed.wellFormed) {
          finalDecision = "hold";
          verdict.reasons.push(`not well-formed: ${wellFormed.reason}`);
        }
```

This runs before the LLM specificity call, so malformed labels never incur an OpenAI request.

- [ ] **Step 6: Fold split modifiers into their compound parent**

```typescript
// artifacts/api-server/src/scripts/merge-dangling-modifiers.ts
// One-shot repair for evidence already split across a modifier and its compound
// ("non-alcoholic" 26 mentions vs "non-alcoholic beer" 39). Registers the
// modifier as an alias of the compound and archives the orphan, so the volume
// consolidates instead of the modifier simply vanishing from the radar.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { findCompoundParent, isWellFormed } from "../services/well-formedness.js";

const dryRun = !process.argv.includes("--apply");
const companyId = Number(process.env.COMPANY_ID ?? 1);

async function main() {
  const rows = await db.execute(
    sql`select id, canonical_label, entity_type from tp_entities
         where company_id = ${companyId} and deleted_at is null`
  );
  const entities = rows.rows as Array<{
    id: number; canonical_label: string; entity_type: string;
  }>;
  const labels = entities.map((e) => e.canonical_label);

  const plans: Array<{ from: typeof entities[number]; to: string }> = [];
  for (const e of entities) {
    if (isWellFormed(e.canonical_label).wellFormed) continue;
    const parent = findCompoundParent(e.canonical_label, labels);
    if (parent) plans.push({ from: e, to: parent });
  }

  for (const p of plans) {
    console.log(`  "${p.from.canonical_label}"  ->  "${p.to}"`);
  }
  console.log(`${plans.length} modifier(s) with a compound parent`);

  if (dryRun) {
    console.log("dry run — pass --apply to write");
    return;
  }

  for (const p of plans) {
    await db.execute(
      sql`insert into tp_entity_synonyms
            (company_id, alias, canonical_label, entity_type, source)
          values (${companyId}, ${p.from.canonical_label}, ${p.to},
                  ${p.from.entity_type}, 'dangling-modifier-merge')
          on conflict do nothing`
    );
    await db.execute(
      sql`update tp_entities set deleted_at = now() where id = ${p.from.id}`
    );
  }
  console.log(`merged ${plans.length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

Run dry first, inspect the pairs, then apply per company:

```bash
cd artifacts/api-server
COMPANY_ID=1 pnpm exec tsx --env-file=../../.env src/scripts/merge-dangling-modifiers.ts
COMPANY_ID=1 pnpm exec tsx --env-file=../../.env src/scripts/merge-dangling-modifiers.ts --apply
COMPANY_ID=2 pnpm exec tsx --env-file=../../.env src/scripts/merge-dangling-modifiers.ts --apply
```

Expected on Leone: `"non-alcoholic" -> "non-alcoholic beer"`. Check the pairs before applying — anything that looks wrong means `findCompoundParent` is too loose, and the test cases should be extended rather than the output accepted.

If the `tp_entity_synonyms` column names differ from the insert above, match the real schema in `lib/db/src/schema/index.ts` (`tpEntitySynonyms`) rather than altering the table.

- [ ] **Step 7: Typecheck and run the full suite**

```bash
pnpm --filter @workspace/api-server run typecheck
cd artifacts/api-server && pnpm test
```

Expected: no type errors; all tests pass including the existing specificity suite.

- [ ] **Step 8: Commit**

```bash
git add artifacts/api-server/src/services/well-formedness.ts \
        artifacts/api-server/src/services/well-formedness.test.ts \
        artifacts/api-server/src/services/state-machine.ts \
        artifacts/api-server/src/scripts/merge-dangling-modifiers.ts
git commit -m "feat: well-formedness axis, folding split modifiers into their compound"
```

---

### Task 4: Tag trends that were never searched for

The strongest demo evidence available: on the current radars, 10 items had no related seed keyword at all (creatine at 28 mentions, plus medjool dates, whey protein, folate, yuzu, jamón, mozzarella, calabaza, ceviche, salmón). Surfacing that in the UI directly answers a client's "will this find things we didn't think of?".

**Files:**
- Create: `artifacts/api-server/src/services/discovery-origin.ts`
- Test: `artifacts/api-server/src/services/discovery-origin.test.ts`
- Modify: `artifacts/api-server/src/storage/index.ts` (`getTrends` — add `discovered` to each row)
- Modify: `artifacts/app/src/pages/radar/trends/list.tsx` (badge)

**Interfaces:**
- Produces: `wasSearchedFor(label: string, seedTerms: Set<string>): boolean`, `normalizeTerm(s: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// artifacts/api-server/src/services/discovery-origin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { wasSearchedFor, normalizeTerm } from "./discovery-origin.js";

const seeds = new Set(
  ["Maionese", "maionese caseira", "#vitaminas", "empanadas a domicilio", "vitamin gummies"]
    .map(normalizeTerm)
);

test("an exact seed match counts as searched for", () => {
  assert.equal(wasSearchedFor("maionese", seeds), true);
});

test("a word inside a multi-word seed counts as searched for", () => {
  assert.equal(wasSearchedFor("empanadas", seeds), true);
  assert.equal(wasSearchedFor("vitamin", seeds), true);
});

test("genuinely unseeded terms are not matched", () => {
  for (const label of ["creatine", "yuzu", "ceviche", "medjool dates"]) {
    assert.equal(wasSearchedFor(label, seeds), false, `${label} should be discovered`);
  }
});

test("normalisation strips hashes, case and accents", () => {
  assert.equal(normalizeTerm("#Vitaminas"), "vitaminas");
  assert.equal(normalizeTerm("  Jamón "), "jamon");
});

test("accent-insensitive matching works both ways", () => {
  const s = new Set(["jamon serrano"].map(normalizeTerm));
  assert.equal(wasSearchedFor("jamón", s), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/discovery-origin.test.ts`
Expected: FAIL — cannot find module `./discovery-origin.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// artifacts/api-server/src/services/discovery-origin.ts
// Answers, per trend: did we go looking for this, or did it come out of the
// data? A trend matches "searched for" if its label equals a seed keyword, or
// appears as a whole word inside one (so "empanadas a domicilio" claims
// "empanadas"). Anything left over was surfaced by extraction reading real
// posts, which is the discovery claim.
//
// Matching is deliberately generous: a false "searched for" understates our
// own discovery, which is the safe direction to be wrong in front of a client.

export function normalizeTerm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^#/, "")
    .trim();
}

export function wasSearchedFor(label: string, seedTerms: Set<string>): boolean {
  const lab = normalizeTerm(label);
  if (!lab) return true;
  if (seedTerms.has(lab)) return true;

  const labWords = lab.split(/\s+/);
  for (const seed of seedTerms) {
    if (!seed) continue;
    const seedWords = seed.split(/\s+/);
    if (seedWords.includes(lab)) return true;
    if (labWords.length > 1 && labWords.includes(seed)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/discovery-origin.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Add `discovered` to the trends payload**

In `artifacts/api-server/src/storage/index.ts`, add the import:

```typescript
import { wasSearchedFor, normalizeTerm } from "../services/discovery-origin.js";
```

Add `discovered: boolean;` to the trend row type (the interface containing `topicLabel: string | null;` and `evidenceCount: number;`, ~line 1746-1751).

Inside `getTrends`, before the rows are mapped, load the company's seed vocabulary once:

```typescript
  const seedRows = await db
    .select({
      keywords: tpScoutQueries.keywords,
      hashtags: tpScoutQueries.hashtags,
      topicLabel: tpScoutQueries.topicLabel,
    })
    .from(tpScoutQueries)
    .where(eq(tpScoutQueries.companyId, companyId));

  const seedTerms = new Set<string>();
  for (const r of seedRows) {
    for (const k of r.keywords ?? []) seedTerms.add(normalizeTerm(String(k)));
    for (const h of r.hashtags ?? []) seedTerms.add(normalizeTerm(String(h)));
    if (r.topicLabel) seedTerms.add(normalizeTerm(r.topicLabel));
  }
```

Then in the object literal built for each returned row (the one already setting `evidenceCount: r.ki.evidenceCount ?? 0`), add:

```typescript
      discovered: !wasSearchedFor(r.ki.title ?? "", seedTerms),
```

- [ ] **Step 6: Add the badge**

In `artifacts/app/src/pages/radar/trends/list.tsx`, add `discovered?: boolean` to the trend row type, and render a badge next to the title when it is true:

```tsx
{trend.discovered && (
  <span
    title="No keyword we searched for matches this — extraction surfaced it from real posts"
    className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700"
  >
    Discovered
  </span>
)}
```

- [ ] **Step 7: Verify against known values**

Start the API server, then:

```bash
curl -s "http://localhost:8080/api/pipeline/companies/1/trends" \
  | python3 -c "import sys,json; [print(('DISCOVERED ' if t.get('discovered') else 'seeded     ')+str(t.get('title'))) for t in json.load(sys.stdin)]"
```

Expected: `creatine`, `medjool dates`, `whey protein`, `folate`, `yuzu` are marked DISCOVERED. `non-alcoholic` and `creatine gummies` are marked seeded.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm --filter @workspace/api-server run typecheck
git add artifacts/api-server/src/services/discovery-origin.ts \
        artifacts/api-server/src/services/discovery-origin.test.ts \
        artifacts/api-server/src/storage/index.ts \
        artifacts/app/src/pages/radar/trends/list.tsx
git commit -m "feat: flag trends that no seed keyword went looking for"
```

---

### Task 5: Seed at category level instead of specific products

The root cause of the fan-out complaint. `radar-setup-bot.ts` instructs the model: *"Be specific and concrete: 'pistachio cream' not just 'chocolate'"* and *"Each seed is a specific topic to track"*. So the system guesses specific products before seeing any data, and the fan-out then goes deep on those guesses. Inverting this is a prompt change.

**Files:**
- Modify: `artifacts/api-server/src/services/radar-setup-bot.ts` (~lines 192, 200, 223)
- Create: `artifacts/api-server/src/scripts/eval-seed-breadth.ts`

**Interfaces:**
- No code interface change. Seed generation keeps its existing signature and JSON shape; only the instructions change.

- [ ] **Step 1: Record the current behaviour as a baseline**

```bash
cd artifacts/api-server
pnpm exec tsx --env-file=../../.env -e "
import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql\`select topic_label from tp_scout_queries where company_id=2 order by topic_label\`);
console.log(r.rows.map((x:any)=>x.topic_label).join('\n'));
process.exit(0);
"
```

Expected: the current specific-instance topics (`Avocado sauces MX`, `Chimichurri trends AR`, `Spicy mayo trends BR`, …). Save this output — it is the before-picture for the comparison in Step 5.

- [ ] **Step 2: Invert the seed instructions**

In `artifacts/api-server/src/services/radar-setup-bot.ts`:

Replace the `watchTopicRules` line:

```typescript
- Seeds must concretely operationalize their watch topic into specific, trackable social-listening topics.`
```

with:

```typescript
- Seeds must cover their watch topic BROADLY at category level, so that specific products can be discovered from the data rather than named up front.`
```

Replace the seed-item description line:

```typescript
Generate exactly ${targetCount} seed items. Each seed is a specific topic to track on social media.
```

with:

```typescript
Generate exactly ${targetCount} seed items. Each seed is a CATEGORY of conversation to sweep on social media, not a specific product.`
```

Replace the label example:

```typescript
- label: short descriptive label (e.g. "Pistachio cream IT", "Functional chocolate DE")
```

with:

```typescript
- label: short descriptive category label (e.g. "Chocolate IT", "Condiments MX")
```

Replace the rule itself:

```typescript
- Be specific and concrete: "pistachio cream" not just "chocolate"
```

with:

```typescript
- Stay at CATEGORY level: "chocolate" not "pistachio cream", "condiments" not "spicy mayo".
  Naming a specific product here pre-decides the answer — the specific trends must
  come OUT of the scraped conversation, not go IN as a guess.
- Keywords within a seed should be broad entry points into that category
  (the category name, how people talk about it, common adjacent terms) rather
  than an enumeration of specific products.
```

- [ ] **Step 3: Write the breadth evaluator**

```typescript
// artifacts/api-server/src/scripts/eval-seed-breadth.ts
// Seed generation is non-deterministic, so a single run proves nothing — past
// prompt work here produced four wrong conclusions off 3-run probes. Generate
// repeatedly and measure how often the model still emits a specific product
// where a category was asked for.
import { generateSeedCandidates } from "../services/radar-setup-bot.js";

const TRIALS = Number(process.env.TRIALS ?? 8);

// If a label contains one of these, the model named an instance, not a category.
const INSTANCE_MARKERS = [
  "pistachio cream", "spicy mayo", "chimichurri", "avocado sauce",
  "guacamole", "sriracha", "pesto", "nutella", "aioli",
];

async function main() {
  const companyId = Number(process.env.COMPANY_ID ?? 2);
  let totalLabels = 0;
  let instanceLabels = 0;

  for (let i = 0; i < TRIALS; i++) {
    const seeds = await generateSeedCandidates(companyId);
    for (const s of seeds) {
      totalLabels++;
      const l = String(s.label ?? "").toLowerCase();
      if (INSTANCE_MARKERS.some((m) => l.includes(m))) {
        instanceLabels++;
        console.log(`  [instance] ${s.label}`);
      }
    }
  }

  const pct = totalLabels ? (100 * instanceLabels) / totalLabels : 0;
  console.log(`\n${TRIALS} trials | ${totalLabels} labels | ${instanceLabels} instance-level (${pct.toFixed(1)}%)`);
  console.log(pct <= 10 ? "PASS — seeds are category-level" : "FAIL — still naming specific products");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

If the exported generator in `radar-setup-bot.ts` has a different name or signature than `generateSeedCandidates(companyId)`, adjust the import and call to match the real export — do not change the service to fit the script.

- [ ] **Step 4: Run the evaluator**

```bash
cd artifacts/api-server
COMPANY_ID=2 TRIALS=8 pnpm exec tsx --env-file=../../.env src/scripts/eval-seed-breadth.ts
```

Expected: `PASS — seeds are category-level` (≤10% instance-level labels across 8 trials).

If it fails, strengthen the wording in Step 2 rather than lowering the threshold. Do not judge the change on fewer than 8 trials.

- [ ] **Step 5: Regenerate seeds and compare**

Regenerate the seed set for company 2 through the existing setup flow, then re-run the query from Step 1. Expect category labels (`Condiments MX`, `Sauces BR`) rather than the specific-instance labels captured in the baseline.

**Do not fire a scrape in this task.** New keywords mean a fresh scrape, which is Apify spend and belongs to a deliberate run after the budget reset.

- [ ] **Step 6: Commit**

```bash
git add artifacts/api-server/src/services/radar-setup-bot.ts \
        artifacts/api-server/src/scripts/eval-seed-breadth.ts
git commit -m "feat: seed at category level so specific trends come out of the data"
```

---

### Task 6: Persist watch topic and group trends by it

Jonathan wants the radar organised by watch topic first, then search term. **The blocker is that `watchTopic` is only present in `tp_seed_candidates.payload`** (a draft jsonb blob). It is not carried onto `tp_seed_items` or `tp_scout_queries`, so nothing downstream can group by it. This task adds the column, backfills it, and threads it through.

**Files:**
- Modify: `lib/db/src/schema/index.ts` (`tpSeedItems`, `tpScoutQueries`)
- Create: `artifacts/api-server/src/scripts/backfill-watch-topics.ts`
- Modify: `artifacts/api-server/src/storage/index.ts` (`getTrends` — return `watchTopic`)
- Modify: `artifacts/app/src/pages/radar/trends/list.tsx` (watch-topic filter above the search-term filter)

**Interfaces:**
- Produces: `tpSeedItems.watchTopic: text | null`, `tpScoutQueries.watchTopic: text | null`, and `watchTopic: string | null` on each trends row.

- [ ] **Step 1: Add the columns**

In `lib/db/src/schema/index.ts`, add to `tpSeedItems` (after `territoryTag`):

```typescript
  watchTopic: text("watch_topic"),
```

And to `tpScoutQueries` (after `topicLabel`):

```typescript
  watchTopic: text("watch_topic"),
```

- [ ] **Step 2: Push the schema**

```bash
cd lib/db && pnpm push
```

Expected: drizzle reports two added columns, no data loss warnings. If it offers to drop anything, abort and investigate — do not accept a destructive plan.

- [ ] **Step 3: Backfill from the seed-candidate payloads**

```typescript
// artifacts/api-server/src/scripts/backfill-watch-topics.ts
// watchTopic was only ever stored inside tp_seed_candidates.payload. Recover it
// onto tp_seed_items (matched by label) and cascade to tp_scout_queries.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const dryRun = !process.argv.includes("--apply");
const companyId = Number(process.env.COMPANY_ID ?? 2);

async function main() {
  const cands = await db.execute(
    sql`select payload from tp_seed_candidates
         where company_id = ${companyId} and committed_at is not null
         order by committed_at desc`
  );

  const labelToTopic = new Map<string, string>();
  for (const row of cands.rows as Array<{ payload: unknown }>) {
    const payload = (row.payload ?? []) as Array<{ label?: string; watchTopic?: string }>;
    for (const s of payload) {
      if (s.label && s.watchTopic && !labelToTopic.has(s.label)) {
        labelToTopic.set(s.label, s.watchTopic);
      }
    }
  }
  console.log(`recovered ${labelToTopic.size} label→watchTopic pairs`);

  if (dryRun) {
    for (const [l, t] of labelToTopic) console.log(`  ${l}  ->  ${t}`);
    console.log("dry run — pass --apply to write");
    return;
  }

  for (const [label, topic] of labelToTopic) {
    await db.execute(
      sql`update tp_seed_items set watch_topic = ${topic}
           where company_id = ${companyId} and label = ${label}`
    );
  }

  await db.execute(
    sql`update tp_scout_queries q
           set watch_topic = i.watch_topic
          from tp_seed_items i
         where q.seed_item_id = i.id
           and q.company_id = ${companyId}
           and i.watch_topic is not null`
  );

  const unmapped = await db.execute(
    sql`select count(*)::int as n from tp_scout_queries
         where company_id = ${companyId} and watch_topic is null`
  );
  console.log(`scout queries still without a watch topic: ${(unmapped.rows[0] as { n: number }).n}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

Run dry first, then apply, for both companies:

```bash
cd artifacts/api-server
COMPANY_ID=2 pnpm exec tsx --env-file=../../.env src/scripts/backfill-watch-topics.ts
COMPANY_ID=2 pnpm exec tsx --env-file=../../.env src/scripts/backfill-watch-topics.ts --apply
COMPANY_ID=1 pnpm exec tsx --env-file=../../.env src/scripts/backfill-watch-topics.ts --apply
```

Any scout queries left without a watch topic are pre-watch-topic seeds; they group under `Uncategorised` in the UI rather than being hidden.

- [ ] **Step 4: Carry watchTopic forward on new commits**

In `artifacts/api-server/src/services/radar-setup-bot.ts`, find where seed candidates are committed into `tp_seed_items` and include `watchTopic: s.watchTopic ?? null` in the inserted values. Find where scout queries are created from seed items and include `watchTopic: seedItem.watchTopic ?? null`. Without this the backfill decays the next time seeds are regenerated.

- [ ] **Step 5: Return watchTopic on trends**

In `getTrends` (`artifacts/api-server/src/storage/index.ts`), extend the seed-vocabulary query added in Task 4 to also select `watchTopic`, build a map from normalised search term to watch topic, and add `watchTopic: string | null` to both the row type and the returned object.

- [ ] **Step 6: Add the watch-topic filter to the UI**

In `artifacts/app/src/pages/radar/trends/list.tsx`, add a select above the existing search-term select, populated with the distinct `watchTopic` values from the loaded trends plus an "All watch topics" option. Selecting one filters the rows; the search-term select then narrows within that. Trends with a null watch topic appear under `Uncategorised`.

- [ ] **Step 7: Verify**

```bash
curl -s "http://localhost:8080/api/pipeline/companies/2/trends" \
  | python3 -c "
import sys,json,collections
d=json.load(sys.stdin)
c=collections.Counter(t.get('watchTopic') or 'Uncategorised' for t in d)
[print(f'{v:>3}  {k}') for k,v in c.most_common()]"
```

Expected: trends distributed across the real watch topics, not all `Uncategorised`.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm --filter @workspace/api-server run typecheck
git add lib/db/src/schema/index.ts \
        artifacts/api-server/src/scripts/backfill-watch-topics.ts \
        artifacts/api-server/src/services/radar-setup-bot.ts \
        artifacts/api-server/src/storage/index.ts \
        artifacts/app/src/pages/radar/trends/list.tsx
git commit -m "feat: persist watch topic through seeds to trends and group the radar by it"
```

---

### Task 7: One-click pipeline run

Every stage already has a working endpoint, but they are spread across four admin pages (`queries.tsx`, `runs.tsx`, `signals.tsx`, `entities.tsx`) and must be clicked in the right order with waits between. That is why the system feels unusable despite working. This chains them behind one call with a progress view.

Existing endpoints to chain, in order:
`POST /companies/:id/scout-queries/launch` → `POST /companies/:id/run-ingestion` → `POST /companies/:id/run-entity-extraction` → `POST /companies/:id/run-timeseries` → `POST /companies/:id/run-state-machine`

**Files:**
- Create: `artifacts/api-server/src/services/pipeline-runner.ts`
- Test: `artifacts/api-server/src/services/pipeline-runner.test.ts`
- Modify: `artifacts/api-server/src/routes/pipeline.ts` (add two routes)
- Modify: `artifacts/app/src/pages/radar/control-panel.tsx` (Run button + progress)

**Interfaces:**
- Produces:
  - `PIPELINE_STAGES: readonly PipelineStage[]` where `PipelineStage = "scrape" | "ingest" | "extract" | "timeseries" | "state-machine"`
  - `type RunState = { runId: string; companyId: number; stage: PipelineStage; status: "running" | "done" | "failed"; startedAt: string; finishedAt?: string; error?: string; stageIndex: number; totalStages: number }`
  - `nextStage(current: PipelineStage): PipelineStage | null`
  - `startPipelineRun(companyId: number, deps: StageDeps): Promise<RunState>`
  - `getPipelineRun(companyId: number): RunState | null`

- [ ] **Step 1: Write the failing test**

```typescript
// artifacts/api-server/src/services/pipeline-runner.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIPELINE_STAGES,
  nextStage,
  startPipelineRun,
  getPipelineRun,
  __resetRunsForTest,
} from "./pipeline-runner.js";

function okDeps(calls: string[]) {
  return {
    scrape: async () => { calls.push("scrape"); },
    ingest: async () => { calls.push("ingest"); },
    extract: async () => { calls.push("extract"); },
    timeseries: async () => { calls.push("timeseries"); },
    "state-machine": async () => { calls.push("state-machine"); },
  };
}

test("stages run in pipeline order", async () => {
  __resetRunsForTest();
  const calls: string[] = [];
  await startPipelineRun(1, okDeps(calls));
  assert.deepEqual(calls, [...PIPELINE_STAGES]);
});

test("a completed run reports done", async () => {
  __resetRunsForTest();
  await startPipelineRun(1, okDeps([]));
  const s = getPipelineRun(1);
  assert.equal(s?.status, "done");
  assert.equal(s?.stageIndex, PIPELINE_STAGES.length);
});

test("a failing stage halts the pipeline and records the error", async () => {
  __resetRunsForTest();
  const calls: string[] = [];
  const deps = okDeps(calls);
  deps.extract = async () => { throw new Error("extraction blew up"); };
  await startPipelineRun(1, deps);
  const s = getPipelineRun(1);
  assert.equal(s?.status, "failed");
  assert.equal(s?.stage, "extract");
  assert.match(s?.error ?? "", /extraction blew up/);
  assert.deepEqual(calls, ["scrape", "ingest"]);
});

test("a second run is refused while one is in flight", async () => {
  __resetRunsForTest();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const deps = okDeps([]);
  deps.scrape = async () => { await gate; };
  const first = startPipelineRun(2, deps);
  await assert.rejects(() => startPipelineRun(2, okDeps([])), /already running/i);
  release();
  await first;
});

test("nextStage walks the sequence and terminates", () => {
  assert.equal(nextStage("scrape"), "ingest");
  assert.equal(nextStage("state-machine"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/pipeline-runner.test.ts`
Expected: FAIL — cannot find module `./pipeline-runner.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
// artifacts/api-server/src/services/pipeline-runner.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd artifacts/api-server && pnpm exec node --env-file=../../.env --import tsx --test src/services/pipeline-runner.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Add the routes**

In `artifacts/api-server/src/routes/pipeline.ts`, import the runner:

```typescript
import { startPipelineRun, getPipelineRun, type StageDeps } from "../services/pipeline-runner.js";
```

Add a `StageDeps` value that calls the same service functions the five existing per-stage handlers call. Reuse those functions directly — do not make the server issue HTTP requests to itself. Then:

```typescript
router.post("/companies/:id/run-pipeline", async (req, res) => {
  const companyId = parseInt(req.params.id!, 10);
  try {
    const state = getPipelineRun(companyId);
    if (state && state.status === "running") {
      res.status(409).json({ error: "pipeline already running", state });
      return;
    }
    // Fire and forget: the client polls run-pipeline-status for progress.
    void startPipelineRun(companyId, pipelineStageDeps).catch((e) =>
      logger.error({ err: e, companyId }, "pipeline run failed")
    );
    res.status(202).json({ started: true, companyId });
  } catch (err: any) {
    logger.error({ err }, "Failed to start pipeline run");
    res.status(500).json({ error: err.message });
  }
});

router.get("/companies/:id/run-pipeline-status", async (req, res) => {
  const companyId = parseInt(req.params.id!, 10);
  res.json(getPipelineRun(companyId) ?? { status: "idle", companyId });
});
```

- [ ] **Step 6: Add the Run button**

In `artifacts/app/src/pages/radar/control-panel.tsx`, add a "Run full pipeline" button that POSTs to `/api/pipeline/companies/${companyId}/run-pipeline`, then polls `/run-pipeline-status` every 5 seconds while `status === "running"`, rendering `stage` and `stageIndex / totalStages`. On `failed`, show the `error` text. Disable the button while a run is in flight.

Include a plain-language warning next to the button, because this spends real money:

> A full run takes a few hours and fires Apify scrapes. Set it up ahead of a client meeting, not during one.

- [ ] **Step 7: Verify without spending money**

Point the `scrape` dep at a company whose scout queries are all inactive so the launch is a no-op, then:

```bash
curl -s -X POST "http://localhost:8080/api/pipeline/companies/2/run-pipeline"
sleep 3
curl -s "http://localhost:8080/api/pipeline/companies/2/run-pipeline-status"
```

Expected: the POST returns `{"started":true,...}`; the status call reports a stage and a `stageIndex`. Confirm a second POST while running returns HTTP 409.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm --filter @workspace/api-server run typecheck
git add artifacts/api-server/src/services/pipeline-runner.ts \
        artifacts/api-server/src/services/pipeline-runner.test.ts \
        artifacts/api-server/src/routes/pipeline.ts \
        artifacts/app/src/pages/radar/control-panel.tsx
git commit -m "feat: one-click full pipeline run with progress"
```

---

## Not in this plan

Explicitly out of scope, agreed with Jonathan as a separate piece of work: the relevance filter, the BERTrend detector replacement, cross-lingual merge, incremental refresh, and menu/retail connectors.

Also deliberately excluded: the **Emerging long-tail lane**. It is missing both a specificity check and an upper volume bound (`services/long-tail.ts` filters only on `minMentions` and the posterior), so firing it today surfaces staples — café at 120 mentions, sal, pollo, huevo. Fixing it is small, but it was not on the agreed list. Raise it separately rather than folding it in silently.

## Acceptance

The list Jonathan approved is done when:

1. The Evidence column is labelled with its window, and the drill-down states both the recent and the all-time count — no number on screen contradicts another, and no evidence is hidden to achieve that.
2. No radar item is named `handmade`, `brunch`, `graduation`, or a bare modifier — and `non-alcoholic` has been folded into `non-alcoholic beer` rather than simply removed.
3. Trends surfaced without a matching seed keyword carry a **Discovered** badge, and `creatine` on Leone is one of them.
4. Seed generation produces category labels, verified at ≥8 trials.
5. The radar can be filtered by watch topic before search term.
6. A non-engineer can trigger a full run from one button and watch it progress.
7. Nothing in the UI says `Confirmed` as a growth state.
