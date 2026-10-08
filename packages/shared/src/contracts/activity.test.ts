import { describe, expect, it } from "vitest";
import {
  activityDetailSchema,
  activityResponseSchema,
  activityWeekSchema,
  activityWeeksQuerySchema,
  latestActivityResponseSchema,
} from "./activity";

const run = {
  id: "8f0c8a52-3d8e-4a77-9a39-6c1f1b0e2a11",
  type: "running",
  startUtc: "2026-09-27T05:12:00Z",
  startLocal: "2026-09-27T07:12:00",
  tz: null,
  distanceM: 18000,
  durationS: 5940,
  avgHr: null,
  maxHr: null,
  cadence: null,
  calories: null,
  elevationGainM: null,
  isIndoor: true,
  eventType: null,
  isManual: false,
};

describe("latestActivityResponseSchema", () => {
  it("accepts null before the first run is stored", () => {
    expect(latestActivityResponseSchema.safeParse({ activity: null }).success).toBe(true);
  });

  it("accepts an indoor run with missing heart rate", () => {
    expect(latestActivityResponseSchema.safeParse({ activity: run }).success).toBe(true);
  });

  it("rejects a local start with an offset, which would shift the shown date", () => {
    const parsed = latestActivityResponseSchema.safeParse({
      activity: { ...run, startLocal: "2026-09-27T07:12:00+02:00" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a pace field, which clients derive", () => {
    const parsed = latestActivityResponseSchema.safeParse({ activity: { ...run, paceS: 330 } });
    expect(parsed.success).toBe(false);
  });
});

describe("activityWeeksQuerySchema", () => {
  it("reads weeks from the query string and defaults to 8", () => {
    expect(activityWeeksQuerySchema.parse({ weeks: "4" })).toEqual({ weeks: 4 });
    expect(activityWeeksQuerySchema.parse({})).toEqual({ weeks: 8 });
  });

  it("rejects a before that is not a date", () => {
    expect(activityWeeksQuerySchema.safeParse({ before: "2026-09-31" }).success).toBe(false);
  });

  it("rejects more than 26 weeks in one page", () => {
    expect(activityWeeksQuerySchema.safeParse({ weeks: "27" }).success).toBe(false);
  });
});

describe("activityWeekSchema", () => {
  it("rejects a week without runs, which the list leaves out", () => {
    const week = { weekStart: "2026-09-21", distanceM: 0, durationS: 0, runs: [] };
    expect(activityWeekSchema.safeParse(week).success).toBe(false);
  });

  it("accepts a week of one indoor run without heart rate", () => {
    const week = { weekStart: "2026-09-21", distanceM: 18000, durationS: 5940, runs: [run] };
    expect(activityWeekSchema.safeParse(week).success).toBe(true);
  });
});

const detail = {
  laps: [{ index: 1, distanceM: 1000, durationS: 305, avgHr: 150, avgCadence: 172 }],
  streams: {
    elapsedS: [0, 2, 4],
    distanceM: [0, 6.1, 12.3],
    hr: [148, null, 151],
    cadence: [170, 172, 171],
    elevationM: [12.4, 12.6, 12.9],
    speedMps: [3.1, 3.2, 3.2],
  },
  // Open ocean: fixtures hold no real place (tests rule).
  route: [
    [0, -30],
    [0.0001, -30.0001],
  ],
  hrZones: [1, 2, 3, 4, 5].map((zone) => ({ zone, lowBpm: 90 + zone * 18, seconds: 60 })),
};

describe("activityDetailSchema", () => {
  it("accepts laps, row-aligned samples with one missing reading, a route and five zones", () => {
    expect(activityDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("accepts a treadmill run without a route, elevation or zones, and a manual entry without samples", () => {
    const treadmill = {
      ...detail,
      streams: { ...detail.streams, elevationM: null, hr: null },
      route: null,
      hrZones: null,
    };
    const manual = {
      laps: [],
      streams: {
        elapsedS: [],
        distanceM: [],
        hr: null,
        cadence: null,
        elevationM: null,
        speedMps: null,
      },
      route: null,
      hrZones: null,
    };
    expect(activityDetailSchema.safeParse(treadmill).success).toBe(true);
    expect(activityDetailSchema.safeParse(manual).success).toBe(true);
  });

  it("rejects a series shorter than elapsedS, which would misalign the charts", () => {
    const misaligned = { ...detail, streams: { ...detail.streams, hr: [148, 151] } };
    expect(activityDetailSchema.safeParse(misaligned).success).toBe(false);
  });

  it("rejects a route point outside the globe and a sixth zone", () => {
    expect(activityDetailSchema.safeParse({ ...detail, route: [[91, 0]] }).success).toBe(false);
    expect(
      activityDetailSchema.safeParse({
        ...detail,
        hrZones: [...(detail.hrZones ?? []), { zone: 6, lowBpm: 200, seconds: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("activityResponseSchema", () => {
  it("accepts a run before and after its detail is fetched", () => {
    const response = { activity: run, bestEfforts: [], shoeId: null };
    expect(activityResponseSchema.safeParse({ ...response, detail: null }).success).toBe(true);
    expect(activityResponseSchema.safeParse({ ...response, detail }).success).toBe(true);
  });

  it("carries the pair the run wore, and needs the field even without one", () => {
    const response = { activity: run, detail: null, bestEfforts: [] };
    const shoeId = "6f5c0c5e-4a0a-4e8f-9e4c-0f1e6c4a5b66";
    expect(activityResponseSchema.safeParse({ ...response, shoeId }).success).toBe(true);
    expect(activityResponseSchema.safeParse(response).success).toBe(false);
  });

  it("carries the run's best efforts and marks its personal bests", () => {
    const parsed = activityResponseSchema.safeParse({
      activity: run,
      detail: null,
      bestEfforts: [
        { distanceKey: "5k", timeS: 1625.87, personalBest: true },
        { distanceKey: "10k", timeS: 3290.5, personalBest: false },
      ],
      shoeId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an effort without its personal-best flag", () => {
    const parsed = activityResponseSchema.safeParse({
      activity: run,
      detail: null,
      bestEfforts: [{ distanceKey: "5k", timeS: 1625.87 }],
      shoeId: null,
    });
    expect(parsed.success).toBe(false);
  });
});
