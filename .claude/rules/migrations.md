---
paths:
  - "apps/api/src/db/**"
---

# Schema and migrations (apps/api/src/db)

- Schema in `schema/<group>.ts` with Drizzle, exported from `schema/index.ts`. Tables and columns snake_case. Every table has `id uuid default gen_random_uuid()`, `created_at` and `updated_at timestamptz` (`id()` and `timestamps()` from `schema/columns.ts`). User-owned tables have `user_id` with an index and `on delete cascade`. Enum columns: `$type<>` and a CHECK built with `inList()` from `schema/columns.ts`, both from the shared zod enum's `.options` (a local const array only until a contract exposes the values).
- Units in column names: `distance_m`, `duration_s`, `elevation_gain_m`, `start_utc`, `target_time_s`. Time zones as IANA text in `tz`. `jsonb` only for shapes the app never filters on (`summary`, `target`, `steps`, `content`, `usage`).
- `pnpm db:generate --name <verb>_<thing>` writes `migrations/NNNN_<verb>_<thing>.sql` and the journal; commit both and never hand-edit a committed migration or the journal.
- Parallel lanes: generate a migration when the code needs it. Before ship, if `origin/main` gained one: `git checkout origin/main -- apps/api/src/db/migrations/meta`, `git rm` only your own `00NN_<name>.sql`, keep your schema change, run `pnpm db:generate --name <name>`, and check the new SQL holds only your change. Only one PR with a migration merges at a time.
- Expand and contract only, because the previous build keeps serving until the new one is healthy: new columns nullable or with a default; backfill in a job; drop or rename in a later migration after the code stops reading the old name. A migration that loses data needs an approving comment on its issue.
- Migrations run at process start before the server listens (`migrate.ts`; `pnpm db:migrate` runs the same locally): all pending migrations in one transaction, under a session advisory lock on one dedicated connection, so two starts cannot race.
- Encrypted columns end in `_enc` and hold the `v1:` prefixed ciphertext; a plaintext twin is never added.
- Each migration ships with an integration test on a real Postgres that applies it and exercises the new query path; a new table goes into `TABLES` in `apps/api/test/db/migrate.test.ts`.

Reference (phase 5): `schema/user-settings.ts`, `migrations/0001_create_user_settings.sql`.
