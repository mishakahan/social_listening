// Specificity check (the systematic relevance pass that replaces a manual
// blocklist). Answers: is this a SPECIFIC, trackable trend, or a GENERIC
// everyday term? "Ashwagandha", "Spritz Pastille", "Chocolate Gift Box" are
// specific; "coffee", "salt", "water", "milk" are generic and should be held.
//
// The pure decision logic lives here (testable). The LLM call + cache is thin
// I/O in judgeSpecificityBatch below.

import OpenAI from "openai";

export interface SpecificityResult {
  specific: boolean;
  reason: string;
}

// Pure: turn a raw model label into a keep/drop decision. Defensive so a
// malformed response defaults to KEEPING the entity (never silently drop on a
// parse error — a generic word slipping through is safer than losing a real one).
export function interpretSpecificityVerdict(
  raw: { specific?: unknown; reason?: unknown } | null | undefined
): SpecificityResult {
  if (!raw || typeof raw.specific !== "boolean") {
    return { specific: true, reason: "no verdict (kept by default)" };
  }
  return {
    specific: raw.specific,
    reason: typeof raw.reason === "string" ? raw.reason : "",
  };
}

const SPECIFICITY_SYSTEM_PROMPT = `You judge whether a term is a SPECIFIC, trackable trend or a GENERIC everyday term, for a social-listening trend radar.

SPECIFIC (specific: true): a named product, brand, ingredient-trend, format, flavour, or occasion someone could act on as a trend. Examples: "ashwagandha", "spritz pastille", "chocolate gift box", "functional gummies", "hard seltzer", "dry january", "cri-cri".

GENERIC (specific: false): an everyday word so broad it is background noise, not a trend. Examples: "coffee", "water", "salt", "milk", "flour", "sugar", "food", "drink", "snack", "bread".

For each input term return a JSON object. Respond ONLY with: {"results":[{"term":"...","specific":true|false,"reason":"short"}]}`;

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
  let parsed: { results?: Array<{ term?: string; specific?: unknown; reason?: unknown }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { results: [] };
  }
  for (const r of parsed.results ?? []) {
    if (typeof r.term === "string") {
      out.set(r.term.toLowerCase(), interpretSpecificityVerdict(r));
    }
  }
  // any term the model skipped -> kept by default
  for (const t of terms) {
    if (!out.has(t.toLowerCase())) {
      out.set(t.toLowerCase(), { specific: true, reason: "not judged (kept by default)" });
    }
  }
  return out;
}
