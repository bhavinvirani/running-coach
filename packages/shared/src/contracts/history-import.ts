import { z } from "zod";
import { errorCodeSchema } from "../error-codes";

/**
 * The full-history import. "stalled" is derived, never stored: an import still marked running or paused
 * with no page job left to run it (its job chain died with the process), which POST /api/import resumes.
 */
export const importStatusSchema = z.enum([
  "not_started",
  "running",
  "paused",
  "stalled",
  "failed",
  "done",
]);
export type ImportStatus = z.infer<typeof importStatusSchema>;

/**
 * GET /api/import, and POST /api/import (no body), which starts an import when none ran or the last one
 * finished, resumes a failed or stalled one from its cursor, and changes nothing while one is running or
 * paused.
 */
export const importProgressSchema = z
  .object({
    status: importStatusSchema,
    /** Every run stored for the runner, from imports and syncs alike: the number to compare with Garmin's. */
    runsStored: z.number().int().nonnegative(),
    /** Local start date of the oldest run the import has reached; null before its first page. */
    oldestDate: z.iso.date().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    /** While paused after a Garmin 429: when the import continues by itself. */
    resumeAt: z.iso.datetime().nullable(),
    /** Why the import is paused or failed. */
    errorCode: errorCodeSchema.nullable(),
  })
  .strict();
export type ImportProgress = z.infer<typeof importProgressSchema>;
