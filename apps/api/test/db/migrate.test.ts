import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { runMigrations } from "../../src/db/migrate";
import { paths } from "../../src/lib/paths";

// The migration runner (src/db/migrate.ts) on a brand-new database. A new table belongs in TABLES.

const TABLES = [
  "account",
  "activity",
  "activity_lap",
  "activity_stream",
  "best_effort",
  "coach_message",
  "garmin_connection",
  "goal",
  "import_progress",
  "plan",
  "plan_adjustment",
  "plan_session",
  "session",
  "training_pause",
  "user",
  "user_settings",
  "verification",
];

const migrationFiles = readdirSync(paths.migrations).filter((file) => file.endsWith(".sql"));

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
  // pool.end() resolves once pg-pool has dropped its clients, before their sockets close, so the forced drop
  // below can terminate a connection that is still closing (57P01). Expected here; any other error is not.
  for (const pool of pools) {
    pool.on("error", (error: Error & { code?: string }) => {
      if (error.code !== "57P01") throw error;
    });
  }
  try {
    await fn(pools);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
}

describe("runMigrations", () => {
  it("applies every migration on a fresh database, also when two processes start at once, and reruns as a no-op", async () => {
    await withEmptyDatabase(async ([first, second]) => {
      await Promise.all([runMigrations(first), runMigrations(second)]);
      await runMigrations(first);

      const { rows: tables } = await first.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      );
      expect(tables.map((row) => row.tablename)).toEqual(TABLES);
      const { rows: applied } = await first.query<{ count: string }>(
        "select count(*) from drizzle.__drizzle_migrations",
      );
      expect(Number(applied[0]?.count)).toBe(migrationFiles.length);
    });
  });
});
