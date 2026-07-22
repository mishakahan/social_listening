import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Neon closes connections server-side (idle timeouts, and it can drop a long
// session outright). Left at pg's defaults the pool hands out an already-dead
// socket and the caller blocks forever: long jobs like runStateMachine were
// observed freezing partway through with the process alive but stuck on I/O.
//
// keepAlive stops NAT/Neon dropping an idle socket; idleTimeoutMillis retires
// connections before Neon does, so we reconnect on our terms; the timeouts turn
// a silent hang into a throw the caller can retry.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PGPOOL_MAX ?? "10") || 10,
  keepAlive: true,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  // Ceiling on a single query. Long enough for the heaviest aggregate, short
  // enough that a dead socket surfaces instead of hanging the run. 60s was too
  // tight once the entity count grew: it killed a timeseries run and the first
  // Reddit re-ingest on legitimate big reads, not on dead sockets.
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? "180000") || 180_000,
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS ?? "180000") || 180_000,
});

// A pool-level error (Neon dropping an idle client) is emitted on the pool, not
// on any awaited promise. Without a listener Node treats it as unhandled and can
// kill the process mid-run.
pool.on("error", (err) => {
  console.error("[db] idle pool client error (connection dropped):", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
