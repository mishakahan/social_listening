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
- Seeds must cover their watch topic BROADLY at category level, so that specific products can be discovered from the data rather than named up front.`
    : `- Cover all strategicPriorities at least once`;

  const systemPrompt = `You are a trend-intelligence analyst building a social-listening seed list for ${companyName}.

Company context:
${JSON.stringify(ctx, null, 2)}
${watchTopicsBlock}
Generate exactly ${targetCount} seed items. Each seed is a CATEGORY of conversation to sweep on social media, not a specific product.

For each seed, produce:
- label: short descriptive category label (e.g. "Chocolate IT", "Condiments MX")
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
- Stay at CATEGORY level: "chocolate" not "pistachio cream", "condiments" not "spicy mayo".
  Naming a specific product here pre-decides the answer — the specific trends must
  come OUT of the scraped conversation, not go IN as a guess.
- Keywords within a seed should be broad entry points into that category
  (the category name, how people talk about it, common adjacent terms) rather
  than an enumeration of specific products.
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
   These stay broad on purpose: hashtag scrapes are billed per tag, so this list
   must stay SHORT — quality over coverage.
   A hashtag qualifies only if real people already tag posts with it. Test it by
   asking "would I find thousands of existing posts under this tag?".
   - Single token, lowercase, letters/digits only. No spaces, underscores or
     punctuation: platforms match the tag literally, so "#gummy bears" and
     "#functional_gummies" match nothing.
   - NEVER coin a tag out of the company's own vertical, positioning or
     strategic priorities. Those are internal business language, not words the
     public tags posts with (e.g. "premiumgifting", "functionalwellness").
   - Prefer the obvious, high-volume category tags over clever niche ones.

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
  A type belongs in every language's list; only its NAME changes. Never drop a
  type from a language for being foreign to it.
  For each language, write what a native speaker would actually type into
  search. Decide per item:
    * The language has its own everyday word for it -> USE THAT WORD. Do not
      leave the English in. In Italian, "gummy bears" is "orsetti gommosi",
      "sour gummies" is "caramelle gommose acide", "sleep gummies" is "gomme
      per il sonno". A list of English terms under a non-English language is
      WRONG, even where the English is understood.
    * It is a proper or protected name, or the language simply borrows it ->
      keep the original (soju, mochi, pisco, lokum, champagne). Only genuine
      borrowings, not laziness: if a plain local phrase exists, that phrase wins.
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
  // Unioning passes on the exact string leaves near-duplicates that are the same
  // search: "whiskey"/"whisky", "protein powder"/"protein powders",
  // "pâte de fruit"/"pate de fruit". Normalise accents, plurals and spelling
  // variants so one search term survives per real concept.
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^#/, "")
      // strip accents: pâte -> pate
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      // per-word singularise, so "protein powders" == "protein powder".
      // Deliberately crude: only trailing "s"/"es" on words long enough that
      // removing it cannot collide with a different word.
      .map((w) => {
        if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
        if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
        return w;
      })
      // English spelling variants that are the same search.
      .map((w) => (w === "whisky" ? "whiskey" : w))
      .join(" ");

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
    // Format/jargon rules first (cheap, deterministic), then ask the model which
    // of the survivors are tags people genuinely use.
    const formatted = sanitizeHashtags(
      [...(hashtags.get(language)?.values() ?? [])],
      ctx
    );
    const tags = await filterHashtagsToReal(seed.label, language, formatted);
    out.push({ language, keywords: kept, hashtags: tags });
  }
  logger.info(
    {
      label: seed.label,
      languages: out.map((o) => `${o.language}:${o.keywords.length}kw/${o.hashtags.length}tag`),
    },
    "Fan-out complete"
  );
  return out;
}

// Hashtags are billed per tag on IG and matched literally by every platform, so
// a malformed or invented tag is money spent to scrape nothing. This is a
// mechanical format rule, so enforce it in code rather than hoping the model
// complies:
//   - platforms have no spaces/underscores/punctuation in tags, so anything
//     carrying them ("gummy bears", "functional_gummies") matches zero posts;
//   - tags coined from the client's own positioning ("premiumgifting",
//     "functionalwellness") are internal business language nobody tags with;
//   - the union across passes inflates the list, and IG cost scales with it.
const FANOUT_MAX_HASHTAGS = Number(process.env.FANOUT_MAX_HASHTAGS ?? "6") || 6;

function sanitizeHashtags(tags: string[], ctx: CompanyContext): string[] {
  // Individual words lifted from the client's strategy deck. Note these are NOT
  // banned on their own: "wellness" and "gifting" are ordinary high-volume tags
  // that millions of real posts use. Only their CONCATENATION is the giveaway —
  // "premium gifting" coming back as "premiumgifting" is the model echoing the
  // brief, and no member of the public tags a post that way.
  const jargonWords = [
    ...ctx.strategicPriorities,
    ctx.brandPositioning ?? "",
  ]
    .flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/))
    .filter((w) => w.length > 3);

  // Tags arrive as one token, so a coined compound can only be caught by trying
  // to segment it back into two or more of those words.
  const isCoinedCompound = (tag: string): boolean => {
    const canSegment = (rest: string, used: number): boolean => {
      if (rest.length === 0) return used >= 2;
      return jargonWords.some(
        (w) => rest.startsWith(w) && canSegment(rest.slice(w.length), used + 1)
      );
    };
    return canSegment(tag, 0);
  };

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#/, "").toLowerCase();
    // Platforms match tags literally: reject rather than mangle, since silently
    // stripping a space invents a tag the model never proposed.
    if (!/^[a-z0-9]+$/.test(tag)) continue;
    if (tag.length < 3 || tag.length > 30) continue;
    if (isCoinedCompound(tag)) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  // Earlier passes hold the model's highest-confidence, highest-volume tags.
  return out.slice(0, FANOUT_MAX_HASHTAGS);
}

// sanitizeHashtags only knows the client's own (English) jargon, so coinages in
// other languages sail through: "gommefunzionali", "gommialcollagene",
// "gommestudio" — grammatical-looking Italian that nobody actually tags. A tag
// nobody uses is an IG scrape billed to return nothing, so ask the model to
// judge which tags are real. Same shape as the keyword judge: temperature 0,
// fails open, refuses to gut the list.
async function filterHashtagsToReal(
  topic: string,
  language: string,
  tags: string[]
): Promise<string[]> {
  if (tags.length === 0) return tags;
  const prompt = `You are validating hashtags for social scraping on the topic "${topic}".

For EACH hashtag, decide whether it is a tag REAL PEOPLE ALREADY USE — one that
would return a substantial body of existing posts on Instagram or TikTok.

Drop a hashtag if it was invented for this list: grammatical-looking compounds
that nobody actually types ("gommefunzionali", "gommialcollagene"), or coinages
that are not real words at all ("gommestudio").
Keep the obvious, high-volume tags even when they are generic ("gummies",
"chocolate", "wellness", "cioccolato"). Common beats clever: a broad tag people
really use is exactly what we want.
Tags are in ${language} — judge against how speakers of that language tag posts.

Hashtags:
${tags.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Return JSON: { "verdicts": [{ "i": <number>, "keep": <boolean> }] }, one entry
per hashtag, in order.`;
  try {
    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "Validate the hashtags." },
      ],
    });
    const text = response.choices[0]?.message?.content ?? "";
    const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/```$/m, "").trim();
    const parsed = JSON.parse(cleaned) as { verdicts?: { i: number; keep: boolean }[] };
    const drop = new Set(
      (parsed.verdicts ?? []).filter((v) => v && v.keep === false).map((v) => v.i - 1)
    );
    const kept = tags.filter((_, i) => !drop.has(i));
    // Every tag rejected means the judgment is broken, not the list. Also keep
    // at least one: a query with no hashtags cannot scrape IG or TikTok at all.
    if (kept.length === 0) {
      logger.warn({ topic, language }, "Hashtag judge rejected everything — ignoring");
      return tags;
    }
    if (drop.size > 0) {
      logger.info(
        { topic, language, dropped: tags.filter((_, i) => drop.has(i)) },
        "Hashtags dropped as not-real"
      );
    }
    return kept;
  } catch (err) {
    logger.warn({ err, topic }, "Hashtag judge failed — keeping all");
    return tags;
  }
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

Keep a keyword only if ALL THREE tests pass. Drop it if any fails.

TEST 1 — category membership. The plain statement "<keyword> is a kind of
${topic}" must be literally true. Interpret the topic literally, including any
exclusion built into its name (for "non-alcoholic beverages", plain "beer" or
"soju" are NOT kinds of it, while "non-alcoholic beer" is).

TEST 2 — not a single company's product. Drop the keyword only if it names a
specific COMPANY or that company's product line ("Haribo gummies", "Coca-Cola"
fail). Brands are what this system discovers downstream, so one as a search
term defeats the point.
This test is ONLY about company ownership. A keyword is fine — and must be kept
— when many different producers make it, even if its name is a proper noun, a
place, a protected origin or a foreign word: soju, pisco, champagne, prosecco,
baijiu, cachaça, Turkish delight and Belgian chocolate ALL PASS, because no
single company owns them. If unsure whether it is a company, keep it.

TEST 3 — a real thing, not a plausible-sounding invention. The keyword must be
something that actually exists and is sold or made in the world, such that real
people already post about it. Generation pads thin categories by combining the
topic with an arbitrary flavour or ingredient, producing terms nobody has ever
used ("gommose al pomodoro" / tomato gummies, "gommose ai funghi" / mushroom
gummies). Ask: have I actually encountered this product, or am I only agreeing
it sounds constructible? If the latter, drop it.
Be careful in BOTH directions: a genuinely traditional item is real however
obscure it sounds (Turkish lokum, Mexican pulparindo, aam papad, pâte de fruit
ALL PASS). The test is existence, not familiarity. If a real product plausibly
exists under this name, keep it — only drop inventions.

Keywords may be in ${language}; judge their meaning. Judge ONLY these three
tests — never drop a keyword merely for being niche, regional, traditional or
unfamiliar. Obscurity is the signal we are hunting for; invention is not.

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
