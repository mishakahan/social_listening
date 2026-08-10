// RETROSPECTIVE HOLDOUT — does a gate PASS actually predict what happens next?
//
// The gate has never been checked against any outcome. It applies a
// permutation test and a breadth test and calls something "confirmed", but
// nobody has asked whether entities it passes go on to behave differently
// from entities it holds. This answers that, for $0, from data already in the
// DB — no scrape, no LLM, no writes.
//
// METHOD
//   1. Pick a cutoff T in the past.
//   2. Truncate every entity's timeseries to bucket_date <= T and run the REAL
//      production gate on it (confirmationVerdict + buildGateInput, imported,
//      not reimplemented) — so this measures the shipped gate, not a model of
//      it.
//   3. Measure what ACTUALLY happened in the horizon after T.
//   4. Compare the PASS cohort against the HOLD cohort.
//
// If the gate has predictive validity, passed entities should out-grow held
// ones by a margin that a rank test can distinguish from chance.
//
// WHAT THIS CANNOT SHOW (state it, don't bury it):
//   - It is not a prospective test. The "pre-T" data was retrieved by a scrape
//     run in JULY, so it is what a July scrape reveals about May, not what a
//     May scrape would have found. Relevance-sorted actors under-represent
//     older posts, so both cohorts carry a recency skew.
//   - Because that skew hits PASS and HOLD alike, the RELATIVE comparison
//     survives it. The absolute growth numbers do not — read the ratio between
//     cohorts, not the ratio itself.
//   - It validates predictive behaviour on our own social data. It says
//     nothing about real-world consumer adoption; that needs an independent
//     source (Google Trends / Exploding Topics).
//
//   COMPANY_ID=2 HORIZON_DAYS=56 pnpm exec tsx --env-file=../../.env \
//     src/scripts/holdout-validate.ts
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  buildGateInput,
  confirmationVerdict,
  type GateConfig,
} from "../services/confirmation-gate.js";
import type { TpEntityTimeseries } from "@workspace/db";
import { pathToFileURL } from "node:url";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "2");
const HORIZON_DAYS = Number(process.env.HORIZON_DAYS ?? "56"); // 8 weeks
const MIN_PRE_MENTIONS = Number(process.env.MIN_PRE_MENTIONS ?? "3");

// Production defaults (confirmation-gate.ts gateConfigFromPipeline: the
// per-company gate columns were never added, so production runs on these).
const cfg: GateConfig = {
  significanceAlpha: 0.05,
  permutations: 1000,
  minSourceEntropyBits: 1.0,
  minUniqueAuthors: 3,
  enabled: true,
  // Honours GATE_REQUIRE_SIGNIFICANCE so the holdout can be replayed through
  // the REAL confirmationVerdict path in either configuration — which is how
  // the flag itself gets verified against measured numbers, rather than only
  // in unit tests.
  requireSignificance: process.env.GATE_REQUIRE_SIGNIFICANCE !== "false",
};

// Deterministic RNG so the verdict for a given entity is reproducible across
// runs — a permutation test on Math.random would make this report unstable.
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (iso: string, n: number) =>
  new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400_000)
    .toISOString()
    .slice(0, 10);

// --- Mann-Whitney U (rank-sum), normal approximation with tie correction ---
export function mannWhitney(a: number[], b: number[]): { u: number; z: number; p: number } {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return { u: 0, z: 0, p: 1 };
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort(
    (x, y) => x.v - y.v
  );
  // average ranks for ties
  const ranks = new Array(all.length).fill(0);
  let i = 0;
  const tieGroups: number[] = [];
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const avg = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    tieGroups.push(j - i + 1);
    i = j + 1;
  }
  let r1 = 0;
  all.forEach((x, idx) => {
    if (x.g === 0) r1 += ranks[idx]!;
  });
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  const mu = (n1 * n2) / 2;
  const tieSum = tieGroups.reduce((s, t) => s + (t * t * t - t), 0);
  const sigma = Math.sqrt(
    ((n1 * n2) / 12) * ((n + 1) - tieSum / (n * (n - 1)))
  );
  const z = sigma > 0 ? (u1 - mu) / sigma : 0;
  // two-sided p from the normal approximation
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  return { u: u1, z, p: Math.min(1, Math.max(0, p)) };
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return y;
}

export const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export type Result = {
  entityId: number;
  label: string;
  decision: "pass" | "hold";
  insufficientHistory: boolean;
  sigPass: boolean;
  breadthPass: boolean;
  preMentions: number;
  postMentions: number;
  ratio: number;
  survived: boolean;
};

// Exported so other validation scripts (e.g. the Google Trends cross-check)
// reuse the SAME cohort logic rather than reimplementing it and quietly
// diverging. Returns every evaluated entity with its gate verdict at T and
// what actually happened afterwards.
export async function computeHoldout(
  companyId: number,
  horizonDays = HORIZON_DAYS,
  minPreMentions = MIN_PRE_MENTIONS
): Promise<{ results: Result[]; cutoff: string; horizonEnd: string; firstDay: string; lastDay: string }> {
  const bounds = await db.execute(sql`
    select min(bucket_date)::text as first_day, max(bucket_date)::text as last_day
    from tp_entity_timeseries where company_id = ${companyId}
  `);
  const { first_day, last_day } = (bounds.rows as any[])[0];
  if (!last_day) throw new Error(`No timeseries for company ${companyId}`);
  const cutoff = process.env.CUTOFF ?? addDays(last_day, -horizonDays);
  const preWindowStart = addDays(cutoff, -horizonDays);
  const horizonEnd = addDays(cutoff, horizonDays);

  const rowsRes = await db.execute(sql`
    select ts.entity_id, ts.platform, ts.bucket_date::text as bucket_date,
           ts.mentions, ts.unique_authors, e.canonical_label
    from tp_entity_timeseries ts
    join tp_entities e on e.id = ts.entity_id
    where ts.company_id = ${companyId} and ts.bucket_date <= ${horizonEnd}
    order by ts.entity_id, ts.bucket_date
  `);
  const byEntity = new Map<number, any[]>();
  for (const r of rowsRes.rows as any[]) {
    const list = byEntity.get(r.entity_id) ?? [];
    list.push(r);
    byEntity.set(r.entity_id, list);
  }

  const results: Result[] = [];
  for (const [entityId, rows] of byEntity) {
    const preRows = rows.filter((r) => r.bucket_date <= cutoff);
    if (preRows.length === 0) continue;
    const preWindow = rows.filter((r) => r.bucket_date > preWindowStart && r.bucket_date <= cutoff);
    const postWindow = rows.filter((r) => r.bucket_date > cutoff && r.bucket_date <= horizonEnd);
    const preMentions = preWindow.reduce((s: number, r: any) => s + r.mentions, 0);
    if (preMentions < minPreMentions) continue;
    const postMentions = postWindow.reduce((s: number, r: any) => s + r.mentions, 0);
    const gateRows = preRows.map((r) => ({
      bucketDate: r.bucket_date,
      platform: r.platform,
      mentions: r.mentions,
      uniqueAuthors: r.unique_authors,
    })) as unknown as TpEntityTimeseries[];
    const input = buildGateInput(gateRows);
    const verdict = confirmationVerdict(input, cfg, seeded(entityId));
    results.push({
      entityId,
      label: rows[0]!.canonical_label,
      decision: verdict.decision,
      insufficientHistory: input.dailyMentions.length < 14,
      sigPass: verdict.significance.pass,
      breadthPass: verdict.breadth.pass,
      preMentions,
      postMentions,
      ratio: (postMentions + 1) / (preMentions + 1),
      survived: postMentions > 0,
    });
  }
  return { results, cutoff, horizonEnd, firstDay: first_day, lastDay: last_day };
}

async function main() {
  // Anchor the cutoff to the data, not to today: the scrape is a one-shot, so
  // "now" is irrelevant — what matters is the last day with real data.
  const bounds = await db.execute(sql`
    select min(bucket_date)::text as first_day, max(bucket_date)::text as last_day
    from tp_entity_timeseries where company_id = ${COMPANY_ID}
  `);
  const { first_day, last_day } = (bounds.rows as any[])[0];
  if (!last_day) throw new Error(`No timeseries for company ${COMPANY_ID}`);

  const cutoff = process.env.CUTOFF ?? addDays(last_day, -HORIZON_DAYS);
  const preWindowStart = addDays(cutoff, -HORIZON_DAYS);
  const horizonEnd = addDays(cutoff, HORIZON_DAYS);

  console.log(`=== RETROSPECTIVE HOLDOUT — company ${COMPANY_ID} ===`);
  console.log(`data spans        ${first_day} -> ${last_day}`);
  console.log(`cutoff T          ${cutoff}`);
  console.log(`pre window        ${preWindowStart} -> ${cutoff}   (${HORIZON_DAYS}d, for the growth denominator)`);
  console.log(`horizon after T   ${cutoff} -> ${horizonEnd}   (${HORIZON_DAYS}d, the outcome)`);
  console.log(`gate config       alpha=${cfg.significanceAlpha}, perms=${cfg.permutations}, breadth>=${cfg.minSourceEntropyBits} bits, authors>=${cfg.minUniqueAuthors}\n`);

  const rowsRes = await db.execute(sql`
    select ts.entity_id, ts.platform, ts.geography, ts.bucket_date::text as bucket_date,
           ts.mentions, ts.unique_authors, e.canonical_label
    from tp_entity_timeseries ts
    join tp_entities e on e.id = ts.entity_id
    where ts.company_id = ${COMPANY_ID}
      and ts.bucket_date <= ${horizonEnd}
    order by ts.entity_id, ts.bucket_date
  `);

  type Row = {
    entity_id: number;
    platform: string;
    geography: string;
    bucket_date: string;
    mentions: number;
    unique_authors: number;
    canonical_label: string;
  };
  const byEntity = new Map<number, Row[]>();
  for (const r of rowsRes.rows as any[]) {
    const row = r as Row;
    const list = byEntity.get(row.entity_id) ?? [];
    list.push(row);
    byEntity.set(row.entity_id, list);
  }
  console.log(`${byEntity.size} entities with timeseries data up to the horizon end\n`);

  const results: Result[] = [];

  for (const [entityId, rows] of byEntity) {
    const preRows = rows.filter((r) => r.bucket_date <= cutoff);
    if (preRows.length === 0) continue;

    const preWindow = rows.filter(
      (r) => r.bucket_date > preWindowStart && r.bucket_date <= cutoff
    );
    const postWindow = rows.filter(
      (r) => r.bucket_date > cutoff && r.bucket_date <= horizonEnd
    );
    const preMentions = preWindow.reduce((s, r) => s + r.mentions, 0);
    // Only judge entities that had enough activity before T to be a candidate
    // at all — otherwise the comparison is dominated by noise entities that
    // the gate never had a real chance to evaluate.
    if (preMentions < MIN_PRE_MENTIONS) continue;

    const postMentions = postWindow.reduce((s, r) => s + r.mentions, 0);

    // Run the REAL gate on the truncated series.
    const gateRows = preRows.map((r) => ({
      bucketDate: r.bucket_date,
      platform: r.platform,
      mentions: r.mentions,
      uniqueAuthors: r.unique_authors,
    })) as unknown as TpEntityTimeseries[];
    const input = buildGateInput(gateRows);
    const verdict = confirmationVerdict(input, cfg, seeded(entityId));

    results.push({
      entityId,
      label: rows[0]!.canonical_label,
      decision: verdict.decision,
      insufficientHistory: input.dailyMentions.length < 14,
      sigPass: verdict.significance.pass,
      breadthPass: verdict.breadth.pass,
      preMentions,
      postMentions,
      // +1 smoothing so entities that went to zero are comparable rather than
      // producing a 0/0 or an infinity.
      ratio: (postMentions + 1) / (preMentions + 1),
      survived: postMentions > 0,
    });
  }

  const evaluated = results.filter((r) => !r.insufficientHistory);
  const insufficient = results.filter((r) => r.insufficientHistory);

  console.log(`--- cohorts at T (entities with >=${MIN_PRE_MENTIONS} mentions in the pre-window) ---`);
  console.log(`  candidates            ${results.length}`);
  console.log(`  excluded (<14d series, gate cannot judge)  ${insufficient.length}`);
  console.log(`  EVALUATED by the gate ${evaluated.length}\n`);

  // MINIMUM COHORT SIZE BEFORE A NEGATIVE RESULT MEANS ANYTHING.
  // The combined gate passes ~0.4% of entities, so on one cutoff its PASS
  // cohort can be a single entity — and a rank test on n=1 cannot detect
  // anything, however real the effect. Reporting "no predictive validity"
  // from that would be a false negative dressed as a finding, which is the
  // exact failure this project has already made four times with thresholds
  // invented ahead of the data. So: below this many in EITHER cohort, the
  // result is reported as UNDERPOWERED, never as a negative.
  const MIN_COHORT = 20;

  function compare(name: string, isPositive: (r: Result) => boolean): void {
    const yes = evaluated.filter(isPositive);
    const no = evaluated.filter((r) => !isPositive(r));
    console.log(`--- ${name} ---`);
    const fmt = (label: string, xs: Result[]) =>
      console.log(
        `  ${label.padEnd(10)} n=${String(xs.length).padStart(4)}  ` +
          `median growth ${xs.length ? median(xs.map((r) => r.ratio)).toFixed(2) : "n/a"}x  ` +
          `median post ${xs.length ? median(xs.map((r) => r.postMentions)).toFixed(1) : "n/a"}  ` +
          `still active ${xs.length ? ((100 * xs.filter((r) => r.survived).length) / xs.length).toFixed(1) : "n/a"}%`
      );
    fmt("PASSED", yes);
    fmt("FAILED", no);

    if (yes.length < MIN_COHORT || no.length < MIN_COHORT) {
      console.log(
        `  -> UNDERPOWERED (need >=${MIN_COHORT} in both cohorts, have ${yes.length}/${no.length}). ` +
          `No conclusion either way — this is NOT evidence of absence.\n`
      );
      return;
    }
    const mw = mannWhitney(yes.map((r) => r.ratio), no.map((r) => r.ratio));
    const ym = median(yes.map((r) => r.ratio));
    const nm = median(no.map((r) => r.ratio));
    const pStr = mw.p < 0.0001 ? "<0.0001" : mw.p.toFixed(4);
    console.log(`  -> rank test z=${mw.z.toFixed(2)}, p=${pStr}, ratio of medians ${(ym / nm).toFixed(2)}x`);
    console.log(
      `  -> ${
        mw.p >= 0.05
          ? "NO EFFECT DETECTED at this sample size."
          : ym > nm
            ? "PREDICTIVE — the check selects entities that go on to grow more."
            : "INVERTED — the check selects AGAINST the outcome."
      }\n`
    );
  }

  // Test each check on its own as well as the combined gate. The components
  // have far larger cohorts than the conjunction, so they carry the power —
  // and knowing WHICH check does the work is more actionable than a single
  // verdict on the whole gate.
  compare("SIGNIFICANCE test alone (permutation vs own noise)", (r) => r.sigPass);
  compare("BREADTH test alone (platform/author entropy)", (r) => r.breadthPass);
  compare("COMBINED gate (significance AND breadth)", (r) => r.decision === "pass");

  // ROBUSTNESS: is breadth just a proxy for VOLUME?
  // An entity seen on more platforms is searched by more actor streams, so it
  // mechanically accumulates more mentions. If breadth-passing entities are
  // simply bigger, the "predictive" result is an artifact of size, not of
  // diversity. Stratify by pre-window volume and re-test WITHIN each band: a
  // real effect must survive inside bands where both cohorts are the same size.
  console.log(`--- ROBUSTNESS: breadth effect, stratified by pre-window volume ---`);
  const bpass = evaluated.filter((r) => r.breadthPass);
  const bfail = evaluated.filter((r) => !r.breadthPass);
  console.log(
    `  median pre-volume: breadth-PASS ${median(bpass.map((r) => r.preMentions)).toFixed(1)} ` +
      `vs breadth-FAIL ${median(bfail.map((r) => r.preMentions)).toFixed(1)}` +
      `  (if these differ a lot, volume is a live confound)`
  );
  const bands: [string, (n: number) => boolean][] = [
    ["3-5", (n) => n >= 3 && n <= 5],
    ["6-10", (n) => n >= 6 && n <= 10],
    ["11-20", (n) => n >= 11 && n <= 20],
    ["21+", (n) => n >= 21],
  ];
  for (const [label, inBand] of bands) {
    const yes = bpass.filter((r) => inBand(r.preMentions));
    const no = bfail.filter((r) => inBand(r.preMentions));
    if (yes.length < 10 || no.length < 10) {
      console.log(
        `  pre-volume ${label.padEnd(6)} n=${yes.length}/${no.length} — too few to test within band`
      );
      continue;
    }
    const mw = mannWhitney(yes.map((r) => r.ratio), no.map((r) => r.ratio));
    const ym = median(yes.map((r) => r.ratio));
    const nm = median(no.map((r) => r.ratio));
    console.log(
      `  pre-volume ${label.padEnd(6)} n=${String(yes.length).padStart(3)}/${String(no.length).padStart(3)}  ` +
        `growth ${ym.toFixed(2)}x vs ${nm.toFixed(2)}x  ratio ${(ym / nm).toFixed(2)}x  ` +
        `p=${mw.p < 0.0001 ? "<0.0001" : mw.p.toFixed(4)}  ${mw.p < 0.05 && ym > nm ? "HOLDS" : mw.p < 0.05 && ym < nm ? "INVERTS" : "no effect in band"}`
    );
  }
  console.log();

  const pass = evaluated.filter((r) => r.decision === "pass");
  if (pass.length > 0) {
    console.log(`--- entities the full gate PASSED at T, and what actually happened ---`);
    for (const r of [...pass].sort((a, b) => b.preMentions - a.preMentions).slice(0, 15)) {
      console.log(
        `  ${r.label.slice(0, 30).padEnd(30)} pre=${String(r.preMentions).padStart(4)} post=${String(r.postMentions).padStart(4)}  ${r.ratio.toFixed(2)}x`
      );
    }
  }

  process.exit(0);
}

// Guard so the unit test can import mannWhitney/median without executing a
// full DB run as an import side effect (same pattern as eval-seed-breadth.ts,
// where an unguarded import once kicked off a real paid generation loop).
const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMainModule) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
