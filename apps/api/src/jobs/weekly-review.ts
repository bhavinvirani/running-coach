import { ErrorCode } from "@running-coach/shared";
import type { Job, JobWithMetadata, PgBoss } from "pg-boss";
import { PLAN_LIMIT_DEFAULT_RETRY_S } from "../coach/plan-client";
import { DomainError } from "../lib/errors";
import { logger, withRequestId } from "../lib/logger";
import { type WriteWeeklyReviewOutcome, writeWeeklyReview } from "../services/weekly-review";
import { data, jobOptions, name, singletonKey } from "./weekly-review-queue";

// The coach's review of a runner's Monday-to-Sunday week, queued by every sync once the week has ended.
// The queue's name, data and options live in weekly-review-queue.ts. No user lock: it never calls Garmin.

export {
  data,
  jobId,
  jobOptions,
  name,
  queue,
  sendOptions,
  weeklyReviewState,
} from "./weekly-review-queue";
export type { WeeklyReviewData } from "./weekly-review-queue";

export type WeeklyReviewJobOutput =
  | WriteWeeklyReviewOutcome
  | { status: "deferred"; retryAfterSeconds: number; rescheduledJobIds: string[] };

/**
 * Runs writeWeeklyReview for the job's week, as analyze-run runs a run's card. A timeout or Claude down
 * throws claude_unavailable before the last attempt, and pg-boss retries with backoff while Today reads
 * "retrying"; the last attempt (retryCount reaching retryLimit) stores the fallback card instead. The
 * Claude plan's usage limit is handled here on any attempt: the week's waiting job is pushed back to the
 * reset, or a successor is queued for then when none waits, and the job completes, so the limit never
 * counts as a failed attempt and never ends on the fallback card.
 */
export async function handle(
  boss: PgBoss,
  job: Job<unknown> & Pick<JobWithMetadata, "retryLimit">,
  clock?: () => Date,
): Promise<WeeklyReviewJobOutput> {
  const input = data.parse(job.data);
  return withRequestId(`job-${job.id}`, async () => {
    const log = logger.child({ module: "jobs", job: name, jobId: job.id, ...input });
    const lastAttempt = job.retryCount >= job.retryLimit;
    try {
      const outcome = await writeWeeklyReview(input.userId, input.weekStart, {
        lastAttempt,
        ...(clock ? { now: clock() } : {}),
      });
      if (outcome.status === "skipped")
        log.info({ reason: outcome.reason }, "weekly review skipped");
      return outcome;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== ErrorCode.claudePlanLimited)
        throw error;
      const retryAfterSeconds = error.retryAfterSeconds ?? PLAN_LIMIT_DEFAULT_RETRY_S;
      const { jobs: rescheduledJobIds } = await boss.upsert(name, input, {
        ...jobOptions,
        singletonKey: singletonKey(input),
        match: "all",
        startAfter: retryAfterSeconds,
      });
      log.warn(
        { retryAfterSeconds, rescheduledJobIds },
        "coach plan limited; weekly review deferred",
      );
      return { status: "deferred", retryAfterSeconds, rescheduledJobIds };
    }
  });
}
