import OpenAI from "openai";
import { logger } from "../lib/logger.js";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set. Add it to your .env file.");
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

export interface CompanyContext {
  companyName: string | null;
  vertical: string | null;
  clientSegments: string[];
  productCategories: string[];
  targetGeographies: string[];
  operationalCapabilities: string[];
  ipAssets: string[];
  distributionNetworks: string[];
  skillsAndHr: string[];
  supplyChain: string[];
  namedClients: string[];
  namedCompetitors: string[];
  strategicPriorities: string[];
  brandPositioning: string | null;
  brandingGuidelines: string | null;
  npdPhases: string[];
  innovationPhases: string[];
}

export interface WatchTopic {
  title: string;
  description: string;
}

export interface SeedCandidateItem {
  label: string;
  description: string;
  geography: string;
  productCategoryLink: string;
  territoryTag: string;
  strategicCentrality: number;
  actionableAt: string;
  groundedIn: string[];
  // Title of the user-supplied watch topic this seed ladders up to. Undefined
  // when generation was brief-only (no watch topics provided).
  watchTopic?: string;
  seedQueries: { language: string; keywords: string[]; hashtags: string[] }[];
}

// ---------------------------------------------------------------------------
// parseBriefToCompanyContext
// ---------------------------------------------------------------------------

const BRIEF_PARSE_SYSTEM_PROMPT = `You will be given a free-form company brief. Extract the following fields as JSON. If a field is not mentioned, set it to null (single values) or [] (arrays). Do not invent data. Be faithful to what the brief says.

Fields:
- companyName: string | null
- vertical: string | null
- clientSegments: string[]
- productCategories: string[]
- targetGeographies: string[]
- operationalCapabilities: string[]
- ipAssets: string[]
- distributionNetworks: string[]
- skillsAndHr: string[]
- supplyChain: string[]
- namedClients: string[]
- namedCompetitors: string[]
- strategicPriorities: string[]
- brandPositioning: string | null
- brandingGuidelines: string | null
- npdPhases: string[]
- innovationPhases: string[]

Return JSON only. Do not include prose.`;

async function parseJsonWithRetry<T>(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  retries = 2
): Promise<T> {
  let lastError: unknown;
  let currentMessages = [...messages];

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: currentMessages,
    });

    const text = response.choices[0]?.message?.content ?? "";
    try {
      // Strip markdown code fences if present
      const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/```$/m, "").trim();
      return JSON.parse(cleaned) as T;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        logger.warn({ attempt }, "JSON parse failed, retrying with fix-up prompt");
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: text },
          {
            role: "user",
            content:
              "The JSON you returned is invalid. Please fix it and return valid JSON only, no prose or markdown.",
          },
        ];
      }
    }
  }

  throw new Error(`Failed to parse JSON after ${retries + 1} attempts: ${lastError}`);
}

export async function parseBriefToCompanyContext(
  brief: string
): Promise<CompanyContext> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: BRIEF_PARSE_SYSTEM_PROMPT },
    { role: "user", content: brief },
  ];

  const ctx = await parseJsonWithRetry<CompanyContext>(messages);

  // Validate
  if (!ctx.targetGeographies || ctx.targetGeographies.length === 0) {
    throw new Error(
      "Please mention at least one target geography in your brief (country or region)."
    );
  }
  if (!ctx.productCategories || ctx.productCategories.length === 0) {
    throw new Error("Please mention the product categories you work with.");
  }
  if (!ctx.strategicPriorities || ctx.strategicPriorities.length === 0) {
    ctx.strategicPriorities = [...ctx.productCategories];
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// computeTargetSeedCount
// ---------------------------------------------------------------------------

export function computeTargetSeedCount(ctx: CompanyContext): number {
  const base = Math.max(4, ctx.strategicPriorities.length * 3);
  const geoMult = Math.min(ctx.targetGeographies.length, 4);
  const catMult = Math.min(ctx.productCategories.length, 3);
  const result = (base * geoMult * catMult) / 6;
  return Math.round(Math.min(45, Math.max(12, result)));
}

// ---------------------------------------------------------------------------
// generateSeedItems
// ---------------------------------------------------------------------------

export async function generateSeedItems(
  ctx: CompanyContext,
  targetCount: number,
  watchTopics: WatchTopic[] = []
): Promise<SeedCandidateItem[]> {
  const companyName = ctx.companyName ?? "this company";
  const hasWatchTopics = watchTopics.length > 0;

  const watchTopicsBlock = hasWatchTopics
    ? `
The user has supplied these strategic WATCH TOPICS. They are the anchoring themes
for this radar — every seed you generate MUST ladder up to exactly one of them:
${watchTopics
  .map(
    (t, i) =>
      `${i + 1}. "${t.title}"${t.description ? ` — ${t.description}` : ""}`
  )
  .join("\n")}
`
    : "";

  const watchTopicField = hasWatchTopics
    ? `- watchTopic: the EXACT title of the watch topic this seed ladders up to. Must be copied verbatim from one of the watch topic titles listed above.
`
    : "";

  const watchTopicRules = hasWatchTopics
    ? `- Every watch topic above MUST be covered by at least two seeds; distribute the ${targetCount} seeds across all of them.
- Each seed must set watchTopic to exactly one of the provided watch topic titles (verbatim).
- Seeds must concretely operationalize their watch topic into specific, trackable social-listening topics.`
    : `- Cover all strategicPriorities at least once`;

  const systemPrompt = `You are a trend-intelligence analyst building a social-listening seed list for ${companyName}.

Company context:
${JSON.stringify(ctx, null, 2)}
${watchTopicsBlock}
Generate exactly ${targetCount} seed items. Each seed is a specific topic to track on social media.

For each seed, produce:
- label: short descriptive label (e.g. "Pistachio cream IT", "Functional chocolate DE")
- description: 1-2 sentences explaining what this topic covers and why it's relevant
- geography: one of the targetGeographies (ISO-2 code) or "GLOBAL"
- productCategoryLink: closest product category from: productCategories or ["chocolate","confectionery","gifting","functional-food","beverage","snack","other"]
- territoryTag: one of: "functional-health", "gifting", "next-gen-consumers", "premium", "format-innovation", "other"
- strategicCentrality: integer 0-100 (how central to the company's strategic priorities; 80-100 = core, 50-79 = relevant, 20-49 = adjacent)
- actionableAt: one of: "ingredient", "format", "claim", "occasion", "brand"
- groundedIn: array of CompanyContext field names that justify this seed (e.g. ["strategicPriorities", "productCategories"])
${watchTopicField}- seedQueries: one entry per relevant language for this geography. Language mapping:
  - IT → [{ language: "it", ... }]
  - DE → [{ language: "de", ... }]
  - CN → [{ language: "zh-CN", ... }]
  - GLOBAL → [{ language: "en", ... }]
  - FR → [{ language: "fr", ... }]
  - Each entry has: keywords (5-8 phrases in that language), hashtags (5-8 hashtags in that language, no # prefix)

Rules:
- Cover all targetGeographies at least once
${watchTopicRules}
- Distribute seeds across different territory tags
- Be specific and concrete: "pistachio cream" not just "chocolate"
- Return JSON array only`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Generate the seed items array as JSON.` },
  ];

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages,
  });

  const text = response.choices[0]?.message?.content ?? "[]";
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/```$/m, "").trim();
  return JSON.parse(cleaned) as SeedCandidateItem[];
}

// ---------------------------------------------------------------------------
// generateSeedCandidates (main)
// ---------------------------------------------------------------------------

export async function generateSeedCandidates(
  brief: string,
  companyId: number,
  userId: number,
  watchTopics: WatchTopic[] = []
): Promise<{ companyContext: CompanyContext; seedItems: SeedCandidateItem[] }> {
  logger.info(
    { companyId, userId, watchTopicCount: watchTopics.length },
    "Generating seed candidates from brief"
  );

  const companyContext = await parseBriefToCompanyContext(brief);
  logger.info({ companyId }, "Brief parsed to company context");

  // When watch topics are supplied, scale the seed count to the number of
  // topics (~4 seeds per topic) so each anchoring theme gets meaningful
  // coverage; otherwise fall back to the context-derived heuristic.
  let targetCount = computeTargetSeedCount(companyContext);
  if (watchTopics.length > 0) {
    targetCount = Math.min(45, Math.max(12, watchTopics.length * 4));
  }
  logger.info({ companyId, targetCount }, "Target seed count computed");

  const seedItems = await generateSeedItems(
    companyContext,
    targetCount,
    watchTopics
  );
  logger.info({ companyId, seedCount: seedItems.length }, "Seed items generated");

  return { companyContext, seedItems };
}

// ---------------------------------------------------------------------------
// generateScoutQueriesForSeed
// ---------------------------------------------------------------------------

// Fan-out passes: one LLM call is not enough. The model is non-deterministic,
// so each pass returns a partly different slice of the taxonomy — the stable
// canon every time, plus a rotating tail of rarer types. Unioning several
// passes is what surfaces the long tail (soju, gochujang, pulque) that a
// single pass misses. Measured: pass 1 yields ~20-29 terms; pass 2 adds
// 50-70% new; passes 3-5 ~30% each; by pass 7 it is 5-10%. We therefore stop
// when a pass stops paying for itself rather than guessing a count per topic —
// specificity of the topic does NOT predict how many passes it needs
// ("Colombian coffee" needed more than "Coffee", not fewer).
const FANOUT_MAX_PASSES = Number(process.env.FANOUT_MAX_PASSES ?? "6") || 6;
// Stop once a pass contributes less than this share of new terms.
const FANOUT_MIN_NEW_RATIO = 0.1;
// ...but never before this many passes. The model empties the obvious canon
// first (beer, wine, whiskey) and only reaches the regional tail once that is
// exhausted: measured, soju and baijiu first appear on pass 3, and pass 2 can
// dip under the ratio while the tail is still unreached. Stopping on that dip
// silently loses exactly the long tail the fan-out exists to find.
const FANOUT_MIN_PASSES = 3;

function buildFanoutPrompt(
  seed: SeedCandidateItem,
  ctx: CompanyContext,
  languages: string
): string {
  const priorities = ctx.strategicPriorities.length
    ? ctx.strategicPriorities.join(", ")
    : "none stated";
  return `You are building social-listening search queries for a market-research engine.

Topic (the ONLY thing the client told us): ${seed.label}
Geography: ${seed.geography}
Territory: ${seed.territoryTag}
Product category: ${seed.productCategoryLink}
Company vertical: ${ctx.vertical ?? "unknown"}
Company strategic priorities: ${priorities}

The client does NOT know what is trending. Your job is to decide WHERE to look.
Do not narrow to the company's own products: we are scanning the whole category
they compete in. Use the company context only to disambiguate what the topic
means, never to filter the taxonomy down to what they already sell.

Produce two lists:
1. "keywords": SPECIFIC SUB-CATEGORIES / TYPES under this topic.
   Cover these, roughly evenly, but ONLY where they genuinely exist:
    a) the mainstream / long-established types
    b) REGIONAL and TRADITIONAL types from every continent, including ones
       little known in the US/Europe
    c) EMERGING or ADJACENT types: recent hybrids, kinds that only became
       popular recently, variants defined by a distinct positioning or attribute
2. "hashtags": 4-6 BROAD, same-level hashtags for the category (no leading #).
   These stay broad on purpose: hashtag scrapes are billed per tag.

HARD RULES:
- STAY INSIDE THE TOPIC. Every keyword must be a kind of "${seed.label}" itself,
  such that "<keyword> is a type of ${seed.label}" is plainly true. Do not drift
  into neighbouring or parent categories, however related. Test each item before
  including it: if it belongs under a different topic, drop it — that topic is
  searched separately, and duplicating it here wastes budget and pollutes the
  results.
- If the topic is defined by NOT having some property, that exclusion is binding:
  every keyword must actually lack it. Something that merely has a version with
  the property removed only qualifies as that removed version, named explicitly
  (for the topic "non-alcoholic beverages": "non-alcoholic beer" qualifies,
  plain "beer" and "soju" do not).
- Every keyword must be a GENERIC KIND OF THING, never a brand, company, or
  product line. Brands are what we DISCOVER later, not what we search for.
- Every keyword must be a real, established term people actually use. Do NOT
  invent plausible-sounding types to fill a bucket. If a category has no
  regional variation, skip (b) entirely and return fewer items.
- A shorter accurate list beats a padded one. Aim for 20-30 keywords only if
  that many real ones exist.
- Build the taxonomy FIRST, then write it out once per language listed below.
  A type belongs in every language's list; only its spelling changes. Give the
  name speakers of that language actually use — which for a foreign type is
  usually the original name kept as-is (soju stays "soju"). Never drop a type
  from a language for being foreign to it, and never translate a name that
  speakers do not translate.
- Think taxonomy, not marketing.

Languages needed: ${languages}

Return JSON: { results: [{ language: string, keywords: string[], hashtags: string[] }] }`;
}

type ScoutQuerySet = { language: string; keywords: string[]; hashtags: string[] };

async function runFanoutPass(prompt: string): Promise<ScoutQuerySet[]> {
  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    // Higher than the old 0.4: we WANT variation across passes, since the union
    // is the point. Determinism here would defeat the fan-out.
    temperature: 0.7,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: "Generate the scout queries." },
    ],
  });
  const text = response.choices[0]?.message?.content ?? '{"results":[]}';
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/```$/m, "").trim();
  const parsed = JSON.parse(cleaned) as { results?: ScoutQuerySet[] };
  return parsed.results ?? [];
}

export async function generateScoutQueriesForSeed(
  seed: SeedCandidateItem,
  ctx: CompanyContext
): Promise<ScoutQuerySet[]> {
  const languages = seed.seedQueries.map((q) => q.language).join(", ");
  const prompt = buildFanoutPrompt(seed, ctx, languages);

  // language -> canonical(term) -> first-seen original casing
  const keywords = new Map<string, Map<string, string>>();
  const hashtags = new Map<string, Map<string, string>>();
  const norm = (s: string) => s.trim().toLowerCase().replace(/^#/, "");

  const absorb = (
    into: Map<string, Map<string, string>>,
    lang: string,
    values: unknown
  ): number => {
    if (!Array.isArray(values)) return 0;
    const bucket = into.get(lang) ?? new Map<string, string>();
    into.set(lang, bucket);
    let added = 0;
    for (const raw of values) {
      if (typeof raw !== "string") continue;
      const value = raw.trim().replace(/^#/, "");
      const key = norm(raw);
      if (!key || bucket.has(key)) continue;
      bucket.set(key, value);
      added++;
    }
    return added;
  };

  for (let pass = 0; pass < FANOUT_MAX_PASSES; pass++) {
    let results: ScoutQuerySet[];
    try {
      results = await runFanoutPass(prompt);
    } catch (err) {
      // A failed pass is survivable: keep whatever earlier passes produced
      // rather than losing the whole seed to one bad response.
      logger.warn({ err, label: seed.label, pass }, "Fan-out pass failed");
      continue;
    }

    let seen = 0;
    let added = 0;
    for (const r of results) {
      if (!r?.language) continue;
      seen += Array.isArray(r.keywords) ? r.keywords.length : 0;
      added += absorb(keywords, r.language, r.keywords);
      absorb(hashtags, r.language, r.hashtags);
    }

    // Stop when the pass stopped paying for itself, but only once we are past
    // the canon-dumping passes (see FANOUT_MIN_PASSES).
    if (pass + 1 >= FANOUT_MIN_PASSES && (seen === 0 || added / seen < FANOUT_MIN_NEW_RATIO)) {
      logger.info(
        { label: seed.label, passes: pass + 1, added, seen },
        "Fan-out saturated"
      );
      break;
    }
  }

  const out: ScoutQuerySet[] = [];
  for (const [language, bucket] of keywords) {
    const all = [...bucket.values()];
    const { kept, dropped } = await filterKeywordsToTopic(seed.label, language, all);
    if (dropped.length > 0) {
      logger.info(
        { label: seed.label, language, dropped },
        "Fan-out keywords dropped by topic filter"
      );
    }
    out.push({
      language,
      keywords: kept,
      hashtags: [...(hashtags.get(language)?.values() ?? [])],
    });
  }
  logger.info(
    { label: seed.label, languages: out.map((o) => `${o.language}:${o.keywords.length}`) },
    "Fan-out complete"
  );
  return out;
}

// Post-filter: generation keeps drifting across topic boundaries on rare terms
// (bare "soju" under "Non-alcoholic beverages" survived prompt tuning in ~1/3
// of runs), and hardening the generation prompt further hit diminishing
// returns. Verification is a far easier task than generation, so after the
// union we ask the model to JUDGE each keyword against the literal topic and
// drop the failures. Temperature 0 — judging needs no creativity. Applies to
// keywords only: hashtags are deliberately broad, and category-membership
// judgment would over-drop them.
async function filterKeywordsToTopic(
  topic: string,
  language: string,
  kws: string[]
): Promise<{ kept: string[]; dropped: string[] }> {
  if (kws.length === 0) return { kept: [], dropped: [] };
  const prompt = `You are validating search keywords for the topic "${topic}".

For EACH keyword below, answer whether the plain statement
"<keyword> is a kind of ${topic}" is literally true.

Interpret the topic literally, including any exclusion built into its name
(for "non-alcoholic beverages", plain "beer" or "soju" are NOT kinds of it,
while "non-alcoholic beer" is). Keywords may be in ${language}; judge their
meaning. Judge ONLY category membership — never drop a keyword for being
niche, regional, or unfamiliar.

Keywords:
${kws.map((k, i) => `${i + 1}. ${k}`).join("\n")}

Return JSON: { "verdicts": [{ "i": <number>, "keep": <boolean> }] } with one
entry per keyword, in order.`;
  try {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "Validate the keywords." },
      ],
    });
    const text = response.choices[0]?.message?.content ?? "";
    const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/```$/m, "").trim();
    const parsed = JSON.parse(cleaned) as {
      verdicts?: { i: number; keep: boolean }[];
    };
    const drop = new Set(
      (parsed.verdicts ?? [])
        .filter((v) => v && v.keep === false)
        .map((v) => v.i - 1)
    );
    const kept: string[] = [];
    const dropped: string[] = [];
    kws.forEach((k, idx) => (drop.has(idx) ? dropped : kept).push(k));
    // Refuse mass-drops: if the judge rejects most of the list, the judgment is
    // what's broken, not the list. Keep everything rather than gut the query.
    if (dropped.length > kws.length / 2) {
      logger.warn(
        { topic, dropped: dropped.length, total: kws.length },
        "Topic filter rejected majority of keywords — ignoring filter"
      );
      return { kept: kws, dropped: [] };
    }
    return { kept, dropped };
  } catch (err) {
    // Fail open, matching the gate's specificity check: losing the filter for
    // one run is fine, losing the whole query set is not.
    logger.warn({ err, topic }, "Topic filter failed — keeping all keywords");
    return { kept: kws, dropped: [] };
  }
}
