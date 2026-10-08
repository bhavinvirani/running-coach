import { z } from "zod";
import {
  garminEmailSchema,
  garminMfaCodeSchema,
  garminPasswordSchema,
  garminTokenBundleSchema,
} from "./garmin";

/**
 * PUT /api/garmin/connection: the bundle `pnpm garmin:connect` gets from a fresh Garmin login on the
 * runner's laptop. The API proves it with one Garmin call, then stores it encrypted; it never comes back out.
 */
export const connectGarminRequestSchema = z
  .object({ tokenBundle: garminTokenBundleSchema })
  .strict();
export type ConnectGarminRequest = z.infer<typeof connectGarminRequestSchema>;

export const connectGarminResponseSchema = z
  .object({
    /** Garmin's display name for the account, often an opaque handle; null when Garmin has none. */
    displayName: z.string().nullable(),
  })
  .strict();
export type ConnectGarminResponse = z.infer<typeof connectGarminResponseSchema>;

/**
 * POST /api/garmin/login: connect or reconnect from the web app with the Garmin account's email and
 * password, passed once to the Garmin service and never stored or logged.
 */
export const startGarminLoginRequestSchema = z
  .object({ email: garminEmailSchema, password: garminPasswordSchema })
  .strict();
export type StartGarminLoginRequest = z.infer<typeof startGarminLoginRequestSchema>;

/** The login is proved with one Garmin call and stored encrypted, as a PUT of its bundle would be. */
export const garminLoginConnectedSchema = z
  .object({
    status: z.literal("connected"),
    /** Garmin's display name for the account, often an opaque handle; null when Garmin has none. */
    displayName: z.string().nullable(),
  })
  .strict();
export type GarminLoginConnected = z.infer<typeof garminLoginConnectedSchema>;

/**
 * code_needed: Garmin sent a two-factor code; POST /api/garmin/login/code within 5 min finishes the login.
 * connected: Garmin asked for no code.
 */
export const startGarminLoginResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("code_needed") }).strict(),
  garminLoginConnectedSchema,
]);
export type StartGarminLoginResponse = z.infer<typeof startGarminLoginResponseSchema>;

/** POST /api/garmin/login/code: the code for the login the runner started; a wrong one can be retried. */
export const finishGarminLoginRequestSchema = z.object({ mfaCode: garminMfaCodeSchema }).strict();
export type FinishGarminLoginRequest = z.infer<typeof finishGarminLoginRequestSchema>;

/**
 * DELETE /api/garmin/connection?workouts=remove|keep. remove first takes every workout the app made from
 * today on off Garmin, and needs a working login; keep only forgets the login. Runs and plans stay.
 */
export const disconnectGarminQuerySchema = z
  .object({ workouts: z.enum(["remove", "keep"]) })
  .strict();
export type DisconnectGarminQuery = z.infer<typeof disconnectGarminQuerySchema>;

export const disconnectGarminResponseSchema = z
  .object({
    /** Workouts the app made that were taken off Garmin; 0 with keep or when there were none. */
    removedWorkouts: z.number().int().nonnegative(),
  })
  .strict();
export type DisconnectGarminResponse = z.infer<typeof disconnectGarminResponseSchema>;
