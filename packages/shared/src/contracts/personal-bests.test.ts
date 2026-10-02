import { describe, expect, it } from "vitest";
import { DISTANCE_METERS, distanceKeySchema } from "../distances";
import {
  GARMIN_SERIES_BATCH_MAX,
  garminSeriesRequestSchema,
  garminSeriesResponseSchema,
} from "./garmin";
import { personalBestsResponseSchema } from "./personal-bests";

const best = {
  distanceKey: "5k",
  timeS: 1625.87,
  activityId: "8f0c8a52-3d8e-4a77-9a39-6c1f1b0e2a11",
  startUtc: "2026-09-27T05:12:00Z",
  startLocal: "2026-09-27T07:12:00",
};

describe("distances", () => {
  it("lists every key shortest first, each with its meters", () => {
    const meters = distanceKeySchema.options.map((key) => DISTANCE_METERS[key]);
    expect(meters).toEqual([...meters].sort((a, b) => a - b));
    expect(DISTANCE_METERS["10mi"]).toBeCloseTo(16093.44, 6);
    expect(DISTANCE_METERS.half).toBe(21097.5);
  });
});

describe("personalBestsResponseSchema", () => {
  it("accepts bests before Garmin's records were fetched", () => {
    const parsed = personalBestsResponseSchema.safeParse({
      bests: [best],
      garmin: null,
      pendingRuns: 340,
      checking: true,
      errorCode: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts Garmin's records beside the bests", () => {
    const parsed = personalBestsResponseSchema.safeParse({
      bests: [best],
      garmin: {
        records: [{ distanceKey: "half", timeS: 6973.03, achievedAt: "2026-09-27T05:12:00Z" }],
        fetchedAt: "2026-10-02T08:00:00Z",
      },
      pendingRuns: 0,
      checking: false,
      errorCode: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a stopped pass with its reason", () => {
    expect(
      personalBestsResponseSchema.safeParse({
        bests: [],
        garmin: null,
        pendingRuns: 12,
        checking: false,
        errorCode: "garmin_auth_expired",
      }).success,
    ).toBe(true);
  });

  it("rejects a distance the app does not know", () => {
    const parsed = personalBestsResponseSchema.safeParse({
      bests: [{ ...best, distanceKey: "3k" }],
      garmin: null,
      pendingRuns: 0,
      checking: false,
      errorCode: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a pace field, which clients derive", () => {
    const parsed = personalBestsResponseSchema.safeParse({
      bests: [{ ...best, paceS: 325 }],
      garmin: null,
      pendingRuns: 0,
      checking: false,
      errorCode: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("garminSeriesRequestSchema", () => {
  it(`takes at most ${GARMIN_SERIES_BATCH_MAX} runs, and none when only the records are wanted`, () => {
    const request = { tokenBundle: "{}", includeRecords: true };
    expect(garminSeriesRequestSchema.safeParse({ ...request, garminActivityIds: [] }).success).toBe(
      true,
    );
    const ids = Array.from({ length: GARMIN_SERIES_BATCH_MAX + 1 }, (_, index) => index + 1);
    expect(
      garminSeriesRequestSchema.safeParse({ ...request, garminActivityIds: ids }).success,
    ).toBe(false);
  });
});

describe("garminSeriesResponseSchema", () => {
  const response = { tokenBundle: "{}", records: null };

  it("accepts empty samples for a run Garmin no longer knows", () => {
    const parsed = garminSeriesResponseSchema.safeParse({
      ...response,
      series: [{ garminActivityId: 1, outcome: "gone", elapsedS: [], distanceM: [] }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects samples on a run that failed", () => {
    const parsed = garminSeriesResponseSchema.safeParse({
      ...response,
      series: [{ garminActivityId: 1, outcome: "failed", elapsedS: [0], distanceM: [0] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects samples that are not row-aligned", () => {
    const parsed = garminSeriesResponseSchema.safeParse({
      ...response,
      series: [{ garminActivityId: 1, outcome: "ok", elapsedS: [0, 1], distanceM: [0] }],
    });
    expect(parsed.success).toBe(false);
  });
});
