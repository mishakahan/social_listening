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
export function wasSearchedFor(label: string, seedTerms: Set<string>): boolean {
  const lab = normalizeTerm(label);
  if (!lab) return true;
  if (seedTerms.has(lab)) return true;

  const labWords = lab.split(/\s+/);
  for (const seed of seedTerms) {
    if (!seed) continue;
    const seedWords = seed.split(/\s+/);

    // Single-word label matching a (plural/singular-insensitive) word
    // anywhere inside the seed: "empanada" matches seed "empanadas a
    // domicilio" via its first word, "jamon" matches "jamon serrano".
    if (labWords.length === 1 && seedWords.some((w) => wordsMatch(w, lab))) {
      return true;
    }

    // Multi-word label containing a whole single-word seed:
    // "creatine gummies" contains seed "creatine" or "gummies".
    if (
      labWords.length > 1 &&
      seedWords.length === 1 &&
      labWords.some((lw) => wordsMatch(lw, seedWords[0]!))
    ) {
      return true;
    }

    // Multi-word label vs multi-word seed (e.g. "frango desfiado" vs
    // "hamburguer de frango") is deliberately NOT matched here — see the
    // NOTE above the function for why a content-word intersection was tried
    // and rejected.
  }
  return false;
}
