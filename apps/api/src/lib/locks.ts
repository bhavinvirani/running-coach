import { sql } from "drizzle-orm";
import { type DbTransaction, lockDb } from "../db/client";
import { advisoryLockKey } from "./lock-key";

// The tail of each user's queue of callers in this process; an entry is removed once its queue empties.
const queues = new Map<string, Promise<void>>();

/**
 * Runs fn while holding a per-user lock, so Garmin calls (and their token write-back) for one user never
 * overlap, across requests, jobs and processes. Callers wait in turn and do not fail.
 *
 * Two layers. In this process, callers for one user queue in memory, oldest first, holding no database
 * connection while they wait. The head of the queue then takes a Postgres advisory lock for other
 * processes: transaction-scoped (pg_advisory_xact_lock) inside a transaction that spans fn, so it also holds
 * through a transaction pooler and is released by commit, rollback or a dropped connection. That
 * transaction runs on its own pool (lockPool), so fn's writes through `db` always find a main-pool
 * connection. fn may use tx for writes that must commit with the lock held.
 *
 * Not re-entrant: calling withUserLock for the same user inside fn waits forever.
 */
export async function withUserLock<T>(
  userId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const previous = queues.get(userId) ?? Promise.resolve();
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Every link only ever resolves, so a failed caller never blocks or fails the ones behind it.
  const tail = previous.then(() => done);
  queues.set(userId, tail);
  try {
    await previous;
    const key = advisoryLockKey("user", userId);
    return await lockDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
      return fn(tx);
    });
  } finally {
    release();
    if (queues.get(userId) === tail) queues.delete(userId);
  }
}
