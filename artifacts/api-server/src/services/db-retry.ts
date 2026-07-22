// Shared retry wrapper for DB calls. Neon drops long-lived connections, so any
// single query in a long job can fail with "Connection terminated unexpectedly"
// even though the next acquire gets a healthy socket.
//
// Lived privately in state-machine.ts; timeseries needed it too (a dropped
// connection there was swallowed by a try/catch and silently lost buckets).

import { logger } from "../lib/logger.js";

export async function withDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        // Linear backoff: a dropped Neon connection is replaced on next acquire,
        // so a short pause is enough — no need for aggressive exponential waits.
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        logger.warn({ label, attempt: i + 1 }, "DB call failed, retrying");
      }
    }
  }
  throw lastErr;
}
