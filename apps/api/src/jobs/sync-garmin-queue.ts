import type { SendOptions } from "pg-boss";
import { z } from "zod";
import { deterministicJobId, getBoss } from "./boss";

// The sync-garmin queue without its handler (sync-garmin.ts): the daily cron queues through these from
// services/daily-sync.ts, and the handler imports the sync service beside it, so they cannot live with the
// handler. Only the cron queues syncs: app open and Sync now call POST /api/sync, which syncs in the request.

export const name = "sync-garmin";

/**
 * The user and their local date when the cron fired. The date only keys the job id: the sync itself runs up
 * to the user's local date when it runs, so a job deferred by a 429 past midnight still reads today.
 */
export const data = z.object({ userId: z.uuid(), date: z.iso.date() }).strict();
export type SyncGarminData = z.infer<typeof data>;

/** Keyed on user and date, so the cron firing twice in a day runs once. */
export function jobId(job: SyncGarminData): string {
  return deterministicJobId(`${name}:${job.userId}:${job.date}`);
}

/**
 * "stately": per user (singletonKey), at most one job queued and one active. A sync that is running can
 * still queue its own successor (a 429's deferral), which "exclusive" (one queued or active) would refuse.
 */
export const queue = { policy: "stately" } as const;

export const jobOptions = {
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
  return { ...jobOptions, singletonKey: job.userId, id: jobId(job) };
}

/**
 * Queues the cron's sync of the user for their local date. Null when nothing new was queued: that date's
 * job exists already (queued, running or done), or another sync of the user waits and covers it.
 */
export async function enqueueSyncGarmin(job: SyncGarminData): Promise<string | null> {
  const parsed = data.parse(job);
  return getBoss().send(name, parsed, sendOptions(parsed));
}
