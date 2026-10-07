import { describe, expect, it } from "vitest";
import { secondsInZones } from "../../src/services/hr-zone-time";

// The seconds-in-zone rule as a pure function. test/routes/activities.test.ts runs it through run detail.

const FLOORS = [100, 120, 140, 160, 180] as const;

/** The seconds per zone, zone 1 first. */
function seconds(elapsedS: number[], hr: (number | null)[] | null): number[] | undefined {
  return secondsInZones(elapsedS, hr, FLOORS)?.map((zone) => zone.seconds);
}

describe("secondsInZones", () => {
  it("answers the five zones in order with their floors", () => {
    expect(secondsInZones([0, 60], [130, 130], FLOORS)).toEqual([
      { zone: 1, lowBpm: 100, seconds: 0 },
      { zone: 2, lowBpm: 120, seconds: 60 },
      { zone: 3, lowBpm: 140, seconds: 0 },
      { zone: 4, lowBpm: 160, seconds: 0 },
      { zone: 5, lowBpm: 180, seconds: 0 },
    ]);
  });

  it("holds each sample's heart rate until the next sample, so the last one adds nothing", () => {
    expect(seconds([0, 10, 30, 60], [110, 150, 170, 190])).toEqual([10, 0, 20, 30, 0]);
  });

  it("puts a heart rate equal to a floor in that zone (boundaries)", () => {
    expect(seconds([0, 1, 2, 3, 4, 5], [100, 120, 140, 160, 180, 180])).toEqual([1, 1, 1, 1, 1]);
  });

  it("puts a heart rate just under a floor in the zone below (boundaries)", () => {
    expect(seconds([0, 1, 2, 3, 4], [119.9, 139.9, 159.9, 179.9, 0])).toEqual([1, 1, 1, 1, 0]);
  });

  it("counts time below zone 1 in no zone (below zone 1)", () => {
    expect(seconds([0, 40, 50], [99, 105, null])).toEqual([10, 0, 0, 0, 0]);
  });

  it("keeps time above max HR in zone 5", () => {
    expect(seconds([0, 30], [230, null])).toEqual([0, 0, 0, 0, 30]);
  });

  it("counts a missing reading in no zone (null samples)", () => {
    expect(seconds([0, 10, 20, 30], [130, null, 130, 130])).toEqual([0, 20, 0, 0, 0]);
  });

  it("skips a step whose elapsed time stays or goes back (non-increasing elapsed)", () => {
    expect(seconds([0, 10, 10, 5, 20], [130, 150, 170, 190, 190])).toEqual([0, 10, 0, 0, 15]);
  });

  it("rounds each zone once at the end, not per sample", () => {
    const elapsedS = [0, 0.4, 0.8, 1.2, 1.6];
    expect(seconds(elapsedS, [130, 130, 130, 130, 130])).toEqual([0, 2, 0, 0, 0]);
  });

  it("answers null when no sample has a heart rate (all null)", () => {
    expect(secondsInZones([0, 10, 20], [null, null, null], FLOORS)).toBeNull();
  });

  it("answers null without a heart-rate series (missing HR)", () => {
    expect(secondsInZones([0, 10, 20], null, FLOORS)).toBeNull();
  });

  it("answers null for a manual entry with no samples", () => {
    expect(secondsInZones([], [], FLOORS)).toBeNull();
  });

  it("answers five zones of zero seconds for a single reading", () => {
    expect(seconds([0], [150])).toEqual([0, 0, 0, 0, 0]);
  });

  it("never counts more seconds than the series spans, beyond each zone's rounding", () => {
    const elapsedS = Array.from({ length: 200 }, (_, i) => i * 3.7);
    const hr = elapsedS.map((_, i) => (i % 7 === 0 ? null : 90 + ((i * 13) % 110)));
    const total = seconds(elapsedS, hr)!.reduce((sum, s) => sum + s, 0);
    expect(total).toBeLessThanOrEqual(elapsedS.at(-1)! + 5 * 0.5);
  });
});
