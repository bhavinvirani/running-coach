// pnpm seed:owner: creates the owner account from OWNER_EMAIL, OWNER_PASSWORD and OWNER_NAME, or sets an
// existing owner's name and password to them. A changed password signs the owner out everywhere. Boot only
// creates a missing owner; this is the way to reset the password. Applies pending migrations first, so it
// also works on a fresh database.
import { pool } from "../db/client";
import { runMigrations } from "../db/migrate";
import { config } from "../lib/config";
import { safeErrorMessage } from "../lib/logger";
import { seedOwner } from "../services/owner";

if (!config.OWNER_EMAIL || !config.OWNER_PASSWORD) {
  console.error(
    "Set OWNER_EMAIL and OWNER_PASSWORD (at least 8 characters), and optionally OWNER_NAME, then run again.",
  );
  process.exit(1);
}

try {
  await runMigrations(pool);
  const result = await seedOwner(
    { email: config.OWNER_EMAIL, password: config.OWNER_PASSWORD, name: config.OWNER_NAME },
    { reset: true },
  );
  console.log(`Owner account ${result}.`);
} catch (err) {
  // Never the raw error: a failed query's message carries its parameters (the email, the password hash).
  console.error("Seeding the owner failed:", safeErrorMessage(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
