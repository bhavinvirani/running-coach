---
name: db-migration
description: Use when adding or changing a table or column in apps/api/src/db, including the generated SQL migration and its test.
---

# Database migration

Copy `apps/api/src/db/schema/user-settings.ts`, `apps/api/src/db/migrations/0001_create_user_settings.sql` and `apps/api/test/db/user-settings.test.ts`.

1. Edit or add `schema/<group>.ts` and export it from `schema/index.ts`: snake_case, units in column names, `user_id` with index and cascade, `id()` and `timestamps()` from `schema/columns.ts`. Enum columns: `$type<>` and a CHECK built with `inList()` from `schema/columns.ts`, both from one list, the shared zod enum's `.options` (a local const array only until a contract exposes the values, as `coach_message.kind`).
2. `pnpm db:generate --name <verb>_<thing>`, then read the SQL: expand only (nullable or default), nothing destructive unless an issue comment approved it.
3. `pnpm db:migrate` on the dev database in the main folder only (a lane's worktree has no `.env`), then in any folder the integration test in `apps/api/test/db/<thing>.test.ts`: the migration applies on a fresh database (each test file gets a clone of the migrated template), the new query path works, old rows still read. A new table goes into `TABLES` in `test/db/migrate.test.ts`.
4. Replacing a column: this PR adds the new column and dual-writes; a later PR, after the code stops reading the old one, drops it.
