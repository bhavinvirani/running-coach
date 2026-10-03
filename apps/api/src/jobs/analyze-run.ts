import { ErrorCode } from "@running-coach/shared";
import type { Job, JobWithMetadata, PgBoss } from "pg-boss";
import { PLAN_LIMIT_DEFAULT_RETRY_S } from "../coach/plan-client";
import { DomainError } from "../lib/errors";
import { logger, withRequestId } from "../lib/logger";
import { type AnalyzeRunOutcome, analyzeRun } from "../services/insights";
import { data, jobOptions, name } from "./analyze-run-queue";

// The coach's card for one run, queued after a sync for its new runs and by Ask the coach. The queue's
// name, data and options live in analyze-run-queue.ts. No user lock: it never calls Garmin.

export { analyzeRunState, data, jobOptions, name, queue, sendOptions } from "./analyze-run-queue";
export type { AnalyzeRunData } from "./analyze-run-queue";

export type AnalyzeRunJobOutput =
  | AnalyzeRunOutcome
  | { status: "deferred"; retryAfterSeconds: number; rescheduledJobIds: string[] };

/**
 * Runs analyzeRun for the job's run. A timeout or Claude down throws claude_unavailable before the last
 * attempt, and pg-boss retries with backoff while the run screen reads "retrying"; the last attempt
 * (retryCount reaching retryLimit) stores the fallback card instead, so the runner gets Try again. The
 * Claude plan's usage limit is the one failure the job handles itself, on any attempt: the run's waiting
 * job (Try again during the call) is pushed back to the reset, or a successor is queued for then when
 * none waits, and the job completes, so the limit never counts as a failed attempt and never ends on the
 * fallback card. Stately allows one queued job per run, so a plain send beside a waiting job would be
 * dropped and that job would call Claude seconds after the limit.
 */
export async function handle(
  boss: PgBoss,
  job: Job<unknown> & Pick<JobWithMetadata, "retryLimit">,
): Promise<AnalyzeRunJobOutput> {
  const input = data.parse(job.data);
  return withRequestId(`job-${job.id}`, async () => {
    const log = logger.child({ module: "jobs", job: name, jobId: job.id, ...input });
    const lastAttempt = job.retryCount >= job.retryLimit;
    try {
      const outcome = await analyzeRun(input.userId, input.activityId, { lastAttempt });
      if (outcome.status === "skipped") log.info({ reason: outcome.reason }, "run insight skipped");
      return outcome;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== ErrorCode.claudePlanLimited)
        throw error;
      const retryAfterSeconds = error.retryAfterSeconds ?? PLAN_LIMIT_DEFAULT_RETRY_S;
      const { jobs: rescheduledJobIds } = await boss.upsert(name, input, {
        ...jobOptions,
        singletonKey: input.activityId,
        match: "all",
        startAfter: retryAfterSeconds,
      });
      log.warn(
        { retryAfterSeconds, rescheduledJobIds },
        "coach plan limited; run insight deferred",
      );
      return { status: "deferred", retryAfterSeconds, rescheduledJobIds };
    }
  });
}
