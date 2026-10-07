// `node e2e/reset-database.ts`: drops and recreates the e2e database named by DATABASE_URL, which
// playwright.config.ts sets for the API it starts and runs this from, before that API boots and migrates.
// Each run starts on a fresh database, so no branch sees another branch's migrations, and a run killed
// mid-way leaves nothing the next run trips on. Only an e2e slot's database (e2e/fixtures/slot.ts) is
// touched. Silent on success.
// Runs on Node's type stripping: no relative imports, no TypeScript-only runtime syntax.
import pg from "pg";

const E2E_DATABASE = /^running_coach_e2e(_[1-9])?$/;
const CONNECT_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error("DATABASE_URL is not set; playwright.config.ts sets it for the e2e API.");

  // Never printed: the URL holds the password.
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a URL.");
  }
  const database = decodeURIComponent(target.pathname.slice(1));
  if (!E2E_DATABASE.test(database)) {
    throw new Error(
      `Refusing to reset ${JSON.stringify(database)}: only running_coach_e2e and running_coach_e2e_1 to _9 are e2e databases.`,
    );
  }

  // A database cannot be dropped over a connection to itself: connect to the same server's maintenance one.
  const maintenance = new URL(target);
  maintenance.pathname = "/postgres";
  const client = new pg.Client({
    connectionString: maintenance.toString(),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`Could not reach Postgres to recreate ${database}: ${errorDetail(error)}`, {
      cause: error,
    });
  }
  try {
    // The name matched the pattern above, so quoting it is safe. force ends any session still open on it,
    // such as an orphaned API's.
    await client.query(`drop database if exists "${database}" with (force)`);
    await client.query(`create database "${database}"`);
  } catch (error) {
    throw new Error(`Could not recreate ${database}: ${errorDetail(error)}`, { cause: error });
  } finally {
    await client.end();
  }
}

/** A refused connection is an AggregateError (one per address) with an empty message and only a code. */
function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message || (error as NodeJS.ErrnoException).code || error.name;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
