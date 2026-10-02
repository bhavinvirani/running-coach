import {
  activitySchema,
  meResponseSchema,
  type Activity,
  type MeResponse,
} from "@running-coach/shared";

const RUNNER_ID = "5b1f0c9e-3d2a-4f6b-8c7d-9e0a1b2c3d4e";

/** A fictional runner. Parsed with the shared contract so the fixture can never drift from the API. */
export function meFixture(overrides: Partial<MeResponse> = {}): MeResponse {
  return meResponseSchema.parse({
    user: {
      id: RUNNER_ID,
      email: "runner@example.com",
      name: "Sam Example",
    },
    settings: {
      units: "km",
      timezone: "Europe/London",
      coachDetail: "standard",
      hasClaudeKey: false,
    },
    garmin: { status: "ok", lastSyncAt: "2026-09-27T06:12:00Z" },
    ...overrides,
  });
}

/**
 * A fictional outdoor run in London: 10.04 km in 52:18 at 148 bpm, 07:12 local (06:12 UTC, BST).
 * Parsed with the shared contract like meFixture.
 */
export function activityFixture(overrides: Partial<Activity> = {}): Activity {
  return activitySchema.parse({
    id: "0d6c8a4e-7b1f-4c2d-9e3a-5f6b7c8d9e0f",
    type: "running",
    startUtc: "2026-09-27T06:12:00Z",
    startLocal: "2026-09-27T07:12:00",
    tz: "Europe/London",
    distanceM: 10_040,
    durationS: 3138,
    avgHr: 148,
    maxHr: 171,
    cadence: 172,
    elevationGainM: 64,
    isIndoor: false,
    isManual: false,
    ...overrides,
  });
}

/**
 * The whole body Better Auth 1.7 sends for a successful sign-in, not just what signInResponseSchema pins, so
 * the tests prove the extra fields are accepted.
 */
export function signInFixture() {
  return {
    redirect: false,
    token: "fake-session-token",
    user: {
      id: RUNNER_ID,
      email: "runner@example.com",
      name: "Sam Example",
      image: null,
      emailVerified: false,
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    },
  };
}
