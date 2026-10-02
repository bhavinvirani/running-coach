import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, inject } from "vitest";

// Per test file, before any app module loads: clone the migrated template into a fresh database and point
// DATABASE_URL at it. Tables are truncated before each test; the database is dropped after the file.
// Config also points at the run's Garmin service (fixture mode) and fake Claude from global-setup.ts.

process.env.GARMIN_SERVICE_PORT = String(inject("garminServicePort"));
process.env.CLAUDE_BASE_URL = inject("claudeBaseUrl");

const adminUrl = inject("adminDatabaseUrl");
const template = inject("templateDatabase");
const database = `${template.replace(/_tpl$/, "")}_${randomBytes(4).toString("hex")}`;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createClone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await withAdmin((client) =>
        client.query(`create database ${quoteIdent(database)} template ${quoteIdent(template)}`),
      );
      return;
    } catch (error) {
      // 55006: the template is briefly in use by another file's clone; try again.
      if ((error as { code?: string }).code !== "55006" || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }
}

await createClone();
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${database}`;
process.env.DATABASE_URL = databaseUrl.toString();

const truncator = new pg.Client({ connectionString: databaseUrl.toString() });
await truncator.connect();

beforeEach(async () => {
  const { rows } = await truncator.query<{ name: string }>(
    "select quote_ident(tablename) as name from pg_tables where schemaname = 'public'",
  );
  if (rows.length > 0) {
    await truncator.query(`truncate ${rows.map((row) => row.name).join(", ")} cascade`);
  }
});

afterAll(async () => {
  await truncator.end();
  const { pool } = await import("../src/db/client");
  await pool.end();
  await withAdmin((client) =>
    client.query(`drop database if exists ${quoteIdent(database)} with (force)`),
  );
});
