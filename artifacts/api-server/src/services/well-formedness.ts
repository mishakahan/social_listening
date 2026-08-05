// A THIRD quality axis, distinct from specificity. Specificity asks "is this
// term too broad to be interesting?". This asks "is this term even a thing?".
//
// The failures it catches, seen on real radars:
//   - dangling modifiers: "non-alcoholic" (the trend is non-alcoholic BEER),
//     "sugar-free", "handmade"
//   - occasions and claims: "brunch", "graduation"
// Both are grammatically fine and genuinely rising; neither is a product a
// client can act on.
//
// Deliberately a closed word list rather than an LLM call: it is deterministic,
// free, and cannot regress the specificity evals. A modifier is only rejected
// when it stands ALONE — "sugar-free chocolate" is a real trend.

const STANDALONE_MODIFIERS = new Set([
  "non-alcoholic", "nonalcoholic", "alcohol-free",
  "sugar-free", "sugarfree", "gluten-free", "glutenfree",
  "dairy-free", "fat-free", "low-carb", "low-fat", "high-protein",
  "handmade", "handcrafted", "homemade", "artisanal", "organic",
  "vegan", "vegetarian", "natural", "premium", "authentic",
]);

const OCCASIONS = new Set([
  "brunch", "breakfast", "lunch", "dinner", "snack", "dessert",
  "graduation", "birthday", "wedding", "christmas", "easter",
  "halloween", "thanksgiving", "party", "picnic", "holiday",
]);

export function isWellFormed(label: string): { wellFormed: boolean; reason: string } {
  const norm = label.trim().toLowerCase();

  if (!norm) return { wellFormed: false, reason: "empty label" };

  // Multi-word labels are compounds and are allowed through: the modifier or
  // occasion is qualifying a real noun ("sugar-free chocolate", "brunch
  // sandwich"), which is exactly the well-formed case.
  if (norm.includes(" ")) return { wellFormed: true, reason: "compound noun phrase" };

  if (STANDALONE_MODIFIERS.has(norm)) {
    return {
      wellFormed: false,
      reason: `"${norm}" is a modifier with nothing to modify — the trend is whatever it describes`,
    };
  }

  if (OCCASIONS.has(norm)) {
    return {
      wellFormed: false,
      reason: `"${norm}" is an occasion, not a product`,
    };
  }

  return { wellFormed: true, reason: "well-formed" };
}

// No-hyphen spelling variants that already have their own separate,
// hyphenated entry in STANDALONE_MODIFIERS above. Round-1 of this script
// folded "nonalcoholic" (17 mentions) into "nonalcoholic beer" (5) while
// "non-alcoholic beer" (64) — almost certainly the SAME real trend, spelled
// with a hyphen — existed right next to it. findCompoundParent has no way to
// know the two spellings refer to the same product without doing real
// cross-spelling normalisation, so rather than guess (and risk folding
// evidence under the thinner-spelled sibling) these are excluded from merge
// eligibility entirely. They are still in STANDALONE_MODIFIERS, so
// isWellFormed still correctly holds them off the radar — they are simply
// never candidates for the automatic fold.
const VARIANT_SPELLINGS = new Set(["nonalcoholic", "sugarfree", "glutenfree"]);

// Only STANDALONE_MODIFIERS represent a genuine split: "non-alcoholic" only
// ever means "non-alcoholic <the noun that follows>", so wherever that noun
// exists on the radar it IS the same referent. An occasion is not the same
// kind of gap — "brunch" is a complete concept on its own, and "brunch
// cocktails" is a narrower, different topic within it, not the rest of the
// same sentence. Merging those would silently move real evidence onto the
// wrong entity, so findCompoundParent is restricted to this set — and further
// excludes no-hyphen spelling variants (see VARIANT_SPELLINGS above).
export function isDanglingModifier(label: string): boolean {
  const norm = label.trim().toLowerCase();
  return STANDALONE_MODIFIERS.has(norm) && !VARIANT_SPELLINGS.has(norm);
}

// A dangling modifier is usually a SPLIT, not junk: "non-alcoholic" and
// "non-alcoholic beer" can be the same conversation counted twice. Where a
// compound extends the modifier, the modifier's evidence belongs to it —
// but ONLY when the compound genuinely carries the trend.
//
// Two real bugs found in round 1, both against live data:
//
// 1. Naive "shortest wins" tie-break: "non-alcoholic ipa" (1 mention) is a
//    shorter string than "non-alcoholic beer" (64 mentions), so shortest-
//    string picked the near-empty entity over the dominant one. Fixed with
//    an optional `weights` map (label -> evidence, e.g. total_mentions):
//    when supplied, it picks the candidate that actually carries the
//    conversation; string length is only the fallback for ties or when no
//    weights are supplied (kept so the synthetic no-volume-data tests stay
//    meaningful).
//
// 2. Wrong merge DIRECTION: weights were compared only against each OTHER,
//    never against the modifier's own volume. "vegan" (479 mentions) got
//    archived into "vegan chocolate" (28) — a 17x loss of evidence, because
//    28 beat every other candidate even though it did not beat 479. A
//    modifier with MORE evidence than every candidate parent is not a split
//    fixable by archiving it. When weights are supplied, the modifier's own
//    weight (weights[mod]) is required to be <= the chosen parent's weight;
//    if it is not, this returns null and the caller must leave both entities
//    alone rather than force a merge.
//
// Requires a word boundary so "brunch" does not capture "brunchette", and
// only ever operates on a label that is itself a standalone modifier — call
// isDanglingModifier first (the merge script does). Returns the candidate's
// ORIGINAL casing as passed in (not the lowercased comparison form) — the
// merge script writes this straight into canonical_label, and
// resolveSynonym's alias lookup is case-sensitive.
//
// Weight lookups try the EXACT original label first, falling back to the
// lowercased comparison form. This matters: two case-duplicate entities like
// "Artisanal" (1 mention) and "artisanal" (2 mentions) both normalise to the
// same comparison key, and a naive lowercase-only weights map would let the
// second one silently overwrite the first — the modifier's own volume check
// could then read the WRONG entity's mention count. Keying by exact original
// label (as the merge script does) keeps each entity's true weight distinct;
// the norm fallback only exists so callers/tests that key by the lowercase
// form (no case ambiguity to begin with) still work.
export function findCompoundParent(
  label: string,
  candidates: string[],
  weights?: Record<string, number>
): string | null {
  const modOriginal = label.trim();
  const mod = modOriginal.toLowerCase();
  if (!mod || mod.includes(" ")) return null;

  const matches = candidates
    .map((c) => ({ original: c.trim(), norm: c.trim().toLowerCase() }))
    .filter((c) => c.norm !== mod && c.norm.startsWith(mod + " "));

  if (matches.length === 0) return null;

  const weightOf = (original: string, norm: string): number =>
    weights ? (weights[original] ?? weights[norm] ?? 0) : 0;

  const sorted = [...matches].sort((a, b) => {
    if (weights) {
      const wa = weightOf(a.original, a.norm);
      const wb = weightOf(b.original, b.norm);
      if (wb !== wa) return wb - wa;
    }
    return a.norm.length - b.norm.length;
  });

  const best = sorted[0]!;

  if (weights) {
    const modWeight = weightOf(modOriginal, mod);
    const parentWeight = weightOf(best.original, best.norm);
    if (modWeight > parentWeight) return null;
  }

  return best.original;
}
