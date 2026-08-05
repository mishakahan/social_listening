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

// Only STANDALONE_MODIFIERS represent a genuine split: "non-alcoholic" only
// ever means "non-alcoholic <the noun that follows>", so wherever that noun
// exists on the radar it IS the same referent. An occasion is not the same
// kind of gap — "brunch" is a complete concept on its own, and "brunch
// cocktails" is a narrower, different topic within it, not the rest of the
// same sentence. Merging those would silently move real evidence onto the
// wrong entity, so findCompoundParent is restricted to this set.
export function isDanglingModifier(label: string): boolean {
  return STANDALONE_MODIFIERS.has(label.trim().toLowerCase());
}

// A dangling modifier is usually a SPLIT, not junk: "non-alcoholic" (73
// mentions on Leone) and "non-alcoholic beer" (64) are the same conversation
// counted twice. Where a compound extends the modifier, the modifier's
// evidence belongs to it.
//
// Real data broke a naive "shortest wins" tie-break: "non-alcoholic ipa" (1
// mention) is a shorter string than "non-alcoholic beer" (64 mentions), so
// shortest-string picked the near-empty entity over the dominant one. An
// optional `weights` map (label -> evidence, e.g. total_mentions) is used to
// pick the candidate that actually carries the conversation; string length is
// only the fallback for ties or when no weights are supplied (kept so the
// synthetic no-volume-data test cases stay meaningful).
//
// Requires a word boundary so "brunch" does not capture "brunchette", and
// only ever operates on a label that is itself a standalone modifier — call
// isDanglingModifier first (the merge script does).
export function findCompoundParent(
  label: string,
  candidates: string[],
  weights?: Record<string, number>
): string | null {
  const mod = label.trim().toLowerCase();
  if (!mod || mod.includes(" ")) return null;

  const matches = candidates
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== mod && c.startsWith(mod + " "));

  if (matches.length === 0) return null;

  const sorted = [...matches].sort((a, b) => {
    if (weights) {
      const wa = weights[a] ?? 0;
      const wb = weights[b] ?? 0;
      if (wb !== wa) return wb - wa;
    }
    return a.length - b.length;
  });

  return sorted[0];
}
