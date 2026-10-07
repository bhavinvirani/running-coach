import {
  hrZonesResponseSchema,
  hrZonesSchema,
  type HrZones,
  type HrZonesResponse,
  type HrZonesSource,
} from "@running-coach/shared";

// Heart rate zones (slice 12a): Garmin's default zones for a fictional runner whose zone 5 starts at
// 176 bpm, so a max HR of 196 (176 / 0.9) and floors at 50, 60, 70, 80 and 90 % of it.

/** The zones as GET /api/hr-zones holds them, parsed with the shared contract like meFixture. */
export function hrZonesFixture(overrides: Partial<HrZones> = {}): HrZones {
  return hrZonesSchema.parse({ maxHr: 196, lowBpm: [98, 118, 137, 157, 176], ...overrides });
}

/** GET /api/hr-zones: Garmin's zones unless a test says where they come from; none carries no zones. */
export function hrZonesResponseFixture(
  source: HrZonesSource = "garmin",
  zones: HrZones = hrZonesFixture(),
): HrZonesResponse {
  return hrZonesResponseSchema.parse({ source, zones: source === "none" ? null : zones });
}
