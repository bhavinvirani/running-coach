import { meResponseSchema, type MeResponse } from "@running-coach/shared";

/** A fictional runner. Parsed with the shared contract so the fixture can never drift from the API. */
export function meFixture(overrides: Partial<MeResponse> = {}): MeResponse {
  return meResponseSchema.parse({
    user: {
      id: "5b1f0c9e-3d2a-4f6b-8c7d-9e0a1b2c3d4e",
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
