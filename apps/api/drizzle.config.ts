import { defineConfig } from "drizzle-kit";

// `pnpm db:generate --name <verb>_<thing>` writes src/db/migrations/NNNN_<verb>_<thing>.sql from the schema.
// Generation needs no database; migrations are applied by src/db/migrate.ts at boot or `pnpm db:migrate`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  strict: true,
  verbose: true,
});
