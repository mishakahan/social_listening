// Specificity check (the systematic relevance pass that replaces a manual
// blocklist). Answers: is this a SPECIFIC, trackable trend, or is it something
// that will look like it's rising no matter what we scrape?
//
// TWO INDEPENDENT AXES (they fail differently, so we ask them separately):
//   1. everydayGeneric  — a kitchen staple / everyday word ("salt", "water").
//   2. categoryStaple   — names a whole product CATEGORY, or is that category's
//      archetypal member or synonymous brand ("gummy bears", "haribo",
//      "caramelle gommose" = literally "gummy candies"). Always popular, so an
//      apparent rise mostly reflects how the scrape is weighted, not a trend.
// An entity is specific only if BOTH are false.
//
// Axis 2 exists because the fan-out surfaces generic-in-that-space items: of
// "gummy bears"' 73 mentions, 62 came from the Gummies scout queries. Whatever
// a client watches, the category's default terms will float up.
//
// HISTORY — the failure mode to not re-introduce: an earlier single-axis prompt
// over-rejected real ingredient trends (Magnesium/Zinc/Iron), so it was told
// "trending ingredients count as specific" (33e6b43) and then let anything
// product-shaped through. Axis 2 is deliberately about being the CATEGORY'S
// NAME, not about being well known — creatine is famous but is not a category.
//
// The pure decision logic lives here (testable). The LLM call + cache is thin
// I/O in judgeSpecificityBatch below.

import OpenAI from "openai";

export interface SpecificityResult {
  specific: boolean;
  reason: string;
}

export interface RawSpecificityVerdict {
  everydayGeneric?: unknown;
  categoryStaple?: unknown;
  reason?: unknown;
  // legacy single-axis shape, still read so cached verdicts don't break
  specific?: unknown;
}

// Pure: combine the two axes into a keep/drop decision. Defensive so a
// malformed response defaults to KEEPING the entity (never silently drop on a
// parse error — a generic word slipping through is safer than losing a real one).
export function interpretSpecificityVerdict(
  raw: RawSpecificityVerdict | null | undefined
): SpecificityResult {
  if (!raw) return { specific: true, reason: "no verdict (kept by default)" };

  const everydayGeneric = raw.everydayGeneric === true;
  const categoryStaple = raw.categoryStaple === true;
  const reason = typeof raw.reason === "string" ? raw.reason : "";

  // Neither axis came back as a usable boolean -> fall back to the legacy
  // `specific` field, then to keep-by-default.
  if (typeof raw.everydayGeneric !== "boolean" && typeof raw.categoryStaple !== "boolean") {
    if (typeof raw.specific === "boolean") return { specific: raw.specific, reason };
    return { specific: true, reason: "no verdict (kept by default)" };
  }

  if (everydayGeneric || categoryStaple) {
    const axis = everydayGeneric ? "everyday generic" : "category-wide staple";
    return { specific: false, reason: reason || axis };
  }
  return { specific: true, reason };
}

export const SPECIFICITY_SYSTEM_PROMPT = `You screen terms for a social-listening trend radar. For each term answer TWO INDEPENDENT questions. Answer each one on its own; a term can be false on both.

QUESTION 1 — everydayGeneric
Is this a kitchen staple or everyday word so broad that it is just background chatter and never a trend on its own?
true: "water", "salt", "sugar", "flour", "bread", "butter", "rice", "milk", "coffee", "food", "drink", "snack", "chicken", "spoon", "napkin", "plate", "healthy", "wellness", "weight loss".
false: anything with a nameable identity, however humble.

QUESTION 2 — categoryStaple
Does this term NAME A WHOLE PRODUCT CATEGORY, or is it that category's archetypal default member or the brand people use as a synonym for the category? Such terms are steadily popular year after year, so a rise in their mention count mostly reflects how much of that category we happened to collect, not a real emerging trend.
true: "gummy bears" (the default gummy sweet), "haribo" (the brand that stands in for gummy candy), "caramelle gommose" (Italian for "gummy candies", i.e. the category name itself), "gummies", "candy", "chocolate", "beer", "wine", "vodka", "whiskey", "soda", "cookies", "chips", "cereal", "protein powder", "vitamins", "supplements".
false: "creatine", "magnesium", "zinc", "iron", "folate", "vitamin d3", "vitamin k2", "ashwagandha", "collagen", "biotin", "whey protein" — each is one named compound inside a category, not the category. Also false: "juneshine", "athletic brewing", "oishii" (challenger brands nobody uses as a synonym for their category), "creatine gummies", "non-alcoholic beer", "hard seltzer", "functional gummies", "dry january", "chocolate gift box" (specific subtypes, intersections or occasions), "yuzu", "lychee", "medjool dates", "matcha", "soju", "pisco" (specific varietals or regional products, not the categories "fruit" / "spirits").

RULES
- Being famous, old, or widely liked does NOT make something a categoryStaple. Creatine and magnesium are household words and are still false. The test is whether the term IS the category's name or its default stand-in.
- Judge the term by what it MEANS. Translate non-English terms first and judge the meaning. A term is never a staple merely for being foreign or unfamiliar, and never exempt merely for being foreign or unfamiliar.
- A modifier that narrows a category makes it not a staple: "beer" is a staple, "non-alcoholic beer" is not.
- If unsure on either question, answer false. Keeping a term is safer than dropping a real trend.

For each input term return a JSON object. Respond ONLY with: {"results":[{"term":"...","everydayGeneric":true|false,"categoryStaple":true|false,"reason":"short"}]}`;

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
}

// Judge a batch of terms in one LLM call. Returns a map term -> SpecificityResult.
// Callers should cache the result per (entity) so this only runs once each.
export async function judgeSpecificityBatch(
  terms: string[]
): Promise<Map<string, SpecificityResult>> {
  const out = new Map<string, SpecificityResult>();
  if (terms.length === 0) return out;
  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SPECIFICITY_SYSTEM_PROMPT },
      { role: "user", content: terms.map((t) => `- ${t}`).join("\n") },
    ],
  });
  const text = response.choices[0]?.message?.content ?? '{"results":[]}';
  let parsed: { results?: Array<RawSpecificityVerdict & { term?: string }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { results: [] };
  }
  const results = (parsed.results ?? []).filter((r) => r && typeof r === "object");

  // Match results back to the terms we asked about. The model echoes the term,
  // but NOT always verbatim — it misspelled "orsetti gommosi" as "orsettti
  // gommosi" while judging it correctly. Exact-match-only silently dropped that
  // verdict and kept the entity, and the terms a model is most likely to
  // garble are the foreign/unfamiliar ones this check most needs to catch.
  // So: exact match on a normalised key first, then fall back to POSITION for
  // whatever is left (the model returns results in the order it was given).
  const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
  const byKey = new Map<string, RawSpecificityVerdict>();
  for (const r of results) {
    if (typeof r.term === "string") byKey.set(norm(r.term), r);
  }

  const unmatchedTerms: number[] = [];
  terms.forEach((t, i) => {
    const hit = byKey.get(norm(t));
    if (hit) {
      out.set(t.toLowerCase(), interpretSpecificityVerdict(hit));
      byKey.delete(norm(t));
    } else {
      unmatchedTerms.push(i);
    }
  });

  // Positional fallback, only when it is unambiguous: exactly as many leftover
  // results as leftover terms, in order.
  const leftover = results.filter((r) => typeof r.term !== "string" || byKey.has(norm(r.term)));
  if (unmatchedTerms.length > 0 && leftover.length === unmatchedTerms.length) {
    unmatchedTerms.forEach((termIdx, k) => {
      out.set(terms[termIdx].toLowerCase(), interpretSpecificityVerdict(leftover[k]));
    });
    unmatchedTerms.length = 0;
  }

  // anything still unmatched -> kept by default
  for (const i of unmatchedTerms) {
    out.set(terms[i].toLowerCase(), { specific: true, reason: "not judged (kept by default)" });
  }
  return out;
}
