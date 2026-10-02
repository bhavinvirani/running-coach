import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../db/client";
import { advisoryLockKey } from "./lock-key";

/**
 * Runs fn while holding a per-user Postgres advisory lock, so Garmin calls (and their token write-back) for
 * one user never overlap, across requests, jobs and processes. The lock is transaction-scoped
 * (pg_advisory_xact_lock) inside a transaction that spans fn, so it also holds through a transaction pooler
 * and is released by commit, rollback or a dropped connection. fn may use tx for writes that must commit
 * with the lock held. A second caller waits; it does not fail.
 */
export async function withUserLock<T>(
  userId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const key = advisoryLockKey("user", userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
    return fn(tx);
  });
}
