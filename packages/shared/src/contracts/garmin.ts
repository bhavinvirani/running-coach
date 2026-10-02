import { z } from "zod";
import { activityDetailSchema } from "./activity";
import { garminRecordSchema } from "./personal-bests";
import { problemSchema } from "./problem";

/**
 * Messages between the API and the Garmin service (services/garmin). The Python service validates its
 * fixtures against the JSON Schema exported from these. Every request carries the decrypted token bundle
 * and every response returns it, refreshed or unchanged; the API writes it back when it changed.
 */

/** The JSON string garminconnect's client.dumps() returns. Never logged. */
export const garminTokenBundleSchema = z.string().min(2);

/**
 * The Garmin service's problem+json. Login can rotate the refresh token and a later call in the same
 * request still fail; the error then carries the new bundle, or the runner would have to reconnect with
 * 2FA. Only between the service and the API: the public problemSchema has no tokenBundle, so a bundle can
 * never reach the browser.
 */
export const garminProblemSchema = problemSchema
  .extend({ tokenBundle: garminTokenBundleSchema.optional() })
  .strict();
export type GarminProblem = z.infer<typeof garminProblemSchema>;

/** POST /profile: the cheapest call that proves the bundle still works. */
export const garminProfileRequestSchema = z
  .object({ tokenBundle: garminTokenBundleSchema })
  .strict();
export type GarminProfileRequest = z.infer<typeof garminProfileRequestSchema>;

export const garminProfileResponseSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    profile: z.object({ displayName: z.string().nullable() }).strict(),
  })
  .strict();
export type GarminProfileResponse = z.infer<typeof garminProfileResponseSchema>;

/** POST /sync: running activities whose local start date is between startDate and endDate, inclusive. */
export const garminSyncRequestSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
  })
  .strict();
export type GarminSyncRequest = z.infer<typeof garminSyncRequestSchema>;

export const garminActivitySummarySchema = z
  .object({
    garminActivityId: z.number().int().positive(),
    /** Garmin's activityType.typeKey: running, treadmill_running, trail_running, ... */
    type: z.string().min(1),
    startUtc: z.iso.datetime(),
    /** Wall-clock start in the activity's own time zone, without an offset. */
    startLocal: z.iso.datetime({ local: true }),
    /** IANA zone; Garmin's activity list has none, the detail call fills it later. */
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
    /** Garmin's eventType.typeKey (race, training, recreation, uncategorized, ...), null when absent. */
    eventType: z.string().min(1).nullable(),
  })
  .strict();
export type GarminActivitySummary = z.infer<typeof garminActivitySummarySchema>;

export const garminSyncResponseSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    activities: z.array(garminActivitySummarySchema),
  })
  .strict();
export type GarminSyncResponse = z.infer<typeof garminSyncResponseSchema>;

/**
 * POST /history: one page of the full-history import, `limit` items of Garmin's running list from offset
 * `start`, newest first (0 is the latest run). Offsets instead of date windows: one call per page rather
 * than one login per window, and Garmin's short last page marks the end exactly.
 */
export const garminHistoryRequestSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    start: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(200),
  })
  .strict();
export type GarminHistoryRequest = z.infer<typeof garminHistoryRequestSchema>;

export const garminHistoryResponseSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    /** The runs in the page, newest first; non-runs and repeated ids are left out. */
    activities: z.array(garminActivitySummarySchema),
    /**
     * Items Garmin listed before filtering, which is what the offset advances by. Fewer than `limit` means
     * nothing older is left.
     */
    listed: z.number().int().nonnegative(),
  })
  .strict();
export type GarminHistoryResponse = z.infer<typeof garminHistoryResponseSchema>;

/**
 * POST /activities/{garminActivityId}/detail: the laps, samples, route and heart-rate zones of one run,
 * from get_activity_splits, get_activity_details and get_activity_hr_in_timezones in one request, so the
 * three calls share one login.
 */
export const garminActivityDetailRequestSchema = z
  .object({ tokenBundle: garminTokenBundleSchema })
  .strict();
export type GarminActivityDetailRequest = z.infer<typeof garminActivityDetailRequestSchema>;

export const garminActivityDetailResponseSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    detail: activityDetailSchema,
  })
  .strict();
export type GarminActivityDetailResponse = z.infer<typeof garminActivityDetailResponseSchema>;

/** Runs per POST /activities/series: one login and one paced call per run stay inside the 60 s timeout. */
export const GARMIN_SERIES_BATCH_MAX = 10;

/**
 * POST /activities/series: the timer and distance samples of up to GARMIN_SERIES_BATCH_MAX runs, one
 * get_activity_details call each at Garmin's full rate (about one row a second), all under one login, so
 * best efforts can be found in any stretch of a run. With `includeRecords`, Garmin's own running records
 * (get_personal_record) come back too, for comparison.
 */
export const garminSeriesRequestSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    garminActivityIds: z.array(z.number().int().positive()).max(GARMIN_SERIES_BATCH_MAX),
    includeRecords: z.boolean(),
  })
  .strict();
export type GarminSeriesRequest = z.infer<typeof garminSeriesRequestSchema>;

/**
 * What became of one run in a series batch. "ok": Garmin answered, with samples or with none (a run it
 * holds no detail for); "gone": Garmin no longer knows the run (404, deleted on Garmin); "failed": this run
 * alone could not be read (an error or an unreadable answer for it while other runs worked), so the API
 * leaves it pending and tries it again later. A 429 or a dead login fails the whole request instead.
 */
export const garminSeriesOutcomeSchema = z.enum(["ok", "gone", "failed"]);
export type GarminSeriesOutcome = z.infer<typeof garminSeriesOutcomeSchema>;

/** One run's samples, row-aligned; both arrays are empty unless the outcome is "ok". */
export const garminActivitySeriesSchema = z
  .object({
    garminActivityId: z.number().int().positive(),
    outcome: garminSeriesOutcomeSchema,
    /** Timer seconds from the start in Garmin's row order; the engine cuts wherever they go backwards. */
    elapsedS: z.array(z.number().nonnegative()),
    distanceM: z.array(z.number().nonnegative()),
  })
  .strict()
  .refine((series) => series.distanceM.length === series.elapsedS.length, {
    message: "distanceM must have the length of elapsedS",
  })
  .refine((series) => series.outcome === "ok" || series.elapsedS.length === 0, {
    message: "only an ok run carries samples",
  });
export type GarminActivitySeries = z.infer<typeof garminActivitySeriesSchema>;

export const garminSeriesResponseSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    /** One entry per requested id, in request order. */
    series: z.array(garminActivitySeriesSchema),
    /**
     * Garmin's running records at the distances the app knows; null unless `includeRecords` was set, and
     * null when the records call failed or answered in a shape the service cannot read: they are only a
     * comparison, so they never fail the series.
     */
    records: z.array(garminRecordSchema).nullable(),
  })
  .strict();
export type GarminSeriesResponse = z.infer<typeof garminSeriesResponseSchema>;
