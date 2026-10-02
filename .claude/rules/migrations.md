---
paths:
  - "apps/api/src/db/**"
---
# Schema and migrations (apps/api/src/db)

- Schema in `schema/<group>.ts` with Drizzle. Tables and columns snake_case. Every table has `id uuid default gen_random_uuid()`, `created_at` and `updated_at timestamptz`. User-owned tables have `user_id` with an index and `on delete cascade`.
- Units in column names: `distance_m`, `duration_s`, `elevation_gain_m`, `start_utc`, `target_time_s`. Time zones as IANA text in `tz`. `jsonb` only for shapes the app never filters on (`summary`, `target`, `steps`, `content`, `usage`).
- `pnpm db:generate --name <verb>_<thing>` writes `migrations/NNNN_<verb>_<thing>.sql` and the journal; commit both and never hand-edit a committed migration or the journal.
- Expand and contract only, because the previous build keeps serving until the new one is healthy: new columns nullable or with a default; backfill in a job; drop or rename in a later migration after the code stops reading the old name. A migration that loses data needs an approving comment on its issue.
- Migrations run at process start before the server listens, each in a transaction, under an advisory lock so two starts cannot race.
- Encrypted columns end in `_enc` and hold the `v1:` prefixed ciphertext; a plaintext twin is never added.
- Each migration ships with an integration test on a real Postgres that applies it and exercises the new query path.

Reference (phase 5): `schema/user-settings.ts`, `migrations/0001_create_user_settings.sql`.
