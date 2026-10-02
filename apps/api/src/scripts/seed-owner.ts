// pnpm seed:owner: creates or updates the owner account from OWNER_EMAIL, OWNER_PASSWORD and OWNER_NAME.
// Applies pending migrations first, so it also works on a fresh database.
import { pool } from "../db/client";
import { runMigrations } from "../db/migrate";
import { config } from "../lib/config";
import { seedOwner } from "../services/owner";

if (!config.OWNER_EMAIL || !config.OWNER_PASSWORD) {
  console.error(
    "Set OWNER_EMAIL and OWNER_PASSWORD (at least 8 characters), and optionally OWNER_NAME, then run again.",
  );
  process.exit(1);
}

try {
  await runMigrations(pool);
  const result = await seedOwner({
    email: config.OWNER_EMAIL,
    password: config.OWNER_PASSWORD,
    name: config.OWNER_NAME,
  });
  console.log(`Owner account ${result}.`);
} catch (err) {
  console.error("Seeding the owner failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
