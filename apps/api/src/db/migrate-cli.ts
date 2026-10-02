// pnpm db:migrate: applies pending migrations to DATABASE_URL and exits.
import { logger } from "../lib/logger";
import { pool } from "./client";
import { runMigrations } from "./migrate";

try {
  await runMigrations(pool);
  logger.info("migrations applied");
} catch (err) {
  logger.fatal({ err }, "migrations failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
