import type { LatestReviewResponse } from "@running-coach/shared";
import type { JobWithMetadata, SendOptions } from "pg-boss";
import { z } from "zod";
import { COACH_CALL_BUDGET_MS } from "../lib/config";
import { deterministicJobId, getBoss, HELD_BACK_AFTER_S } from "./boss";

// The weekly-review queue without its handler (weekly-review.ts): every sync queues through these from
// services/weekly-review.ts, which the handler imports, so they cannot live with the handler.

export const name = "weekly-review";

/** The runner and the Monday of the week the review covers, a local date in their zone. */
export const data = z.object({ userId: z.uuid(), weekStart: z.iso.date() }).strict();
export type WeeklyReviewData = z.infer<typeof data>;

/**
 * "stately": per runner and week (singletonKey), at most one job queued and one active, so a deferral to
 * the Claude plan's reset can queue its successor while the job that hit the limit still runs.
 */
export const queue = { policy: "stately" } as const;

/** One key per runner and week: the review's own. */
export function singletonKey(job: WeeklyReviewData): string {
  return `${job.userId}:${job.weekStart}`;
}

/**
 * Keyed on runner and week, so every sync after the week ends (the daily cron's, app open, Sync now)
 * queues the one review: a send whose id exists, queued, running or kept after completion, is a no-op.
 */
export function jobId(job: WeeklyReviewData): string {
  return deterministicJobId(`${name}:${job.userId}:${job.weekStart}`);
}

export const jobOptions = {
  // As analyze-run: a timeout, 429 or Claude down after callCoach's own retry gets four more tries, about
  // 2-4, 4-8, 8-16 and 16-32 minutes apart; the last stores the fallback card instead of throwing.
  retryLimit: 4,
  retryBackoff: true,
  retryDelay: 2 * 60,
  retryDelayMax: 60 * 60,
  // The longest coach call boot allows, plus a minute to read the week and store the card.
  expireInSeconds: COACH_CALL_BUDGET_MS / 1000 + 60,
} satisfies SendOptions;

export function sendOptions(job: WeeklyReviewData): SendOptions {
  return { ...jobOptions, singletonKey: singletonKey(job), id: jobId(job) };
}

/** Queues the review of the runner's week; null when that week's job exists already (any state). */
export async function enqueueWeeklyReview(job: WeeklyReviewData): Promise<string | null> {
  const parsed = data.parse(job);
  return getBoss().send(name, parsed, sendOptions(parsed));
}

// A job in one of these states is still pg-boss's to run (boss.ts says the same for findPendingJob).
const LIVE_STATES: ReadonlySet<JobWithMetadata["state"]> = new Set(["created", "retry", "active"]);

/** The week's review while a job writes it: the pending and retrying states of the latest contract. */
export type WeeklyReviewState = Extract<LatestReviewResponse, { state: "pending" | "retrying" }>;

/**
 * What pg-boss is doing about the week's review, as analyzeRunState reads a run's card: null when no job
 * for it is live; "retrying" with resumesAt when every live job waits to start later than
 * HELD_BACK_AFTER_S from now (deferred to the Claude plan's reset); "retrying" without it when one has
 * failed at least once or is held back beside one that runs sooner; else "pending".
 */
export async function weeklyReviewState(
  userId: string,
  weekStart: string,
): Promise<WeeklyReviewState | null> {
  const key = singletonKey({ userId, weekStart });
  const jobs = (await getBoss().findJobs(name, { key })).filter((job) =>
    LIVE_STATES.has(job.state),
  );
  if (jobs.length === 0) return null;
  const heldAfter = Date.now() + HELD_BACK_AFTER_S * 1000;
  const heldBack = (job: Pick<JobWithMetadata, "state" | "startAfter">): boolean =>
    job.state === "created" && job.startAfter.getTime() > heldAfter;
  if (jobs.every(heldBack)) {
    const resumesAt = Math.min(...jobs.map((job) => job.startAfter.getTime()));
    return { state: "retrying", resumesAt: new Date(resumesAt).toISOString() };
  }
  return jobs.some((job) => job.state === "retry" || job.retryCount > 0 || heldBack(job))
    ? { state: "retrying" }
    : { state: "pending" };
}
