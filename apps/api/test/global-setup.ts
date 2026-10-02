import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/db/migrate";
import { GarminServiceProcess } from "../src/garmin/process";
import { paths } from "../src/lib/paths";
import { startFakeClaude } from "./fake-claude";

// Once per run: migrate a template database; each test file clones it (setup-database.ts), which takes
// milliseconds and isolates files completely. Database per file rather than schema per file, because drizzle's
// migrations qualify foreign keys with "public".
//
// Also once per run, the only two fakes (tests rule): the real Garmin service in fixture mode on a spare
// port, and a local fake of the Claude API. setup-database.ts points each file's config at both.
//
// Names: <base>_<pid>_tpl for the template, <base>_<pid>_<random> for clones, where <base> is the database in
// DATABASE_URL_TEST and <pid> this Vitest process, so databases left by a killed run are dropped next time.

declare module "vitest" {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
    templateDatabase: string;
    runPid: number;
    garminServicePort: number;
    claudeBaseUrl: string;
  }
}

const DEFAULT_URL = "postgres://postgres:postgres@localhost:5434/running_coach_test";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function dropStaleDatabases(admin: pg.Client, base: string): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    "select datname from pg_database where starts_with(datname, $1)",
    [`${base}_`],
  );
  for (const { datname } of rows) {
    const pid = Number(/^(\d+)_/.exec(datname.slice(base.length + 1))?.[1]);
    if (Number.isInteger(pid) && pid !== process.pid && !isAlive(pid)) {
      await admin.query(`drop database if exists ${quoteIdent(datname)} with (force)`);
    }
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** The uv-made venv the service runs from; created on first use (a fresh clone or CI). */
function ensureGarminVenv(): void {
  if (existsSync(path.join(paths.garminService, ".venv/bin/uvicorn"))) return;
  execFileSync("uv", ["sync", "--frozen", "--quiet"], {
    cwd: paths.garminService,
    stdio: "inherit",
  });
}

async function startGarminService(project: TestProject): Promise<GarminServiceProcess> {
  const secret = project.config.env.GARMIN_SERVICE_SECRET;
  if (!secret) throw new Error("vitest.config.ts env must set GARMIN_SERVICE_SECRET");
  ensureGarminVenv();
  const garmin = new GarminServiceProcess({
    serviceDir: paths.garminService,
    port: await freePort(),
    secret,
    fixtures: true,
    logLevel: "silent",
    baseEnv: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    },
    log: {
      info: () => undefined,
      warn: (obj, msg) => console.warn(msg, obj),
      error: (obj, msg) => console.error(msg, obj),
    },
  });
  await garmin.start();
  return garmin;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = new URL(process.env.DATABASE_URL_TEST || DEFAULT_URL);
  const base = adminUrl.pathname.slice(1);
  const template = `${base}_${process.pid}_tpl`;

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await dropStaleDatabases(admin, base);
    await admin.query(`drop database if exists ${quoteIdent(template)} with (force)`);
    await admin.query(`create database ${quoteIdent(template)}`);
  } finally {
    await admin.end();
  }

  const templateUrl = new URL(adminUrl);
  templateUrl.pathname = `/${template}`;
  const pool = new pg.Pool({ connectionString: templateUrl.toString(), max: 1 });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }

  const [garmin, claude] = await Promise.all([
    startGarminService(project),
    startFakeClaude(path.join(import.meta.dirname, "fixtures/claude")),
  ]);

  project.provide("adminDatabaseUrl", adminUrl.toString());
  project.provide("templateDatabase", template);
  project.provide("runPid", process.pid);
  project.provide("garminServicePort", Number(new URL(garmin.url).port));
  project.provide("claudeBaseUrl", claude.url);

  return async () => {
    await Promise.all([garmin.stop(), claude.close()]);
    const teardown = new pg.Client({ connectionString: adminUrl.toString() });
    await teardown.connect();
    try {
      await teardown.query(`drop database if exists ${quoteIdent(template)} with (force)`);
    } finally {
      await teardown.end();
    }
  };
}
