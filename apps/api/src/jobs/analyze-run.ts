import type { Job, JobWithMetadata } from "pg-boss";
import { logger, withRequestId } from "../lib/logger";
import { type AnalyzeRunOutcome, analyzeRun } from "../services/insights";
import { data, name } from "./analyze-run-queue";

// The coach's card for one run, queued after a sync for its new runs and by Ask the coach. The queue's
// name, data and options live in analyze-run-queue.ts. No user lock: it never calls Garmin.

export { analyzeRunState, data, jobOptions, name, queue, sendOptions } from "./analyze-run-queue";
export type { AnalyzeRunData } from "./analyze-run-queue";

/**
 * Runs analyzeRun for the job's run. A timeout or Claude down throws claude_unavailable before the last
 * attempt, and pg-boss retries with backoff while the run screen reads "retrying"; the last attempt
 * (retryCount reaching retryLimit) stores the fallback card instead, so the runner gets Try again.
 */
export async function handle(
  job: Job<unknown> & Pick<JobWithMetadata, "retryLimit">,
): Promise<AnalyzeRunOutcome> {
  const input = data.parse(job.data);
  return withRequestId(`job-${job.id}`, async () => {
    const lastAttempt = job.retryCount >= job.retryLimit;
    const outcome = await analyzeRun(input.userId, input.activityId, { lastAttempt });
    if (outcome.status === "skipped") {
      logger.info(
        { module: "jobs", job: name, jobId: job.id, ...input, reason: outcome.reason },
        "run insight skipped",
      );
    }
    return outcome;
  });
}
