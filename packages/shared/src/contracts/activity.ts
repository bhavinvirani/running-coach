import { z } from "zod";

/** One stored run as the web app reads it. Pace is derived by the client from distanceM and durationS. */
export const activitySchema = z
  .object({
    id: z.uuid(),
    /** Garmin's activityType.typeKey: running, treadmill_running, trail_running, ... */
    type: z.string().min(1),
    startUtc: z.iso.datetime(),
    /** Wall-clock start in the activity's own time zone, without an offset; the date shown to the runner. */
    startLocal: z.iso.datetime({ local: true }),
    /** IANA zone when known; Garmin's activity list has none. */
    tz: z.string().nullable(),
    distanceM: z.number().nonnegative(),
    durationS: z.number().nonnegative(),
    avgHr: z.number().nonnegative().nullable(),
    maxHr: z.number().nonnegative().nullable(),
    /** Steps per minute. */
    cadence: z.number().nonnegative().nullable(),
    elevationGainM: z.number().nullable(),
    isIndoor: z.boolean(),
    isManual: z.boolean(),
  })
  .strict();
export type Activity = z.infer<typeof activitySchema>;

/** GET /api/activities/latest: the run with the latest start, or null before the first one is stored. */
export const latestActivityResponseSchema = z
  .object({ activity: activitySchema.nullable() })
  .strict();
export type LatestActivityResponse = z.infer<typeof latestActivityResponseSchema>;
