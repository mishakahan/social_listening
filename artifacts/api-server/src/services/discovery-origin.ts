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
// only cares whether a match exists) and resolveWatchTopic (which needs to
// know *which* term matched, to look up its watch topic).
function matchSeedTerm(label: string, seedTerms: Iterable<string>): string | null {
  const lab = normalizeTerm(label);
  if (!lab) return null;

  const seedSet: Set<string> = seedTerms instanceof Set ? seedTerms : new Set(seedTerms);
  if (seedSet.has(lab)) return lab;

  const labWords = lab.split(/\s+/);
  for (const seed of seedSet) {
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

// Resolves a trend label to the watch topic of whichever seed term matched
// it, using the same matching rules as wasSearchedFor (so a trend that is
// "searched for" always resolves to a topic when one is available, and a
// genuinely discovered trend resolves to null). `termToTopic` maps a
// normalized seed term (keyword/hashtag/topicLabel) to its watch topic;
// terms whose scout query predates the watch-topic column are simply absent
// from the map, so they resolve to null and the trend groups under
// "Uncategorised" in the UI rather than being hidden.
export function resolveWatchTopic(
  label: string,
  termToTopic: Map<string, string>
): string | null {
  const matched = matchSeedTerm(label, termToTopic.keys());
  return matched ? (termToTopic.get(matched) ?? null) : null;
}
