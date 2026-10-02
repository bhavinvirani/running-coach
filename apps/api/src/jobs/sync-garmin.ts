import { ErrorCode } from "@running-coach/shared";
import type { Job, PgBoss, SendOptions } from "pg-boss";
import { z } from "zod";
import { DEFAULT_RETRY_AFTER_S } from "../garmin/client";
import { DomainError } from "../lib/errors";
import { logger, withRequestId } from "../lib/logger";
import { syncGarmin, type SyncGarminResult } from "../services/garmin-sync";
import { deterministicJobId } from "./boss";

// Pulls a user's new Garmin runs in the background, enqueued on app open and by the daily cron (slice 5).
// The Sync button does not come through here: POST /api/sync calls the service directly, so its 409, 429
// or 502 reaches the screen that asked.

export const name = "sync-garmin";

/**
 * `trigger` says who queued it. The cron also names the user's local date at that moment, which only keys
 * the job id: the sync itself runs up to the user's local date when it runs, so a job deferred by a 429
 * past midnight still reads today.
 */
export const data = z.discriminatedUnion("trigger", [
  z.object({ userId: z.uuid(), trigger: z.literal("cron"), date: z.iso.date() }).strict(),
  z.object({ userId: z.uuid(), trigger: z.literal("user") }).strict(),
]);
export type SyncGarminData = z.infer<typeof data>;

/**
 * The cron's id is keyed on user and date, so the cron firing twice runs once. App open gets no id: a
 * run saved at 18:00 must still sync after the 07:00 one, and the stately queue already folds repeated
 * opens into the one queued job.
 */
export function jobId(job: SyncGarminData): string | undefined {
  return job.trigger === "cron"
    ? deterministicJobId(`${name}:${job.userId}:${job.date}`)
    : undefined;
}

/**
 * "stately": per user (singletonKey), at most one job queued and one active. A sync that is running can
 * still queue its own successor, which "exclusive" (one queued or active) would refuse.
 */
export const queue = { policy: "stately" } as const;

const jobOptions = {
  // The service already retried Garmin inside its session, and every attempt here is a new Garmin login:
  // two retries, 5 to 10 and then 10 to 20 minutes later, ride out a short outage without hammering a
  // long one, which the next cron or app open covers.
  retryLimit: 2,
  retryBackoff: true,
  retryDelay: 5 * 60,
  retryDelayMax: 30 * 60,
  // Five 7-day chunks at up to 60 s each, with the service's own retries, fit well inside.
  expireInSeconds: 15 * 60,
} satisfies SendOptions;

export function sendOptions(job: SyncGarminData): SendOptions {
  const id = jobId(job);
  return { ...jobOptions, singletonKey: job.userId, ...(id ? { id } : {}) };
}

export type SyncGarminOutput =
  | ({ status: "ok" } & SyncGarminResult)
  | { status: "rate_limited"; retryAfterSeconds: number; rescheduledJobIds: string[] }
  | { status: "garmin_auth_expired" | "garmin_not_connected" };

/**
 * Runs one sync, up to the user's local date now. A 429 is the one failure the job handles itself: every
 * sync of the user's still waiting (a tap during this run, a retry) is pushed back to start after
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
      trigger: input.trigger,
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
