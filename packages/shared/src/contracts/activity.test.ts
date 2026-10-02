import { describe, expect, it } from "vitest";
import { latestActivityResponseSchema } from "./activity";

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
