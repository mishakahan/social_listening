import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { confirmationVerdict, type GateConfig } from "../services/confirmation-gate.js";
import { fixtures } from "../services/confirmation-gate.fixtures.js";

// Resolve repo root from this file's location so output lands in the same
// place regardless of the cwd pnpm runs us from.
// src/scripts/ -> api-server -> artifacts -> <repo root>
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const outPath = resolve(repoRoot, "docs/backtest-results.md");

const cfg: GateConfig = {
  significanceAlpha: 0.05,
  permutations: 1000,
  minSourceEntropyBits: 1.0,
  minUniqueAuthors: 3,
  enabled: true,
  // Current shipped behaviour: significance is required. Set explicitly so
  // this baseline never drifts if the default changes.
  requireSignificance: true,
};

// Deterministic RNG so the committed results doc is reproducible.
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

const lines: string[] = [
  "# Backtest Results — Confirmation Gate",
  "",
  "Each labelled case asserts whether a candidate _should_ surface to the radar.",
  '"hold" means the gate correctly suppressed a false positive.',
  "",
  "| case | expected | actual | match | reasons |",
  "|---|---|---|---|---|",
];

let matches = 0;
for (const f of fixtures) {
  const v = confirmationVerdict(f.input, cfg, seeded(1));
  const ok = v.decision === f.expected;
  if (ok) matches++;
  lines.push(
    `| ${f.name} | ${f.expected} | ${v.decision} | ${ok ? "match" : "MISS"} | ${v.reasons.join("; ")} |`
  );
}

lines.push("", `**${matches}/${fixtures.length} labelled cases matched expectation.**`);
lines.push(
  "",
  "_Verdicts are honest, descriptive outputs. An honest \"hold\" is a valid",
  "result; no specific accuracy figure is required for acceptance (contract §1.2)._"
);

const out = lines.join("\n");
console.log(out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out + "\n");
console.log(`\nWrote ${outPath}`);
