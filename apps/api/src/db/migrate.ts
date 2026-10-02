import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { advisoryLockKey } from "../lib/lock-key";
import { paths } from "../lib/paths";

const MIGRATION_LOCK_KEY = advisoryLockKey("migrations", "running-coach");

/**
 * Applies pending migrations from src/db/migrations, all in one transaction (drizzle's migrator), while
 * holding an advisory lock so two processes starting together cannot race. The lock is session-level on one
 * dedicated connection because the migrator opens its own transaction, which a transaction-scoped lock
 * cannot span; DATABASE_URL is a direct (non-pooler) connection, so the session lock holds. A crash closes
 * the connection and releases it.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), { migrationsFolder: paths.migrations });
    } finally {
      await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
