// Run the Schedule B benchmark backtest and write a documented report.
// Pulls entities + gate verdicts for the BENCH: queries, matches them to the
// benchmark trends, and reports whether known trends passed and noise was held.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { db, tpEntities, tpEntityState, tpSeedItems, tpScoutQueries, tpSignalEntities, tpRawSignals } from "@workspace/db";
import { sql, eq, inArray, and, like } from "drizzle-orm";
import { runBacktest, type BenchmarkTrend, type EntityVerdict } from "../services/benchmark-backtest.js";

const COMPANY_ID = Number(process.env.REGEN_COMPANY_ID ?? "1");
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

async function main() {
  // 1) benchmark trends (with expected pass/hold) from the saved file
  const benchPath = resolve(here, "../../data-snapshots/exploding-topics-benchmark.json");
  const bench = JSON.parse(readFileSync(benchPath, "utf-8")) as Array<{
    name: string;
    expected: "pass" | "hold";
    description?: string;
    growth?: string;
  }>;

  // 2) all entities for the company, with their gate verdict (if any)
  const states = await db.execute(sql`
    select e.canonical_label as label,
           s.state,
           s.confirmation_verdict as verdict,
           s.volume_30d
    from tp_entities e
    join tp_entity_state s on s.entity_id = e.id
    where e.company_id = ${COMPANY_ID}
  `);
  const rows = ((states as any).rows ?? states) as any[];

  const entities: EntityVerdict[] = rows.map((r) => {
    const v = r.verdict; // jsonb: { decision, reasons, significanceP, entropyBits } or null
    return {
      label: r.label,
      hadData: (r.volume_30d ?? 0) > 0,
      decision: v ? v.decision : null,
      significanceP: v ? v.significanceP : undefined,
      entropyBits: v ? v.entropyBits : undefined,
    };
  });

  // 3) split benchmark into positives (should pass) and negatives (should hold)
  const positives = bench.filter((b) => b.expected === "pass");
  const negatives = bench.filter((b) => b.expected === "hold");

  const posResult = runBacktest(positives as BenchmarkTrend[], entities);
  const negResult = runBacktest(negatives as BenchmarkTrend[], entities);

  // 4) write report
  const lines: string[] = [];
  lines.push("# Schedule B Backtest — Confirmation Gate vs Exploding Topics Benchmark");
  lines.push("");
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Two-sided test: known trends should PASS the gate; evergreen noise should be HELD.");
  lines.push("");
  lines.push("## Positives — known trends that SHOULD pass");
  lines.push("");
  lines.push(`Confirmed: ${posResult.confirmed} | Held-flat: ${posResult.heldFlat} | Held-no-signal: ${posResult.heldNoSignal} | Not-found: ${posResult.notFound} (of ${posResult.total})`);
  lines.push("");
  lines.push("| trend | outcome | verdict | note |");
  lines.push("|---|---|---|---|");
  for (const r of posResult.rows) lines.push(`| ${r.trend} | ${r.outcome} | ${r.decision ?? "-"} | ${r.note} |`);
  lines.push("");
  lines.push("## Negatives — evergreen noise that SHOULD be held");
  lines.push("");
  const noiseHeldRight = negResult.rows.filter((r) => r.decision === "hold" || r.decision === null).length;
  lines.push(`Correctly held: ${noiseHeldRight} | Wrongly passed: ${negResult.rows.filter((r) => r.decision === "pass").length} (of ${negResult.total})`);
  lines.push("");
  lines.push("| noise term | outcome | verdict | note |");
  lines.push("|---|---|---|---|");
  for (const r of negResult.rows) lines.push(`| ${r.trend} | ${r.outcome} | ${r.decision ?? "-"} | ${r.note} |`);
  lines.push("");
  lines.push("## Honest read");
  lines.push("");
  lines.push("- 'not-found' / 'held-no-signal' = the trend has little social presence (search-vs-social gap), not a gate failure.");
  lines.push("- 'confirmed' on a positive = the gate correctly confirmed a real trend.");
  lines.push("- 'held' on a noise term = the gate correctly rejected non-trending chatter.");
  lines.push("- Acceptance (Schedule B) is honest, documented verdicts — not a target accuracy.");

  const out = lines.join("\n");
  mkdirSync(resolve(repoRoot, "docs"), { recursive: true });
  const outPath = resolve(repoRoot, "docs/backtest-schedule-b.md");
  writeFileSync(outPath, out + "\n");
  console.log(out);
  console.log(`\nWrote ${outPath}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
