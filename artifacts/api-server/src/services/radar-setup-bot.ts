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

export interface SeedCandidateItem {
  label: string;
  description: string;
  geography: string;
  productCategoryLink: string;
  territoryTag: string;
  strategicCentrality: number;
  actionableAt: string;
  groundedIn: string[];
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
  targetCount: number
): Promise<SeedCandidateItem[]> {
  const companyName = ctx.companyName ?? "this company";
  const systemPrompt = `You are a trend-intelligence analyst building a social-listening seed list for ${companyName}.

Company context:
${JSON.stringify(ctx, null, 2)}

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
- seedQueries: one entry per relevant language for this geography. Language mapping:
  - IT → [{ language: "it", ... }]
  - DE → [{ language: "de", ... }]
  - CN → [{ language: "zh-CN", ... }]
  - GLOBAL → [{ language: "en", ... }]
  - FR → [{ language: "fr", ... }]
  - Each entry has: keywords (5-8 phrases in that language), hashtags (5-8 hashtags in that language, no # prefix)

Rules:
- Cover all targetGeographies at least once
- Cover all strategicPriorities at least once
- Distribute seeds across different territory tags
- Be specific and concrete: "pistachio cream" not just "chocolate"
- Return JSON array only`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Generate the seed items array as JSON.` },
  ];

  const response = await openai.chat.completions.create({
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
  userId: number
): Promise<{ companyContext: CompanyContext; seedItems: SeedCandidateItem[] }> {
  logger.info({ companyId, userId }, "Generating seed candidates from brief");

  const companyContext = await parseBriefToCompanyContext(brief);
  logger.info({ companyId }, "Brief parsed to company context");

  const targetCount = computeTargetSeedCount(companyContext);
  logger.info({ companyId, targetCount }, "Target seed count computed");

  const seedItems = await generateSeedItems(companyContext, targetCount);
  logger.info({ companyId, seedCount: seedItems.length }, "Seed items generated");

  return { companyContext, seedItems };
}

// ---------------------------------------------------------------------------
// generateScoutQueriesForSeed
// ---------------------------------------------------------------------------

export async function generateScoutQueriesForSeed(
  seed: SeedCandidateItem,
  ctx: CompanyContext
): Promise<{ language: string; keywords: string[]; hashtags: string[] }[]> {
  const languages = seed.seedQueries.map((q) => q.language).join(", ");

  const systemPrompt = `For the following topic, generate social-listening search queries.

Topic: ${seed.label}
Geography: ${seed.geography}
Territory: ${seed.territoryTag}
Product category: ${seed.productCategoryLink}
Company vertical: ${ctx.vertical}
Company strategic priorities: ${ctx.strategicPriorities.join(", ")}

For each language listed below, produce:
- 5-10 keywords (no hashtag prefix) — phrases that would appear in organic social posts about this topic, native to the language
- 5-10 hashtags (no leading #) — hashtags that native speakers would actually use on IG/TikTok for this topic

Languages needed: ${languages}

Rules:
- All keywords and hashtags MUST be in the specified language
- No generic single-word hashtags. Combine with qualifiers
- Prefer phrases indicating consumer discovery or discussion
- Return JSON: { results: [{ language: string, keywords: string[], hashtags: string[] }] }`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Generate the scout queries." },
    ],
  });

  const text = response.choices[0]?.message?.content ?? '{"results":[]}';
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/```$/m, "").trim();
  const parsed = JSON.parse(cleaned) as {
    results: { language: string; keywords: string[]; hashtags: string[] }[];
  };
  return parsed.results;
}
