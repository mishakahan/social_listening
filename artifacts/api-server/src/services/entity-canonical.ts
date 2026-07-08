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
function singularizeWord(word: string): string {
  const w = word;
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
  return cleaned;
}
