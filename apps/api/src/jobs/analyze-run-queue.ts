import type { JobWithMetadata, SendOptions } from "pg-boss";
import { z } from "zod";
import { getBoss } from "./boss";

// The analyze-run queue without its handler (analyze-run.ts): the sync and Ask the coach queue through
// these from services/insights.ts, which the handler imports, so they cannot live with the handler.

export const name = "analyze-run";

/** The run whose coach card the job writes, and its owner, whose key and settings it reads. */
export const data = z.object({ userId: z.uuid(), activityId: z.uuid() }).strict();
export type AnalyzeRunData = z.infer<typeof data>;

/**
 * "stately": per run (singletonKey), at most one job queued and one active, so a double tap on Ask the
 * coach, or a sync and a tap, fold into the one waiting.
 */
export const queue = { policy: "stately" } as const;

export const jobOptions = {
  // A timeout, 429 or Claude down after callCoach's own retry: four more tries, about 2-4, 4-8, 8-16 and
  // 16-32 minutes apart (pg-boss doubles retryDelay with jitter), so the card arrives within about an hour
  // of an outage ending. The last try stores the fallback card instead of throwing.
  retryLimit: 4,
  retryBackoff: true,
  retryDelay: 2 * 60,
  retryDelayMax: 60 * 60,
  // One Claude call of up to 60 s, and its one retry on the fallback model.
  expireInSeconds: 5 * 60,
} satisfies SendOptions;

/**
 * No job id: a deterministic one would keep the completed job and refuse every later send, so Try again
 * after a key fix could never queue. The handler's check for the coach's card and the one-insight-per-run
 * index make a second run a no-op instead.
 */
export function sendOptions(job: AnalyzeRunData): SendOptions {
  return { ...jobOptions, singletonKey: job.activityId };
}

/** Queues the coach's card for one run; null when a job for the run already waits, which covers it. */
export async function enqueueAnalyzeRun(job: AnalyzeRunData): Promise<string | null> {
  const parsed = data.parse(job);
  return getBoss().send(name, parsed, sendOptions(parsed));
}

// A job in one of these states is still pg-boss's to run (boss.ts says the same for findPendingJob).
const LIVE_STATES: ReadonlySet<JobWithMetadata["state"]> = new Set(["created", "retry", "active"]);

/**
 * What pg-boss is doing about the run's card: null when no job for it is live, "retrying" when one has
 * failed at least once (waiting out its backoff, or running again), else "pending".
 */
export async function analyzeRunState(activityId: string): Promise<"pending" | "retrying" | null> {
  const jobs = (await getBoss().findJobs(name, { key: activityId })).filter((job) =>
    LIVE_STATES.has(job.state),
  );
  if (jobs.length === 0) return null;
  return jobs.some((job) => job.state === "retry" || job.retryCount > 0) ? "retrying" : "pending";
}
