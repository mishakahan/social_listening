// Pure, deterministic canonicalization of an entity label.
//
// The synonym table (tp_entity_synonyms) handles hand-curated, hard cases. This
// helper handles the trivial ones automatically so they don't need a manual
// entry: casing and simple plural/singular of a SINGLE-word label.
//
// Deliberately conservative: only single-word labels are singularized, so
// multi-word product names stay distinct. "Gummies" -> "gummy", but
// "gummy bears" and "thc gummies" keep their full (lowercased) form and are NOT
// collapsed into "gummy".

// Basic English singularization for one word. Handles the common cases without
// pulling in a full stemming library (which would over-merge).
// Words that are ALREADY SINGULAR despite ending in "s". Without this guard the
// trailing-"s" rule below mangles them, and the damage is invisible because the
// mangled form becomes the canonical label: "citrus" was surfacing on the live
// radar as "citru" with 27 mentions. Food vocabulary is full of these.
const SINGULAR_ENDING_IN_S = new Set([
  "molasses", "brussels", "swiss", "bolognese", "caprese", "anise",
]);

// Latin/Greek-derived singulars (-us, -is) and true double-s words are never
// plurals in this vocabulary: citrus, hummus, couscous, asparagus, hibiscus,
// oasis, glass. Checked before any rule so the "es" rule can't strip them either.
function isAlreadySingular(w: string): boolean {
  return SINGULAR_ENDING_IN_S.has(w) || /(?:us|is|ss)$/.test(w);
}

// Exported for reuse by discovery-origin.ts, which needs the same
// plural/singular equivalence for single words when matching a trend title
// against the seed vocabulary. Do not change this function's behavior for
// that caller's sake — it's also load-bearing for the extraction pipeline's
// entity canonicalization above, and the isAlreadySingular guard exists
// specifically to prevent the "citrus" -> "citru" corruption bug.
export function singularizeWord(word: string): string {
  const w = word;
  if (isAlreadySingular(w)) return w;
  // ...ies -> ...y  (gummies -> gummy, candies -> candy)
  if (w.length > 3 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  // ...sses/...ches/...shes/...xes/...zes -> drop "es" (boxes -> box, dishes -> dish)
  if (w.length > 4 && /(ss|ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  // ...s -> ...  (mocktails -> mocktail), but not "...ss" (glass stays glass)
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function canonicalizeLabel(label: string): string {
  const cleaned = label.trim().replace(/\s+/g, " ").toLowerCase();
  if (!cleaned) return cleaned;
  // Only singularize genuine single-word labels; multi-word names stay intact
  // so distinct products ("gummy bears", "hot sauce") are preserved.
  if (!cleaned.includes(" ")) {
    return singularizeWord(cleaned);
  }
  // For multi-word labels, strip a trailing CORPORATE suffix (company, co, inc,
  // llc, ...) so brand variants merge ("athletic brewing company" / "... co." ->
  // "athletic brewing") — but only a corporate suffix, never a product word, so
  // "gummy bears" and "hot sauce" are untouched. Never strip down to empty.
  const withoutSuffix = stripCorporateSuffix(cleaned);
  return withoutSuffix || cleaned;
}

// Note: "brand"/"brands" are deliberately excluded — they're too often part of
// a real name ("Some Brand", "Kind Brands"), so stripping them over-merges.
const CORPORATE_SUFFIXES = new Set([
  "co", "co.", "company", "inc", "inc.", "llc", "ltd", "ltd.", "corp", "corp.",
]);

function stripCorporateSuffix(label: string): string {
  const words = label.split(" ");
  // only strip if there's a base name left after removing the suffix
  while (words.length > 1 && CORPORATE_SUFFIXES.has(words[words.length - 1]!)) {
    words.pop();
  }
  return words.join(" ");
}
