import { describe, expect, it } from "vitest";
import {
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
  elevationGainM: null,
  isIndoor: true,
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
