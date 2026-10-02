import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../lib/config";
import { logger } from "../lib/logger";
import * as schema from "./schema";

// Small pool for a 512 MB box and Neon Free's connection limits; pg-boss keeps its own few connections, the
// per-user locks two more (lockPool below).
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "running-coach-api",
});

// An idle client losing its connection (Neon suspending, a restart) must not crash the process.
pool.on("error", (err) => {
  logger.warn({ err }, "idle database client failed");
});

export const db = drizzle({ client: pool, schema });

// Per-user advisory locks (src/lib/locks.ts) take their connections from here, never from the main pool, so
// callers queued for a lock can never take the connections the lock holder needs for its own writes. Two
// cover the job worker plus one request; a lock is held one at a time per user (callers for one user queue
// in memory first).
export const lockPool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "running-coach-locks",
});

lockPool.on("error", (err) => {
  logger.warn({ err }, "idle lock client failed");
});

export const lockDb = drizzle({ client: lockPool, schema });

/** Closes both pools: shutdown, scripts and tests. */
export async function closePools(): Promise<void> {
  await Promise.all([pool.end(), lockPool.end()]);
}

export type Db = typeof db;
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
