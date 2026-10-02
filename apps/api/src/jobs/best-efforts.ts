import { ErrorCode } from "@running-coach/shared";
import type { Job, PgBoss } from "pg-boss";
import { DEFAULT_RETRY_AFTER_S } from "../garmin/client";
import { DomainError } from "../lib/errors";
import { logger, withRequestId } from "../lib/logger";
import { type BestEffortsBatchResult, computeBestEffortsBatch } from "../services/best-efforts";
import { data, jobOptions, name, sendOptions } from "./best-efforts-queue";

// One batch of a user's best efforts per job, queued after each sync and import page while runs are
// pending, each batch queueing the next until none are. The queue's name, data and options live in
// best-efforts-queue.ts.

export { data, jobOptions, name, queue, sendOptions } from "./best-efforts-queue";
export type { BestEffortsData } from "./best-efforts-queue";

export type BestEffortsOutput =
  /** nextJobId: the successor; null when none was needed or one already waits. */
  | ({ status: "ok"; nextJobId: string | null } & BestEffortsBatchResult)
  | { status: "rate_limited"; retryAfterSeconds: number; rescheduledJobIds: string[] }
  | { status: "garmin_auth_expired" | "garmin_not_connected" };

/**
 * Runs one batch and queues the next while runs are pending, without an id: the successor re-reads what
 * is pending, so a send folded into a waiting job loses nothing.
 *
 * A 429 defers the work exactly as sync does: every waiting batch of the user moves to start after
 * retryAfterSeconds, or one is queued for then, and the job completes, never as a failed attempt. An
 * expired or missing login completes too: retrying cannot fix it, and the next sync after a reconnect
 * queues the batch again. Anything else throws, and pg-boss retries with backoff; the runs stay pending.
 */
export async function handle(boss: PgBoss, job: Job<unknown>): Promise<BestEffortsOutput> {
  const input = data.parse(job.data);
  return withRequestId(`job-${job.id}`, async () => {
    const log = logger.child({ module: "jobs", job: name, jobId: job.id, userId: input.userId });
    try {
      const result = await computeBestEffortsBatch(input.userId, { signal: job.signal });
      const nextJobId =
        result.remaining > 0 ? await boss.send(name, input, sendOptions(input)) : null;
      return { status: "ok", ...result, nextJobId };
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
        log.warn(
          { retryAfterSeconds, rescheduledJobIds },
          "garmin rate limited; best efforts rescheduled",
        );
        return { status: "rate_limited", retryAfterSeconds, rescheduledJobIds };
      }
      if (
        error.code === ErrorCode.garminAuthExpired ||
        error.code === ErrorCode.garminNotConnected
      ) {
        log.warn({ code: error.code }, "best efforts skipped");
        return { status: error.code };
      }
      throw error;
    }
  });
}
