// Answers, per trend: did we go looking for this, or did it come out of the
// data? A trend matches "searched for" if its label equals a seed keyword, or
// appears as a whole word inside one (so "empanadas a domicilio" claims
// "empanadas"). Anything left over was surfaced by extraction reading real
// posts, which is the discovery claim.
//
// Matching is deliberately generous: a false "searched for" understates our
// own discovery, which is the safe direction to be wrong in front of a client.

export function normalizeTerm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^#/, "")
    .trim();
}

export function wasSearchedFor(label: string, seedTerms: Set<string>): boolean {
  const lab = normalizeTerm(label);
  if (!lab) return true;
  if (seedTerms.has(lab)) return true;

  const labWords = lab.split(/\s+/);
  for (const seed of seedTerms) {
    if (!seed) continue;
    const seedWords = seed.split(/\s+/);
    if (seedWords.includes(lab)) return true;
    if (labWords.length > 1 && labWords.includes(seed)) return true;
  }
  return false;
}
