import { raceDistanceKeySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  longestInWindowM,
  longestRunSeedM,
  longRunDaysConflict,
  longRunM,
  longRunShare,
  longRunWarning,
  maxRunM,
  requiredLongRunM,
} from "./long-run";

// 360 s/km makes 150 min exactly 25 km.
const PACE = 360;

describe("long run", () => {
  it("allows 40% of the week at 3 runs and 30% at 4 or more", () => {
    expect(longRunShare(3)).toBe(0.4);
    expect(longRunShare(4)).toBe(0.3);
    expect(longRunShare(6)).toBe(0.3);
  });

  it("takes the share of the week when that is the smallest cap", () => {
    expect(
      longRunM({ weekVolumeM: 40_000, daysPerWeek: 4, easyPaceSPerKm: PACE, maxRunM: 20_000 }),
    ).toBe(12_000);
    expect(
      longRunM({ weekVolumeM: 40_000, daysPerWeek: 3, easyPaceSPerKm: PACE, maxRunM: 20_000 }),
    ).toBe(16_000);
  });

  it("caps at 150 min of easy running: one below, at and one above the cap", () => {
    const at = (weekVolumeM: number) =>
      longRunM({ weekVolumeM, daysPerWeek: 4, easyPaceSPerKm: PACE, maxRunM: 40_000 });
    expect(at(83_330)).toBe(24_999);
    expect(at(83_334)).toBe(25_000);
    expect(at(83_337)).toBe(25_000);
  });

  it("caps at 110% of the longest recent run", () => {
    expect(
      longRunM({ weekVolumeM: 60_000, daysPerWeek: 4, easyPaceSPerKm: PACE, maxRunM: 11_000 }),
    ).toBe(11_000);
  });

  it("allows a run up to 110% of the longest run, in whole meters", () => {
    expect(maxRunM(10_000)).toBe(11_000);
    expect(maxRunM(12_345)).toBe(13_579);
  });

  it.each([0, -1, Number.NaN])("rejects a longest run of %s as a programmer error", (longestM) => {
    expect(() => maxRunM(longestM)).toThrow(RangeError);
  });

  it("seeds the longest run from the baseline, never under the 5 km floor", () => {
    expect(longestRunSeedM(0)).toBe(5000);
    expect(longestRunSeedM(4999)).toBe(5000);
    expect(longestRunSeedM(5001)).toBe(5001);
  });

  it("looks back 4 weeks, counting the baseline's longest run until 4 plan weeks exist", () => {
    expect(longestInWindowM({ longestByWeekM: [], seedM: 8000 })).toBe(8000);
    expect(longestInWindowM({ longestByWeekM: [6000, 9000], seedM: 8000 })).toBe(9000);
    expect(longestInWindowM({ longestByWeekM: [6000, 7000, 7000, 7000], seedM: 10_000 })).toBe(
      7000,
    );
    expect(
      longestInWindowM({ longestByWeekM: [12_000, 6000, 7000, 7000, 7000], seedM: 5000 }),
    ).toBe(7000);
  });

  it("reports long_run_cap for a marathon on 3 days and allows it on 4", () => {
    expect(longRunDaysConflict({ distanceKey: "marathon", daysPerWeek: 3 })).toEqual({
      code: "long_run_cap",
      distanceKey: "marathon",
      daysPerWeek: 3,
      minDaysPerWeek: 4,
    });
    expect(longRunDaysConflict({ distanceKey: "marathon", daysPerWeek: 4 })).toBeNull();
    expect(longRunDaysConflict({ distanceKey: "half", daysPerWeek: 3 })).toBeNull();
  });

  it("asks for a peak long run in minutes at easy pace by distance", () => {
    expect(requiredLongRunM({ distanceKey: "marathon", easyPaceSPerKm: PACE })).toBe(25_000);
    expect(requiredLongRunM({ distanceKey: "5k", easyPaceSPerKm: PACE })).toBe(10_000);
  });

  it("warns long_run_short 1 m under the required long run and not at or above it", () => {
    expect(longRunWarning({ peakLongRunM: 24_999, requiredLongRunM: 25_000 })).toEqual({
      code: "long_run_short",
      peakLongRunM: 24_999,
      requiredLongRunM: 25_000,
    });
    expect(longRunWarning({ peakLongRunM: 25_000, requiredLongRunM: 25_000 })).toBeNull();
    expect(longRunWarning({ peakLongRunM: 25_001, requiredLongRunM: 25_000 })).toBeNull();
  });

  it("never passes the share, 150 min or 110% caps, and always reaches the smallest", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5000, max: 150_000 }),
        fc.integer({ min: 3, max: 6 }),
        fc.double({ min: 180, max: 600, noNaN: true }),
        fc.integer({ min: 5500, max: 40_000 }),
        (weekVolumeM, daysPerWeek, easyPaceSPerKm, cap) => {
          const longM = longRunM({ weekVolumeM, daysPerWeek, easyPaceSPerKm, maxRunM: cap });
          const share = daysPerWeek === 3 ? 0.4 : 0.3;
          expect(Number.isInteger(longM)).toBe(true);
          expect(longM).toBeLessThanOrEqual(share * weekVolumeM);
          expect(Math.round((longM * easyPaceSPerKm) / 1000)).toBeLessThanOrEqual(9000);
          expect(longM).toBeLessThanOrEqual(cap);
          expect(longM).toBeGreaterThanOrEqual(
            Math.min(
              Math.floor(share * weekVolumeM),
              Math.floor((9000 * 1000) / easyPaceSPerKm),
              cap,
            ),
          );
        },
      ),
    );
  });

  it("reports long_run_cap exactly under the distance's minimum days", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 3, max: 6 }),
        (distanceKey, daysPerWeek) => {
          const minimum = distanceKey === "marathon" ? 4 : 3;
          expect(longRunDaysConflict({ distanceKey, daysPerWeek }) !== null).toBe(
            daysPerWeek < minimum,
          );
        },
      ),
    );
  });
});
