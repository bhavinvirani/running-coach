import { ErrorCode } from "@running-coach/shared";
import type { Job, PgBoss } from "pg-boss";
import { DEFAULT_RETRY_AFTER_S } from "../garmin/client";
import { DomainError } from "../lib/errors";
import { logger, withRequestId } from "../lib/logger";
import { pushWorkouts, type PushWorkoutsResult } from "../services/workout-push";
import { data, jobOptions, name } from "./push-workouts-queue";

// Keeps the runner's next seven days on Garmin in the background, queued after every calendar edit, goal
// save and reconnect, and by the daily cron (SPEC: Garmin calendar). The queue's name, data and options
// live in push-workouts-queue.ts.

export { cronJobId, data, jobOptions, name, queue, sendOptions } from "./push-workouts-queue";
export type { PushWorkoutsData } from "./push-workouts-queue";

export type PushWorkoutsOutput =
  | ({ status: "ok" } & PushWorkoutsResult)
  | { status: "rate_limited"; retryAfterSeconds: number; rescheduledJobIds: string[] }
  | { status: "garmin_auth_expired" | "garmin_not_connected" };

/**
 * Runs one push, from the user's local date now. As for sync-garmin: a 429 pushes back every push of the
 * user still waiting, or queues a successor when none waits, to start after retryAfterSeconds, and the job
 * completes without counting a failed attempt; an expired or missing login completes, since retrying
 * cannot fix it. The push has stored the ids it made and its error by then. Anything else throws, and
 * pg-boss retries with backoff; the retry sends only what is still missing.
 */
export async function handle(
  boss: PgBoss,
  job: Job<unknown>,
  clock?: () => Date,
): Promise<PushWorkoutsOutput> {
  const input = data.parse(job.data);
  return withRequestId(`job-${job.id}`, async () => {
    const log = logger.child({ module: "jobs", job: name, jobId: job.id, userId: input.userId });
    try {
      const result = await pushWorkouts({
        userId: input.userId,
        ...(clock ? { now: clock() } : {}),
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
        log.warn({ retryAfterSeconds, rescheduledJobIds }, "garmin rate limited; push rescheduled");
        return { status: "rate_limited", retryAfterSeconds, rescheduledJobIds };
      }
      if (
        error.code === ErrorCode.garminAuthExpired ||
        error.code === ErrorCode.garminNotConnected
      ) {
        log.warn({ code: error.code }, "workout push skipped");
        return { status: error.code };
      }
      throw error;
    }
  });
}
