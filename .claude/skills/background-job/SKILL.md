---
name: background-job
description: Use when adding a pg-boss job in apps/api/src/jobs (sync, import, analyze, push workouts) that must be idempotent, locked and retried.
---
# Background job

Copy `apps/api/src/jobs/sync-garmin.ts` and `apps/api/test/jobs/sync-garmin.test.ts`.

1. Export `name`, a zod `data` schema and `jobId(data)`: a deterministic id such as `sync:<userId>:<date>` so a second enqueue is a no-op.
2. Handler: `withUserLock(userId)` around every Garmin or plan write; work in chunks and save a cursor after each so a kill mid-way resumes.
3. `boss.send` options: `retryLimit`, `retryBackoff: true`, `expireInSeconds`. A `DomainError` with code `garmin_rate_limited` is the one case where the job reschedules itself: `boss.send` the same job id again with `startAfter: retryAfterSeconds` (3600 when Garmin gives none) and return; it never counts as a failed attempt and nothing retries it sooner.
4. Register in `src/jobs/index.ts`; expose `enqueue<Name>(data)` for routes and the cron endpoint.
5. Test on the real Postgres with the fixture Garmin service: runs once; a second run does nothing more; resumes from the cursor after a thrown error; 429 reschedules; two concurrent runs for one user serialize.
