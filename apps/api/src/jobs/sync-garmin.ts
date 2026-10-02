import { ErrorCode } from "@running-coach/shared";
import type { Job, PgBoss } from "pg-boss";
import { DEFAULT_RETRY_AFTER_S } from "../garmin/client";
import { DomainError } from "../lib/errors";
import { logger, withRequestId } from "../lib/logger";
import { syncGarmin, type SyncGarminResult } from "../services/garmin-sync";
import { data, jobOptions, name } from "./sync-garmin-queue";

// Pulls a user's new Garmin runs in the background, queued by the daily cron (POST /api/cron/sync). App
// open and the Sync button do not come through here: POST /api/sync calls the service directly, so its
// 409, 429 or 502 reaches the screen that asked. The queue's name, data and options live in
// sync-garmin-queue.ts.

export { data, jobId, jobOptions, name, queue, sendOptions } from "./sync-garmin-queue";
export type { SyncGarminData } from "./sync-garmin-queue";

export type SyncGarminOutput =
  | ({ status: "ok" } & SyncGarminResult)
  | { status: "rate_limited"; retryAfterSeconds: number; rescheduledJobIds: string[] }
  | { status: "garmin_auth_expired" | "garmin_not_connected" };

/**
 * Runs one sync, up to the user's local date now. A 429 is the one failure the job handles itself: every
 * sync of the user's still waiting (the next day's cron, a retry) is pushed back to start after
 * retryAfterSeconds, or a successor is queued for then when none waits, and the job completes. Stately
 * allows one queued job per user, so a plain send would be dropped beside a waiting job, which would then
 * call Garmin seconds after the 429. Handling the same 429 twice only moves that successor again. The 429
 * never counts as a failed attempt. A bundle Garmin rotated before it is already stored by then (garmin
 * client). An expired or missing connection completes too: retrying cannot fix it, and every retry would be
 * another failed Garmin login. Anything else throws, and pg-boss retries with backoff.
 */
export async function handle(
  boss: PgBoss,
  job: Job<unknown>,
  clock?: () => Date,
): Promise<SyncGarminOutput> {
  const input = data.parse(job.data);
  return withRequestId(`job-${job.id}`, async () => {
    const log = logger.child({
      module: "jobs",
      job: name,
      jobId: job.id,
      userId: input.userId,
      date: input.date,
    });
    try {
      const result = await syncGarmin({
        userId: input.userId,
        // Never the cron's date: see `data`. Without a clock, the service reads the time under the lock.
        ...(clock ? { now: clock() } : {}),
        signal: job.signal,
      });
      return { status: "ok", ...result };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      if (error.code === ErrorCode.garminRateLimited) {
        const retryAfterSeconds = error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_S;
        const { jobs: rescheduledJobIds } = await boss.upsert(name, input, {
          ...jobOptions,
          singletonKey: input.userId,
          match: "all",
          startAfter: retryAfterSeconds,
        });
        log.warn({ retryAfterSeconds, rescheduledJobIds }, "garmin rate limited; sync rescheduled");
        return { status: "rate_limited", retryAfterSeconds, rescheduledJobIds };
      }
      if (
        error.code === ErrorCode.garminAuthExpired ||
        error.code === ErrorCode.garminNotConnected
      ) {
        log.warn({ code: error.code }, "garmin sync skipped");
        return { status: error.code };
      }
      throw error;
    }
  });
}
