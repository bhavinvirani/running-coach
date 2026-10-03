import type { SendOptions } from "pg-boss";
import { z } from "zod";
import { deterministicJobId, findPendingJob, getBoss } from "./boss";

// The push-workouts queue without its handler (push-workouts.ts): every calendar edit, goal save and
// reconnect queues through these from their services, and the daily cron from services/daily-sync.ts,
// while the handler imports the push service, so they cannot live with the handler.

export const name = "push-workouts";

/**
 * Only the user. The work is "whatever differs between the sessions and Garmin", read when the job runs,
 * so a push queued by an edit has no id: a send while one waits folds into it, and a duplicate finds
 * nothing to send.
 */
export const data = z.object({ userId: z.uuid() }).strict();
export type PushWorkoutsData = z.infer<typeof data>;

/** The daily cron's push, keyed on user and the fire's UTC date like its sync, so a double fire runs once. */
export function cronJobId(job: PushWorkoutsData, date: string): string {
  return deterministicJobId(`${name}:${job.userId}:${date}`);
}

/**
 * "stately": per user (singletonKey), at most one push queued and one active. An edit during a running push
 * queues the one that sends it; a burst of edits folds into that one.
 */
export const queue = { policy: "stately" } as const;

export const jobOptions = {
  // Every attempt is a new Garmin login and the service already retried inside its session: two retries,
  // 5 to 10 and then 10 to 20 minutes later, as for sync. The ids a stopped batch made are stored first.
  retryLimit: 2,
  retryBackoff: true,
  retryDelay: 5 * 60,
  retryDelayMax: 30 * 60,
  // Up to five batches of WORKOUT_SYNC_TIMEOUT_MS (3 min) each, after waiting on the user lock behind a
  // sync: an expired job would be retried while it still runs.
  expireInSeconds: 20 * 60,
} satisfies SendOptions;

export function sendOptions(job: PushWorkoutsData): SendOptions {
  return { ...jobOptions, singletonKey: job.userId };
}

/**
 * Queues a push of the user's calendar; `date` makes it the daily cron's push for that UTC date. Null when
 * nothing new was queued: a push of the user waits and covers it, or that date's already exists.
 */
export async function enqueuePushWorkouts(
  job: PushWorkoutsData,
  { date }: { date?: string } = {},
): Promise<string | null> {
  const parsed = data.parse(job);
  const options = sendOptions(parsed);
  return getBoss().send(
    name,
    parsed,
    date === undefined ? options : { ...options, id: cronJobId(parsed, date) },
  );
}

/**
 * Whether a push of the user runs or is due now: the web app shows "Sending" for it, and the stored error
 * while every push waits out a retry's backoff or a 429's hour. A Send to Garmin or an edit after an outage
 * queues a push that runs beside the one parked in retry, so that one alone does not answer.
 */
export async function isPushing(userId: string): Promise<boolean> {
  return (await findPendingJob(name, userId))?.due ?? false;
}
