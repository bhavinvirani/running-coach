import { z } from "zod";
import { distanceKeySchema } from "../distances";
import { errorCodeSchema } from "../error-codes";

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

/**
 * One of a run's own best efforts (its fastest stretch at a distance it covered), and whether it is the
 * runner's current personal best there, by the same rule as GET /api/personal-bests.
 */
export const runBestEffortSchema = z
  .object({
    distanceKey: distanceKeySchema,
    /** Timer seconds for the distance, unrounded; the web app formats them and derives the pace. */
    timeS: z.number().positive(),
    personalBest: z.boolean(),
  })
  .strict();
export type RunBestEffort = z.infer<typeof runBestEffortSchema>;

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
 * Garmin's records as last fetched; how many runs still wait for their best efforts (the first pass over a
 * long history takes a while, and the list fills in as it goes); and whether that work is under way or
 * stopped, and why, so the screen polls only while something will change.
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
    /** A best-efforts job for the runner is waiting, deferred, retrying or running. */
    checking: z.boolean(),
    /**
     * Why pending runs are not being checked right now: with no job, the Garmin login expired or is missing
     * or the last try failed (garmin_unavailable, ...); with a job held back (a 429's hour, a retry's
     * backoff), the failure that held it. Null while a job runs or waits its turn, when nothing is pending,
     * or when no reason is known (the next sync queues the work again).
     */
    errorCode: errorCodeSchema.nullable(),
  })
  .strict();
export type PersonalBestsResponse = z.infer<typeof personalBestsResponseSchema>;
