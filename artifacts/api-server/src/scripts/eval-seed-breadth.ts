// Eval harness for the category-vs-instance seed prompt (services/radar-setup-bot.ts).
//
// WHY THIS EXISTS: seed generation is non-deterministic, so a single run
// proves nothing — past prompt work on THIS file produced four wrong "it
// works now" conclusions off 3-run probes. Generate repeatedly and measure
// how often the model still emits a specific product where a category was
// asked for.
//
// The brief's sketch called `generateSeedCandidates(companyId)`. The real
// export is `generateSeedCandidates(brief, companyId, userId, watchTopics)`
// (artifacts/api-server/src/services/radar-setup-bot.ts:246) — it does not
// read anything from the DB itself, it's a pure in-memory generator. This
// script supplies the exact brief text and watch topics already on file for
// company 2 (read once, read-only, via `tp_seed_candidates.brief_snapshot` /
// `watch_topics_snapshot` — see the committed row for that company) so each
// trial reproduces the real production call. Nothing is persisted:
// `generateSeedCandidates` only returns data, persistence happens in
// routes/pipeline.ts via storage.createSeedCandidates, which this script
// never calls.
//
//   COMPANY_ID=2 TRIALS=8 pnpm exec tsx --env-file=../../.env src/scripts/eval-seed-breadth.ts

import { generateSeedCandidates, type WatchTopic } from "../services/radar-setup-bot.js";

const TRIALS = Number(process.env.TRIALS ?? 8);
const COMPANY_ID = Number(process.env.COMPANY_ID ?? 2);
const USER_ID = Number(process.env.USER_ID ?? 1);

// Company 2's actual brief + watch topics, as committed in
// tp_seed_candidates (id=4, status="committed", created 2026-07-22).
// Fetched read-only; not re-queried per trial so the eval is deterministic
// about its INPUT and only measures variance in the model's OUTPUT.
const BRIEF = `Fast Food LATAM tracks emerging consumer food and beverage trends across the quick-service restaurant (QSR) and fast-food industry in Latin America. The company advises fast-food brands, franchises and food-service operators on which flavours, ingredients, formats and consumption habits are gaining momentum with consumers across markets including Mexico, Brazil, Argentina, Colombia, Chile and Peru. The focus is on early, trackable shifts in what people are actually eating and drinking, not on brand sentiment, pricing or promotions. Priority areas include sauces and dipping condiments, rising flavour profiles, protein preferences across chicken, beef and plant-based options, breakfast and coffee habits, and the food-delivery apps shaping how fast food reaches consumers. The radar surfaces specific ingredients, flavours, formats and occasions rising in social conversation so operators can act before a trend goes mainstream.`;

const WATCH_TOPICS: WatchTopic[] = [
  {
    title: "Sauces and dipping in Latin America",
    description: "Emerging sauces, dips and condiments used with fast food across LATAM markets.",
  },
  {
    title: "Flavours gaining popularity in Latin America",
    description: "Specific flavour profiles rising in fast-food and snack conversation across LATAM.",
  },
  {
    title: "Chicken, beef and plant-based protein preferences in Latin America",
    description: "Shifts in protein choice across chicken, beef and plant-based fast-food options.",
  },
  {
    title: "Breakfast and coffee consumption in Latin America",
    description: "Rising breakfast items and coffee formats/habits in LATAM fast food.",
  },
  {
    title: "Food delivery apps in Latin America",
    description: "Delivery apps and ordering behaviours shaping fast-food consumption in LATAM.",
  },
];

// If a label contains one of these, the model named an instance, not a category.
const INSTANCE_MARKERS = [
  "pistachio cream", "spicy mayo", "chimichurri", "avocado sauce",
  "guacamole", "sriracha", "pesto", "nutella", "aioli",
];

async function main() {
  console.log(`seed-breadth eval — company ${COMPANY_ID} x ${TRIALS} trials\n`);

  let totalLabels = 0;
  let instanceLabels = 0;

  for (let i = 0; i < TRIALS; i++) {
    const { seedItems } = await generateSeedCandidates(BRIEF, COMPANY_ID, USER_ID, WATCH_TOPICS);
    console.log(`trial ${i + 1}: ${seedItems.length} seeds`);
    for (const s of seedItems) {
      totalLabels++;
      const l = String(s.label ?? "").toLowerCase();
      const hit = INSTANCE_MARKERS.find((m) => l.includes(m));
      if (hit) {
        instanceLabels++;
        console.log(`  [instance] ${s.label}  (matched "${hit}")`);
      }
    }
  }

  const pct = totalLabels ? (100 * instanceLabels) / totalLabels : 0;
  console.log(`\n${TRIALS} trials | ${totalLabels} labels | ${instanceLabels} instance-level (${pct.toFixed(1)}%)`);
  console.log(pct <= 10 ? "PASS — seeds are category-level" : "FAIL — still naming specific products");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
