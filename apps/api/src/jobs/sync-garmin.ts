import { ErrorCode } from "@running-coach/shared";
import type { Job, PgBoss, SendOptions } from "pg-boss";
import { z } from "zod";
import { DEFAULT_RETRY_AFTER_S } from "../garmin/client";
import { DomainError } from "../lib/errors";
import { logger, withRequestId } from "../lib/logger";
import { syncGarmin, type SyncGarminResult } from "../services/garmin-sync";
import { deterministicJobId } from "./boss";

// Pulls a user's new Garmin runs. Enqueued by the daily cron, app open and the Sync button (slice 5).

export const name = "sync-garmin";

export const data = z.object({ userId: z.uuid(), date: z.iso.date() }).strict();
export type SyncGarminData = z.infer<typeof data>;

/** One job per user and local date: the cron firing twice, or a second tap, is a no-op. */
export function jobId(job: SyncGarminData): string {
  return deterministicJobId(`${name}:${job.userId}:${job.date}`);
}

/**
 * "stately": per user (singletonKey), at most one job queued and one active. A sync that is running can
 * still queue its own successor, which "exclusive" (one queued or active) would refuse.
 */
export const queue = { policy: "stately" } as const;

const jobOptions = {
  retryLimit: 3,
  retryBackoff: true,
  retryDelay: 60,
  retryDelayMax: 30 * 60,
  // Five 7-day chunks at up to 60 s each, with the service's own retries, fit well inside.
  expireInSeconds: 15 * 60,
} satisfies SendOptions;

export function sendOptions(job: SyncGarminData): SendOptions {
  return { ...jobOptions, id: jobId(job), singletonKey: job.userId };
}

export type SyncGarminOutput =
  | ({ status: "ok" } & SyncGarminResult)
  | { status: "rate_limited"; retryAfterSeconds: number; rescheduledJobId: string | null }
  | { status: "garmin_auth_expired" | "garmin_not_connected" };

/**
 * Runs one sync. A 429 is the one failure the job handles itself: it queues a copy that starts after
 * retryAfterSeconds and completes, so the 429 never counts as a failed attempt and nothing calls Garmin
 * sooner. An expired or missing connection completes too: retrying cannot fix it, and every retry would
 * be another failed Garmin login. Anything else throws, and pg-boss retries with backoff.
 */
export async function handle(boss: PgBoss, job: Job<unknown>): Promise<SyncGarminOutput> {
  const input = data.parse(job.data);
  return withRequestId(`job-${job.id}`, async () => {
    const log = logger.child({ module: "jobs", job: name, jobId: job.id, userId: input.userId });
    try {
      const result = await syncGarmin({
        userId: input.userId,
        today: input.date,
        signal: job.signal,
      });
      return { status: "ok", ...result };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      if (error.code === ErrorCode.garminRateLimited) {
        const retryAfterSeconds = error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_S;
        // Derived from this job's id, so handling the same 429 twice still queues one successor.
        const rescheduledJobId = await boss.send(name, input, {
          ...sendOptions(input),
          id: deterministicJobId(`${job.id}:rate-limited`),
          startAfter: retryAfterSeconds,
        });
        log.warn({ retryAfterSeconds, rescheduledJobId }, "garmin rate limited; sync rescheduled");
        return { status: "rate_limited", retryAfterSeconds, rescheduledJobId };
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
