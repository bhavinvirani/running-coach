import { z } from "zod";
import { activityDetailSchema } from "./activity";
import { errorCodeSchema } from "../error-codes";
import { garminRecordSchema } from "./personal-bests";
import { paceBandSchema } from "./plan";
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
 * holds no detail for); "gone": Garmin no longer knows the run (404, deleted on Garmin); "failed": Garmin
 * was asked and this run could not be read (an error or an unreadable answer), so the API counts an
 * attempt; "skipped": never asked, because the service stopped early (failures in a row or its time
 * budget, so an outage fits the API's timeout), so the API leaves it pending without counting. A 429 or a
 * dead login fails the whole request instead.
 */
export const garminSeriesOutcomeSchema = z.enum(["ok", "gone", "failed", "skipped"]);
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

/** Garmin's ids for a workout and for one scheduled instance of it on the calendar. */
export const garminWorkoutIdSchema = z.number().int().positive();
export const garminScheduleIdSchema = z.number().int().positive();

/**
 * Garmin's step types the service builds with garminconnect's workout helpers: a "Run" step on the watch
 * is Garmin's "interval".
 */
export const garminStepTypeSchema = z.enum(["warmup", "interval", "recovery", "cooldown"]);
export type GarminStepType = z.infer<typeof garminStepTypeSchema>;

/** One step of a Garmin workout: ends after a distance or a time, with a pace target or open. */
export const garminWorkoutStepSchema = z
  .object({
    type: garminStepTypeSchema,
    distanceM: z.number().int().positive().nullable(),
    durationS: z.number().int().positive().nullable(),
    /** Seconds per km, fast end first, as the plan stores it; the service converts to m/s. Null: open. */
    pace: paceBandSchema.nullable(),
  })
  .strict()
  .refine(
    (step) => (step.distanceM === null) !== (step.durationS === null),
    "A step is by distance or by time",
  );
export type GarminWorkoutStep = z.infer<typeof garminWorkoutStepSchema>;

export const garminWorkoutRepeatSchema = z
  .object({
    repeat: z.number().int().min(2),
    steps: z.array(garminWorkoutStepSchema).min(1),
  })
  .strict();
export type GarminWorkoutRepeat = z.infer<typeof garminWorkoutRepeatSchema>;

/** Garmin's workout name limit is longer; this keeps a name readable on a watch face. */
export const GARMIN_WORKOUT_NAME_MAX = 60;

/** A running workout as the engine's garminWorkout builds it from a session's steps and the plan's paces. */
export const garminWorkoutSchema = z
  .object({
    name: z.string().min(1).max(GARMIN_WORKOUT_NAME_MAX),
    /** The session's planned time at each zone's midpoint pace. */
    estimatedDurationS: z.number().int().nonnegative(),
    steps: z.array(z.union([garminWorkoutStepSchema, garminWorkoutRepeatSchema])).min(1),
  })
  .strict();
export type GarminWorkout = z.infer<typeof garminWorkoutSchema>;

/**
 * One change to the runner's Garmin workouts and calendar. `ref` is the API's handle for it (a session id,
 * or the schedule id of a workout the app did not create) and comes back on the result.
 * - create: upload the workout, then schedule it on `date`.
 * - move: unschedule `scheduleId` when set, then schedule `workoutId` on `date`.
 * - remove: unschedule `scheduleId` when set, then delete `workoutId`. Only ever a workout the app made.
 * - unschedule: take a workout the app did not create off the calendar; the workout itself stays.
 * A 404 on unschedule or delete means it is already gone and counts as done.
 */
export const garminWorkoutActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      ref: z.string().min(1).max(64),
      date: z.iso.date(),
      workout: garminWorkoutSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("move"),
      ref: z.string().min(1).max(64),
      workoutId: garminWorkoutIdSchema,
      scheduleId: garminScheduleIdSchema.nullable(),
      date: z.iso.date(),
    })
    .strict(),
  z
    .object({
      action: z.literal("remove"),
      ref: z.string().min(1).max(64),
      workoutId: garminWorkoutIdSchema,
      scheduleId: garminScheduleIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal("unschedule"),
      ref: z.string().min(1).max(64),
      scheduleId: garminScheduleIdSchema,
    })
    .strict(),
]);
export type GarminWorkoutAction = z.infer<typeof garminWorkoutActionSchema>;
export type GarminWorkoutActionKind = GarminWorkoutAction["action"];

/** Actions per POST /workouts/sync: at most two paced calls each, a login and the calendar read stay inside the 60 s timeout. */
export const GARMIN_WORKOUT_BATCH_MAX = 8;

/**
 * POST /workouts/sync: the actions in order under one login, then, unless the batch stopped, the workouts
 * scheduled between calendarStart and calendarEnd (get_scheduled_workouts, one call per month touched).
 */
export const garminWorkoutSyncRequestSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    actions: z.array(garminWorkoutActionSchema).max(GARMIN_WORKOUT_BATCH_MAX),
    calendarStart: z.iso.date(),
    calendarEnd: z.iso.date(),
  })
  .strict();
export type GarminWorkoutSyncRequest = z.infer<typeof garminWorkoutSyncRequestSchema>;

/**
 * What became of one action. done: it completed. gone: the workout it names no longer exists on Garmin
 * (deleted in Garmin Connect), so the API forgets its ids and creates it again. failed: the failure that
 * stopped the batch hit this action, possibly halfway. skipped: never tried, because the batch stopped
 * first or ran out of its time budget.
 */
export const garminWorkoutOutcomeSchema = z.enum(["done", "gone", "failed", "skipped"]);
export type GarminWorkoutOutcome = z.infer<typeof garminWorkoutOutcomeSchema>;

/**
 * One result per action, in request order. workoutId and scheduleId are what Garmin holds for the ref
 * after the action, whatever the outcome: a create that uploaded but failed to schedule answers its
 * workoutId with a null scheduleId, so the API stores it and the retry only schedules. For "skipped" they
 * repeat the action's own ids (null for a create).
 */
export const garminWorkoutResultSchema = z
  .object({
    ref: z.string().min(1).max(64),
    action: z.enum(["create", "move", "remove", "unschedule"]),
    outcome: garminWorkoutOutcomeSchema,
    workoutId: garminWorkoutIdSchema.nullable(),
    scheduleId: garminScheduleIdSchema.nullable(),
  })
  .strict();
export type GarminWorkoutResult = z.infer<typeof garminWorkoutResultSchema>;

/** A workout on the runner's Garmin calendar: Garmin's calendarItems with itemType "workout". */
export const garminCalendarEntrySchema = z
  .object({
    scheduleId: garminScheduleIdSchema,
    workoutId: garminWorkoutIdSchema,
    date: z.iso.date(),
    title: z.string().nullable(),
  })
  .strict();
export type GarminCalendarEntry = z.infer<typeof garminCalendarEntrySchema>;

/**
 * Why the batch stopped: the same code and retry delay a whole-request failure would answer. Writes are not
 * idempotent, so a failure after the login answers 200 with the results so far instead of a problem; a
 * failure of the login itself still answers the problem, with nothing done.
 */
export const garminWorkoutStopSchema = z
  .object({
    code: errorCodeSchema,
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();
export type GarminWorkoutStop = z.infer<typeof garminWorkoutStopSchema>;

export const garminWorkoutSyncResponseSchema = z
  .object({
    tokenBundle: garminTokenBundleSchema,
    results: z.array(garminWorkoutResultSchema),
    stopped: garminWorkoutStopSchema.nullable(),
    /**
     * Every workout scheduled in the calendar range, the app's own included; null when the batch stopped
     * or the calendar read failed, which never fails the batch.
     */
    calendar: z.array(garminCalendarEntrySchema).nullable(),
  })
  .strict();
export type GarminWorkoutSyncResponse = z.infer<typeof garminWorkoutSyncResponseSchema>;
