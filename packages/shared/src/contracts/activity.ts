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

/**
 * GET /api/activities: the runner's runs grouped by week, newest first, a page of whole weeks at a time so
 * a week's total is never split across pages. Weeks without runs are left out.
 */
export const activityWeeksQuerySchema = z
  .object({
    /** Only weeks starting before this date; the previous page's `nextBefore`. The latest weeks when absent. */
    before: z.iso.date().optional(),
    weeks: z.coerce.number().int().min(1).max(26).default(8),
  })
  .strict();
export type ActivityWeeksQuery = z.infer<typeof activityWeeksQuerySchema>;

export const activityWeekSchema = z
  .object({
    /** Monday of the week, from the runs' local start dates: the week the runner lived, whatever the zone. */
    weekStart: z.iso.date(),
    distanceM: z.number().nonnegative(),
    durationS: z.number().nonnegative(),
    /** Newest first. */
    runs: z.array(activitySchema).min(1),
  })
  .strict();
export type ActivityWeek = z.infer<typeof activityWeekSchema>;

export const activityWeeksResponseSchema = z
  .object({
    weeks: z.array(activityWeekSchema),
    /** `before` for the next page; null when no older run exists. */
    nextBefore: z.iso.date().nullable(),
  })
  .strict();
export type ActivityWeeksResponse = z.infer<typeof activityWeeksResponseSchema>;
