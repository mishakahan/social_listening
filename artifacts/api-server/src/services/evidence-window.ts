// The Trends list "Evidence" column is volume30d. The drill-down must use the
// same window or the two numbers disagree on screen for the same trend.
export const EVIDENCE_WINDOW_DAYS = 30;

export function evidenceCutoff(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
}

// The trend-detail "recent" evidence count must come from the knowledge
// item's evidenceCount column, which the state machine keeps in sync with
// the entity's volume30d (services/state-machine.ts, ensureKnowledgeItem
// sets both from the same `metrics.volume30d`). It must NOT be derived by
// counting rows in a capped evidence-history query (e.g. LIMIT 20): any
// entity with more than the cap's worth of signals inside the window would
// silently under-report — reintroducing the exact list-vs-detail mismatch
// this module exists to eliminate (seen live: cafe ~120 mentions/30d,
// creatine ~28 — both would show a wrong, capped "recent" number).
export function recentEvidenceCount(
  knowledgeItemEvidenceCount: number | null | undefined
): number {
  return knowledgeItemEvidenceCount ?? 0;
}
