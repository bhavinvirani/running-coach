---
name: background-job
description: Use when adding a pg-boss job in apps/api/src/jobs (sync, import, analyze, push workouts) that must be idempotent, locked and retried.
---

# Background job

Copy `apps/api/src/jobs/sync-garmin.ts` and `apps/api/test/jobs/sync-garmin.test.ts`.

1. Export `name`, a zod `data` schema and `jobId(data)` = `deterministicJobId("<name>:<userId>:<date>")` from `src/jobs/boss.ts` (pg-boss ids are UUIDs), so a second send with that id returns null and runs nothing. The date only keys the job: the work reads the user's current local date when it runs, so a job delayed past midnight still reaches today.
2. Handler: parse `job.data`, run under `withRequestId("job-<id>")` and call one service function. The service takes `withUserLock(userId)` and works in chunks, each committing its rows and cursor on its own, so a kill mid-way resumes.
3. Queue `{ policy: "stately" }` and `sendOptions(data)` with `singletonKey: userId` (one queued and one active per user), `retryLimit`, `retryBackoff: true`, `retryDelay`, `retryDelayMax`, `expireInSeconds`. A `DomainError` with code `garmin_rate_limited` is the one case where the job reschedules itself: send a successor with `id: deterministicJobId("<job.id>:rate-limited")` and `startAfter: retryAfterSeconds` (3600 when Garmin gives none), then complete; it never counts as a failed attempt and nothing retries it sooner. `garmin_auth_expired` and `garmin_not_connected` complete without a retry.
4. Register in `src/jobs/index.ts` (`createQueue` with the queue policy, `work` with `batchSize: 1`); expose `enqueue<Name>(data)` for routes and the cron endpoint.
5. Test on the real Postgres with the fixture Garmin service: runs once however often it is enqueued; a second run stores nothing more; resumes from the cursor after a thrown error; 429 reschedules without a failed attempt; an expired login completes without retrying; two concurrent runs for one user serialize.
