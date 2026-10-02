import { z } from "zod";
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
