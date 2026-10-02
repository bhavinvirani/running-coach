import { z } from "zod";

/**
 * POST /api/sync (no body): Sync now. Runs one Garmin sync for the signed-in user and answers when it is
 * done, so a 409, 429 or 502 reaches the screen that asked; background syncs go through the job queue.
 */
export const syncResponseSchema = z
  .object({
    lastSyncAt: z.iso.datetime(),
    /** Runs inserted or changed; 0 when everything was already stored. */
    activitiesWritten: z.number().int().nonnegative(),
  })
  .strict();
export type SyncResponse = z.infer<typeof syncResponseSchema>;
