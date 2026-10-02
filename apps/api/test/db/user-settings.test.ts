import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { db } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { user, userSettings } from "../../src/db/schema";

async function createUser(email = "runner@example.com"): Promise<string> {
  const [row] = await db.insert(user).values({ email, name: "Test Runner" }).returning();
  if (!row) throw new Error("insert returned nothing");
  return row.id;
}

/** The SQLSTATE a query failed with (drizzle wraps the pg error as its cause). */
async function postgresErrorCode(query: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    return ((error as { cause?: { code?: string } }).cause ?? (error as { code?: string })).code;
  }
  return undefined;
}

/** Runs fn against a brand-new empty database, dropped afterwards. */
async function withEmptyDatabase(fn: (pools: [pg.Pool, pg.Pool]) => Promise<void>): Promise<void> {
  const adminUrl = inject("adminDatabaseUrl");
  const name = `${inject("templateDatabase").replace(/_tpl$/, "")}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pools: [pg.Pool, pg.Pool] = [
    new pg.Pool({ connectionString: url.toString(), max: 2 }),
    new pg.Pool({ connectionString: url.toString(), max: 2 }),
  ];
  try {
    await fn(pools);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
}

describe("migrations", () => {
  it("apply on a fresh database, also when two processes start at once, and rerun as a no-op", async () => {
    await withEmptyDatabase(async ([first, second]) => {
      await Promise.all([runMigrations(first), runMigrations(second)]);
      await runMigrations(first);

      const { rows: tables } = await first.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      );
      expect(tables.map((row) => row.tablename)).toEqual(
        expect.arrayContaining([
          "account",
          "garmin_connection",
          "session",
          "user",
          "user_settings",
          "verification",
        ]),
      );
      const { rows: applied } = await first.query<{ count: string }>(
        "select count(*) from drizzle.__drizzle_migrations",
      );
      expect(Number(applied[0]?.count)).toBeGreaterThanOrEqual(3);
    });
  });
});

describe("user_settings", () => {
  it("fills the defaults: km, UTC, standard, no HR zones, no Claude key", async () => {
    const userId = await createUser();

    const [row] = await db.insert(userSettings).values({ userId }).returning();

    expect(row).toMatchObject({
      userId,
      units: "km",
      timezone: "UTC",
      coachDetail: "standard",
      hrZones: null,
      claudeKeyEnc: null,
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("allows one row per user", async () => {
    const userId = await createUser();
    await db.insert(userSettings).values({ userId });

    expect(await postgresErrorCode(db.insert(userSettings).values({ userId }))).toBe("23505");
  });

  it("rejects units and coach detail outside the shared lists", async () => {
    const userId = await createUser();

    const badUnits = db.insert(userSettings).values({ userId, units: "furlongs" as never });
    const badDetail = db.insert(userSettings).values({ userId, coachDetail: "verbose" as never });

    expect(await postgresErrorCode(badUnits)).toBe("23514");
    expect(await postgresErrorCode(badDetail)).toBe("23514");
  });

  it("is deleted with its user", async () => {
    const userId = await createUser();
    await db.insert(userSettings).values({ userId });

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select().from(userSettings)).toHaveLength(0);
  });

  it("updates updated_at on change and keeps other users' rows", async () => {
    const ownerId = await createUser();
    const otherId = await createUser("other@example.com");
    const [before] = await db.insert(userSettings).values({ userId: ownerId }).returning();
    await db.insert(userSettings).values({ userId: otherId });

    const [after] = await db
      .update(userSettings)
      .set({ units: "mi" })
      .where(eq(userSettings.userId, ownerId))
      .returning();

    expect(after?.units).toBe("mi");
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);
    const [other] = await db.select().from(userSettings).where(eq(userSettings.userId, otherId));
    expect(other?.units).toBe("km");
  });
});
