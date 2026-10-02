import type { SendOptions } from "pg-boss";
import { z } from "zod";
import { getBoss } from "./boss";

// The best-efforts queue without its handler (best-efforts.ts): the sync and the history import queue it
// from their services, which the handler's service sits beside, so these cannot live with the handler.

export const name = "best-efforts";

/**
 * Only the user. The work is "whatever runs are pending", read from activity.best_efforts_version when the
 * job runs, so there is no deterministic id: a duplicate or a double fire finds nothing pending and calls
 * no one, and the stately queue folds repeated sends into the one waiting.
 */
export const data = z.object({ userId: z.uuid() }).strict();
export type BestEffortsData = z.infer<typeof data>;

/**
 * "stately": per user (singletonKey), at most one batch queued and one active. A running batch can queue
 * its successor, and a sync or import page while one waits folds into it.
 */
export const queue = { policy: "stately" } as const;

export const jobOptions = {
  // Every attempt is a new Garmin login and the service already retried inside its session: two retries,
  // 5 to 10 and then 10 to 20 minutes later, as for sync.
  retryLimit: 2,
  retryBackoff: true,
  retryDelay: 5 * 60,
  retryDelayMax: 30 * 60,
  // One batch is one Garmin call of up to 60 s, but it may first wait on the user lock behind a sync.
  expireInSeconds: 10 * 60,
} satisfies SendOptions;

/**
 * Seconds before a batch queued beside a running one may start: its successor, or a sync's or an import
 * page's send while one runs. Every batch is a Garmin login, and a first pass over a long history (or an
 * import whose pages each queue a batch) would otherwise log in every few seconds for minutes, the pattern
 * Garmin rate-limits; a batch queued when none runs still starts at once.
 */
export const BATCH_GAP_S = 30;

export function sendOptions(job: BestEffortsData): SendOptions {
  return { ...jobOptions, singletonKey: job.userId };
}

/**
 * Queues a batch for the user, `startAfter` seconds from now when given; null when one already waits,
 * which then covers it.
 */
export async function enqueueBestEfforts(
  job: BestEffortsData,
  { startAfter }: { startAfter?: number } = {},
): Promise<string | null> {
  const parsed = data.parse(job);
  const options = sendOptions(parsed);
  return getBoss().send(
    name,
    parsed,
    startAfter === undefined ? options : { ...options, startAfter },
  );
}
