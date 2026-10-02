import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { db, pool } from "../../src/db/client";
import { user } from "../../src/db/schema";
import { config } from "../../src/lib/config";
import { advisoryLockKey } from "../../src/lib/lock-key";
import { withUserLock } from "../../src/lib/locks";

const USER_A = "4f1c2a8e-0000-4000-8000-00000000000a";
const USER_B = "4f1c2a8e-0000-4000-8000-00000000000b";

/** Advisory locks currently granted in this database, seen from another connection. */
async function advisoryLocks(): Promise<number> {
  const result = await db.execute<{ count: string }>(
    sql`select count(*) from pg_locks where locktype = 'advisory' and granted and database = (select oid from pg_database where datname = current_database())`,
  );
  return Number(result.rows[0]?.count);
}

/** Holds the lock for holdMs and records when the critical section started and ended. */
function timeline(events: string[]) {
  return (label: string, userId: string, holdMs: number) =>
    withUserLock(userId, async () => {
      events.push(`${label}:start`);
      await sleep(holdMs);
      events.push(`${label}:end`);
      return label;
    });
}

describe("withUserLock", () => {
  it("serializes two concurrent calls for one user", async () => {
    const events: string[] = [];
    const run = timeline(events);

    const first = run("first", USER_A, 150);
    await sleep(30);
    const results = await Promise.all([first, run("second", USER_A, 10)]);

    expect(results).toEqual(["first", "second"]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("lets different users run in parallel", async () => {
    const events: string[] = [];
    const run = timeline(events);

    const first = run("a", USER_A, 150);
    await sleep(30);
    await Promise.all([first, run("b", USER_B, 10)]);

    expect(events).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });

  it("holds an advisory lock only while fn runs", async () => {
    const during = await withUserLock(USER_A, () => advisoryLocks());

    expect(during).toBe(1);
    expect(await advisoryLocks()).toBe(0);
  });

  it("releases the lock and rolls back fn's writes when fn throws", async () => {
    await expect(
      withUserLock(USER_A, async (tx) => {
        await tx.insert(user).values({ email: "runner@example.com", name: "Test Runner" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await advisoryLocks()).toBe(0);
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it("serves the lock holder from the main pool while more callers wait than the pool has connections", async () => {
    const waiters = (pool.options.max ?? 10) + 3;
    const order: number[] = [];
    const started = Date.now();

    await Promise.all(
      Array.from({ length: waiters }, (_, index) =>
        withUserLock(USER_A, async () => {
          // The holder's own reads and writes go through the main pool, as a sync's do.
          await db.transaction((tx) => tx.execute(sql`select pg_sleep(0.01)`));
          order.push(index);
        }),
      ),
    );

    expect(order).toEqual(Array.from({ length: waiters }, (_, index) => index));
    // Far below the pool's 10 s connection timeout: nobody waited for a connection.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("lets the next caller in after a caller's fn throws", async () => {
    const failing = withUserLock(USER_A, () => Promise.reject(new Error("boom")));
    const next = withUserLock(USER_A, () => Promise.resolve("next"));

    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("next");
  });

  it("waits while another process holds the user's advisory lock", async () => {
    const otherProcess = new pg.Client({ connectionString: config.DATABASE_URL });
    await otherProcess.connect();
    try {
      await otherProcess.query("begin");
      await otherProcess.query("select pg_advisory_xact_lock($1::bigint)", [
        advisoryLockKey("user", USER_A),
      ]);
      const events: string[] = [];

      const run = withUserLock(USER_A, () => {
        events.push("ran");
        return Promise.resolve();
      });
      await sleep(150);
      expect(events).toEqual([]);
      await otherProcess.query("commit");
      await run;

      expect(events).toEqual(["ran"]);
    } finally {
      await otherProcess.end();
    }
  });
});
