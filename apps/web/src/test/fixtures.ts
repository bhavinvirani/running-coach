import { meResponseSchema, type MeResponse } from "@running-coach/shared";

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
