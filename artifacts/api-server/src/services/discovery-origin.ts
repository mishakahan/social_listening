// Answers, per trend: did we go looking for this, or did it come out of the
// data? A trend matches "searched for" if its label equals a seed keyword, or
// appears as a whole word inside one (so "empanadas a domicilio" claims
// "empanadas"). Anything left over was surfaced by extraction reading real
// posts, which is the discovery claim.
//
// Matching is deliberately generous: a false "searched for" understates our
// own discovery, which is the safe direction to be wrong in front of a client.

import { singularizeWord } from "./entity-canonical.js";

export function normalizeTerm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^#/, "")
    .trim();
}

// Word-level equality that also accepts a plural/singular pair, e.g.
// "empanada" vs "empanadas". Reuses entity-canonical.ts's singularizeWord
// rather than re-deriving plural rules here — that function already carries
// the isAlreadySingular guard that keeps words like "citrus"/"hibiscus"/
// "focus" from being mangled into "citru"/"hibiscu"/"focu" (a bug this repo
// has already shipped and repaired once; not worth reintroducing in a
// second matcher).
function wordsMatch(a: string, b: string): boolean {
  return a === b || singularizeWord(a) === singularizeWord(b);
}

// NOTE on the multi-word-label-vs-multi-word-seed case (e.g. "frango
// desfiado" vs a seed "hamburguer de frango"): a shared-content-word
// intersection was evaluated here and rejected. On company 1's real seed
// vocabulary it matched "whey protein" against the seed "protein gummies"
// (from the "Functional gummies" topic) purely on the word "protein" —
// flipping an anchor-required DISCOVERED term to seeded. Two unrelated
// product categories sharing one content word is common in food vocab, so
// this branch stays unimplemented; see the fix report for detail.
//
// Returns the seed term (already normalized, as it appears in `seedTerms`)
// that matched `label`, or null if none did. Shared by wasSearchedFor (which
// only cares whether a match exists) and resolveSeedMatch (which needs to
// know *which* term matched, to look up its watch topic / search term).
//
// Takes a `Set<string>` directly (not an arbitrary Iterable) so callers that
// already hold a Set — every real caller does — don't pay for rebuilding one
// on every invocation. Callers matching against a Map's keys should build
// the Set once alongside the map, not derive it per call.
function matchSeedTerm(label: string, seedTerms: Set<string>): string | null {
  const lab = normalizeTerm(label);
  if (!lab) return null;

  if (seedTerms.has(lab)) return lab;

  const labWords = lab.split(/\s+/);
  for (const seed of seedTerms) {
    if (!seed) continue;
    const seedWords = seed.split(/\s+/);

    // Single-word label matching a (plural/singular-insensitive) word
    // anywhere inside the seed: "empanada" matches seed "empanadas a
    // domicilio" via its first word, "jamon" matches "jamon serrano".
    if (labWords.length === 1 && seedWords.some((w) => wordsMatch(w, lab))) {
      return seed;
    }

    // Multi-word label containing a whole single-word seed:
    // "creatine gummies" contains seed "creatine" or "gummies".
    if (
      labWords.length > 1 &&
      seedWords.length === 1 &&
      labWords.some((lw) => wordsMatch(lw, seedWords[0]!))
    ) {
      return seed;
    }

    // Multi-word label vs multi-word seed (e.g. "frango desfiado" vs
    // "hamburguer de frango") is deliberately NOT matched here — see the
    // NOTE above the function for why a content-word intersection was tried
    // and rejected.
  }
  return null;
}

export function wasSearchedFor(label: string, seedTerms: Set<string>): boolean {
  const lab = normalizeTerm(label);
  if (!lab) return true;
  return matchSeedTerm(label, seedTerms) !== null;
}

// What a matched seed term carries: the watch topic it ladders up to
// (nullable — the query may predate the watch-topic column) and the seed's
// own topicLabel (the scout query's search-term label, e.g. "Avocado sauces
// MX" — NOT the trend's own title/topicLabel, which is a different, always-
// equal-to-title field on knowledge_items; see storage/index.ts).
export interface SeedMatch {
  watchTopic: string | null;
  searchTerm: string | null;
}

const NO_MATCH: SeedMatch = { watchTopic: null, searchTerm: null };

// Resolves a trend label to the watch topic + search term of whichever seed
// term matched it, using the same matching rules as wasSearchedFor (so a
// trend that is "searched for" always resolves to a topic/term when one is
// available, and a genuinely discovered trend resolves to nulls). `seedTerms`
// must be the same Set backing `termToSeed`'s keys (callers build both
// together in one pass — see getSeedVocabulary) so matching doesn't rebuild
// a Set per trend. Terms with no map entry (shouldn't happen if seedTerms and
// termToSeed are built together, but handled defensively) resolve to nulls
// rather than throwing — the trend groups under "Uncategorised" in the UI
// rather than being hidden.
export function resolveSeedMatch(
  label: string,
  seedTerms: Set<string>,
  termToSeed: Map<string, SeedMatch>
): SeedMatch {
  const matched = matchSeedTerm(label, seedTerms);
  if (!matched) return NO_MATCH;
  return termToSeed.get(matched) ?? NO_MATCH;
}
