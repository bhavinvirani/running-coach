import { z } from "zod";
import { distanceKeySchema } from "../distances";

/**
 * A personal best: the fastest best effort at one distance over the runner's outdoor, non-manual runs,
 * found in a continuous stretch of any run (a 5K inside a half counts). The earlier run wins a tie.
 */
export const personalBestSchema = z
  .object({
    distanceKey: distanceKeySchema,
    /** Timer seconds for the distance, unrounded; the web app formats them. */
    timeS: z.number().positive(),
    /** The run it came from. */
    activityId: z.uuid(),
    /** The run's start; the web app shows the local date and counts a best as new for a week from it. */
    startUtc: z.iso.datetime(),
    startLocal: z.iso.datetime({ local: true }),
  })
  .strict();
export type PersonalBest = z.infer<typeof personalBestSchema>;

/** One of Garmin's own running records, shown beside the app's for comparison. */
export const garminRecordSchema = z
  .object({
    distanceKey: distanceKeySchema,
    timeS: z.number().positive(),
    /** When Garmin says the record was set: the run's start when Garmin names the run. */
    achievedAt: z.iso.datetime(),
  })
  .strict();
export type GarminRecord = z.infer<typeof garminRecordSchema>;

/**
 * GET /api/personal-bests: the runner's bests, shortest distance first, one per distance reached so far;
 * Garmin's records as last fetched; and how many runs still wait for their best efforts (the first pass
 * over a long history takes a while, and the list fills in as it goes).
 */
export const personalBestsResponseSchema = z
  .object({
    bests: z.array(personalBestSchema),
    /** Null until a best-efforts pass has fetched Garmin's records. */
    garmin: z
      .object({
        records: z.array(garminRecordSchema),
        fetchedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    pendingRuns: z.number().int().nonnegative(),
  })
  .strict();
export type PersonalBestsResponse = z.infer<typeof personalBestsResponseSchema>;
