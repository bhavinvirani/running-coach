import {
  disconnectGarminResponseSchema,
  garminLoginConnectedSchema,
  startGarminLoginResponseSchema,
  syncResponseSchema,
  type DisconnectGarminResponse,
  type GarminLoginConnected,
  type StartGarminLoginResponse,
  type SyncResponse,
} from "@running-coach/shared";

// Connecting Garmin from the web app (#51), mirroring the fixture Garmin the e2e flows sign in to:
// any email with FIXTURE_PASSWORD, then FIXTURE_CODE; one email that Garmin answers with a 429 and one it
// lets in without a code. Fake values only (tests rule).

export const FIXTURE_EMAIL = "runner@example.com";
export const FIXTURE_PASSWORD = "fixture-password";
export const FIXTURE_CODE = "123456";
/** Garmin answers a sign-in for this email with a 429. */
export const RATE_LIMITED_EMAIL = "rate-limited@example.com";
/** Garmin lets this email in without a two-factor code. */
export const NO_CODE_EMAIL = "no-code@example.com";

/** POST /api/garmin/login when Garmin sent a code. */
export function codeNeededFixture(): StartGarminLoginResponse {
  return startGarminLoginResponseSchema.parse({ status: "code_needed" });
}

/** POST /api/garmin/login without a code, or POST /api/garmin/login/code: the login is stored. */
export function garminConnectedFixture(): GarminLoginConnected {
  return garminLoginConnectedSchema.parse({ status: "connected", displayName: "runner-fixture" });
}

/** DELETE /api/garmin/connection: how many of the app's workouts came off Garmin. */
export function disconnectedFixture(removedWorkouts = 0): DisconnectGarminResponse {
  return disconnectGarminResponseSchema.parse({ removedWorkouts });
}

/** POST /api/sync after a connect: one run brought in. */
export function syncedFixture(): SyncResponse {
  return syncResponseSchema.parse({
    lastSyncAt: "2026-10-07T07:40:00Z",
    activitiesWritten: 1,
    activitiesRemoved: 0,
  });
}
