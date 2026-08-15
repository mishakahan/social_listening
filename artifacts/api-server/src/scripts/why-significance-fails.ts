// WHY the significance test carries no signal — mechanism, not just correlation.
//
// Three diagnostics, all free, all from data already in the DB:
//   1. CALIBRATION. At alpha=0.05 a valid test should call ~5% of a mostly
//      non-trending population significant. What rate does it actually pass?
//   2. CONDITIONAL EFFECT. Among entities that ALREADY clear breadth, do the
//      significant ones outperform the non-significant ones? This is the crux:
//      adding significance to breadth lowered the edge (1.65x -> 1.43x), which
//      can only happen if significance selects the WORSE half of that group.
//   3. WHAT IT ACTUALLY MEASURES. Is passing explained by recency-clustering
//      of mentions rather than by sustained growth?
import { computeHoldout, mannWhitney, median } from "./holdout-validate.js";

const COMPANY_ID = Number(process.env.COMPANY_ID ?? "1");

async function main() {
  const { results, cutoff } = await computeHoldout(COMPANY_ID);
  const evaluated = results.filter((r) => !r.insufficientHistory);
  console.log(`=== WHY SIGNIFICANCE FAILS — company ${COMPANY_ID}, cutoff ${cutoff} ===`);
  console.log(`${evaluated.length} entities evaluated\n`);

  // 1. CALIBRATION
  const sigPass = evaluated.filter((r) => r.sigPass);
  const rate = (100 * sigPass.length) / evaluated.length;
  console.log(`--- 1. CALIBRATION ---`);
  console.log(`  alpha = 0.05, so a calibrated test should pass ~5% of a`);
  console.log(`  population that is mostly NOT trending.`);
  console.log(`  actual pass rate: ${sigPass.length}/${evaluated.length} = ${rate.toFixed(1)}%`);
  console.log(
    `  -> ${(rate / 5).toFixed(0)}x the nominal rate. Either ${rate.toFixed(0)}% of food entities are`
  );
  console.log(`     genuinely accelerating, or the null the test shuffles against does not`);
  console.log(`     describe this data. A test that fires on ${rate.toFixed(0)}% of everything cannot`);
  console.log(`     carry much information whichever way you read it.\n`);

  // 2. CONDITIONAL EFFECT — the crux
  const breadthPass = evaluated.filter((r) => r.breadthPass);
  const both = breadthPass.filter((r) => r.sigPass);
  const breadthOnly = breadthPass.filter((r) => !r.sigPass);
  console.log(`--- 2. CONDITIONAL EFFECT (within entities that already clear breadth) ---`);
  console.log(`  breadth-pass entities: ${breadthPass.length}`);
  const bm = median(breadthPass.map((r) => r.ratio));
  console.log(`    ...and significant      n=${String(both.length).padStart(3)}  median growth ${median(both.map((r) => r.ratio)).toFixed(2)}x`);
  console.log(`    ...and NOT significant  n=${String(breadthOnly.length).padStart(3)}  median growth ${median(breadthOnly.map((r) => r.ratio)).toFixed(2)}x`);
  console.log(`    (whole breadth-pass group: ${bm.toFixed(2)}x)`);
  if (both.length >= 15 && breadthOnly.length >= 15) {
    const mw = mannWhitney(both.map((r) => r.ratio), breadthOnly.map((r) => r.ratio));
    const bothM = median(both.map((r) => r.ratio));
    const onlyM = median(breadthOnly.map((r) => r.ratio));
    console.log(
      `  rank test z=${mw.z.toFixed(2)}, p=${mw.p < 0.0001 ? "<0.0001" : mw.p.toFixed(4)}, ratio ${(bothM / onlyM).toFixed(2)}x`
    );
    console.log(
      `  -> ${
        bothM < onlyM
          ? "The significant ones grew LESS. Requiring significance actively discards the better half of the breadth-qualified set."
          : "The significant ones grew more, which would argue for keeping the requirement."
      }\n`
    );
  } else {
    console.log(`  -> cohorts too small to test (${both.length}/${breadthOnly.length})\n`);
  }

  // 3. WHAT IT ACTUALLY SELECTS FOR
  // The statistic is the sum of the LAST 7 DAYS of the series versus shuffles
  // of that series. So it rewards mentions bunched at the end of the window,
  // regardless of whether the entity is broadly established. Check whether
  // passing tracks that bunching.
  console.log(`--- 3. WHAT IT SELECTS FOR ---`);
  console.log(`  The statistic is the last 7 days' mentions vs shuffles of the same`);
  console.log(`  series, so it rewards mentions BUNCHED at the end of the window.`);
  const passPre = median(sigPass.map((r) => r.preMentions));
  const failPre = median(evaluated.filter((r) => !r.sigPass).map((r) => r.preMentions));
  console.log(`  median pre-window volume: significant ${passPre} vs not ${failPre}`);
  console.log(
    `  -> ${
      passPre <= failPre
        ? "Significance is NOT selecting bigger or better-evidenced entities — it fires on small ones whose few mentions happen to land late."
        : "Significant entities are also larger, so volume is entangled with the result."
    }`
  );
  console.log(
    `\n  A one-off burst at the end of the window is exactly what reverts afterwards,`
  );
  console.log(`  which is why this check can select against the outcome rather than for it.`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
