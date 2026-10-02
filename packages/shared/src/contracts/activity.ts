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
    calories: z.number().nonnegative().nullable(),
    elevationGainM: z.number().nullable(),
    isIndoor: z.boolean(),
    isManual: z.boolean(),
    /**
     * Garmin's eventType.typeKey as the runner set it in Garmin Connect: race, training, recreation,
     * uncategorized, ... The app reads "race"; null when Garmin sends none. A plan's session type is a
     * separate field once a plan links runs to sessions.
     */
    eventType: z.string().min(1).nullable(),
  })
  .strict();
export type Activity = z.infer<typeof activitySchema>;

/** The one event type the app shows today. */
export const RACE_EVENT_TYPE = "race";

/** One lap as the watch recorded it, in SI; on an auto-lap watch these are the per-km splits. */
export const activityLapSchema = z
  .object({
    /** Lap number as the watch shows it, starting at 1. */
    index: z.number().int().min(1),
    distanceM: z.number().nonnegative(),
    durationS: z.number().nonnegative(),
    avgHr: z.number().nonnegative().nullable(),
    /** Steps per minute. */
    avgCadence: z.number().nonnegative().nullable(),
  })
  .strict();
export type ActivityLap = z.infer<typeof activityLapSchema>;

/**
 * Row-aligned samples of the run as Garmin's detail call thins them (about 2000 points): every array
 * has the length of `elapsedS`, empty when Garmin holds no samples (a manual entry). A whole series is
 * null when the watch did not record it (no HR, no elevation indoors); one sample is null where that
 * reading alone is missing.
 */
export const activityStreamsSchema = z
  .object({
    /** Timer seconds from the start, non-decreasing. */
    elapsedS: z.array(z.number().nonnegative()),
    distanceM: z.array(z.number().nonnegative()),
    hr: z.array(z.number().nonnegative().nullable()).nullable(),
    /** Steps per minute. */
    cadence: z.array(z.number().nonnegative().nullable()).nullable(),
    elevationM: z.array(z.number().nullable()).nullable(),
    speedMps: z.array(z.number().nonnegative().nullable()).nullable(),
  })
  .strict()
  .refine(
    (streams) =>
      [streams.distanceM, streams.hr, streams.cadence, streams.elevationM, streams.speedMps].every(
        (series) => series === null || series.length === streams.elapsedS.length,
      ),
    { message: "every series must have the length of elapsedS" },
  );
export type ActivityStreams = z.infer<typeof activityStreamsSchema>;

/** Seconds spent in one of Garmin's five zones, with the zone's lower bound from the runner's Garmin settings. */
export const hrZoneTimeSchema = z
  .object({
    zone: z.number().int().min(1).max(5),
    lowBpm: z.number().nonnegative(),
    seconds: z.number().nonnegative(),
  })
  .strict();
export type HrZoneTime = z.infer<typeof hrZoneTimeSchema>;

/** [latitude, longitude] in degrees. */
export const routePointSchema = z.tuple([
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
]);
export type RoutePoint = z.infer<typeof routePointSchema>;

/** What Garmin holds about one run beyond its summary, fetched once and stored. */
export const activityDetailSchema = z
  .object({
    laps: z.array(activityLapSchema),
    streams: activityStreamsSchema,
    /** The GPS track in order, null for an indoor run or a manual entry. */
    route: z.array(routePointSchema).nullable(),
    /** Garmin's five zones in order, null when the run has no heart rate. */
    hrZones: z.array(hrZoneTimeSchema).nullable(),
  })
  .strict();
export type ActivityDetail = z.infer<typeof activityDetailSchema>;

export const activityParamsSchema = z.object({ id: z.uuid() }).strict();
export type ActivityParams = z.infer<typeof activityParamsSchema>;

/**
 * GET /api/activities/:id reads what is stored; `detail` is null until POST /api/activities/:id/detail
 * has fetched the laps, samples, route and zones from Garmin, which answers with the same shape.
 */
export const activityResponseSchema = z
  .object({
    activity: activitySchema,
    detail: activityDetailSchema.nullable(),
  })
  .strict();
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

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
