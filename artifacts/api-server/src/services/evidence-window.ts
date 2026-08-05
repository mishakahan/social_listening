// The Trends list "Evidence" column is volume30d. The drill-down must use the
// same window or the two numbers disagree on screen for the same trend.
export const EVIDENCE_WINDOW_DAYS = 30;

export function evidenceCutoff(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
}
