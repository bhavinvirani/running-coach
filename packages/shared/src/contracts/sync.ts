import { z } from "zod";

/**
 * POST /api/sync (no body): Sync now, also run by the web app when it opens. Runs one Garmin sync for the
 * signed-in user and answers when it is done, so a 409, 429 or 502 reaches the screen that asked; a sync
 * started while one runs for the user joins it. The daily cron's syncs go through the job queue.
 */
export const syncResponseSchema = z
  .object({
    lastSyncAt: z.iso.datetime(),
    /** Runs inserted or changed; 0 when everything was already stored. */
    activitiesWritten: z.number().int().nonnegative(),
    /** Stored runs removed because Garmin no longer lists them (deleted there); usually 0. */
    activitiesRemoved: z.number().int().nonnegative(),
  })
  .strict();
export type SyncResponse = z.infer<typeof syncResponseSchema>;

/**
 * POST /api/cron/sync: the daily GitHub Actions cron, behind the CRON_SECRET bearer token. Queues one
 * background sync per user whose Garmin login works, keyed on the fire's UTC date, so a second fire on the
 * same UTC day queues nothing. An expired or missing login is left out: only the runner can reconnect it.
 */
export const cronSyncResponseSchema = z
  .object({
    /** Users whose Garmin login works (status ok). */
    connected: z.number().int().nonnegative(),
    /** Syncs this call queued; 0 when each of those users already has this UTC day's. */
    queued: z.number().int().nonnegative(),
  })
  .strict();
export type CronSyncResponse = z.infer<typeof cronSyncResponseSchema>;
