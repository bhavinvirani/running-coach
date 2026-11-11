import { raceDistanceKeySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  longestInWindowM,
  longestRunSeedM,
  longRunDaysConflict,
  longRunFloorM,
  longRunGivingWayM,
  longRunHoldsQuality,
  longRunM,
  longRunRoomM,
  longRunShare,
  longRunWarning,
  maxRunM,
  requiredLongRunM,
} from "./long-run";

// 360 s/km makes 150 min exactly 25 km.
const PACE = 360;
// 20 min at 360 s/km, rounded up.
const MIN_RUN = 3334;

const floorOf = (overrides: Partial<Parameters<typeof longRunFloorM>[0]>) =>
  longRunFloorM({
    baselineLongestM: 15_000,
    weekVolumeM: 26_000,
    daysPerWeek: 4,
    easyPaceSPerKm: PACE,
    maxRunM: 16_500,
    minRunM: MIN_RUN,
    qualityM: [],
    ...overrides,
  });

describe("long run", () => {
  it("allows 40% of the week at 3 runs and 30% at 4 or more", () => {
    expect(longRunShare(3)).toBe(0.4);
    expect(longRunShare(4)).toBe(0.3);
    expect(longRunShare(6)).toBe(0.3);
  });

  it("lets the long run of a taper week of 2 runs take 60%, and a lone run all of it", () => {
    expect(longRunShare(2)).toBe(0.6);
    expect(longRunShare(1)).toBe(1.2);
  });

  it("leaves the runs room to hold the week at every count: the share times the runs is over 1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 7 }), (runs) => {
        expect(longRunShare(runs) * runs).toBeGreaterThan(1);
        if (runs > 1) expect(longRunShare(runs)).toBeLessThanOrEqual(longRunShare(runs - 1));
      }),
    );
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

  it("asks for a peak long run of 60, 75, 90 and 120 min at easy pace by distance", () => {
    expect(requiredLongRunM({ distanceKey: "5k", easyPaceSPerKm: PACE })).toBe(10_000);
    expect(requiredLongRunM({ distanceKey: "10k", easyPaceSPerKm: PACE })).toBe(12_500);
    expect(requiredLongRunM({ distanceKey: "half", easyPaceSPerKm: PACE })).toBe(15_000);
    expect(requiredLongRunM({ distanceKey: "marathon", easyPaceSPerKm: PACE })).toBe(20_000);
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

  it("floors the long run at the baseline's longest run, though 30% of the week is less", () => {
    expect(
      longRunM({ weekVolumeM: 26_000, daysPerWeek: 4, easyPaceSPerKm: PACE, maxRunM: 16_500 }),
    ).toBe(7800);
    expect(floorOf({})).toBe(15_000);
  });

  it("floor equals the baseline longest when the other days leave exactly that: one below, at and one above", () => {
    // 3 other runs of 3334 m leave 15_000 m of a 25_002 m week.
    expect(floorOf({ weekVolumeM: 25_001 })).toBe(14_999);
    expect(floorOf({ weekVolumeM: 25_002 })).toBe(15_000);
    expect(floorOf({ weekVolumeM: 25_003 })).toBe(15_000);
  });

  it("floor binds at 150 min of easy running: one below, at and one above the cap", () => {
    const at = (baselineLongestM: number) =>
      floorOf({ baselineLongestM, weekVolumeM: 100_000, maxRunM: 40_000 });
    expect(at(24_999)).toBe(24_999);
    expect(at(25_000)).toBe(25_000);
    expect(at(25_001)).toBe(25_000);
  });

  it("floor binds at the other days' 20 min runs when the week is small", () => {
    expect(floorOf({ weekVolumeM: 12_000 })).toBe(12_000 - 3 * MIN_RUN);
    expect(floorOf({ weekVolumeM: 12_000, daysPerWeek: 3 })).toBe(12_000 - 2 * MIN_RUN);
  });

  it("floor is zero when the baseline has no runs or the other days take the whole week", () => {
    expect(floorOf({ baselineLongestM: 0 })).toBe(0);
    expect(floorOf({ weekVolumeM: 3 * MIN_RUN })).toBe(0);
    expect(floorOf({ weekVolumeM: 3 * MIN_RUN - 1 })).toBe(0);
  });

  it("floor never passes 110% of the longest recent run", () => {
    expect(floorOf({ maxRunM: 12_000 })).toBe(12_000);
  });

  it("floor binds at the week less the unpadded tempo and a 20 min run on each easy day: one below, at and one above", () => {
    // A 6000 m tempo and 2 easy runs of 3334 m leave 15_000 m of a 27_668 m week.
    const at = (weekVolumeM: number) => floorOf({ weekVolumeM, qualityM: [6000] });
    expect(at(27_667)).toBe(14_999);
    expect(at(27_668)).toBe(15_000);
    expect(at(27_669)).toBe(15_000);
  });

  it("floor counts every quality session at its unpadded size and only the days left as easy runs", () => {
    // 5 days: the long run, intervals of 5500 m, a tempo of 6500 m and 2 easy runs of 3334 m.
    expect(floorOf({ weekVolumeM: 30_000, daysPerWeek: 5, qualityM: [5500, 6500] })).toBe(
      30_000 - 5500 - 6500 - 2 * MIN_RUN,
    );
    // 3 days and one tempo: one easy run beside it.
    expect(floorOf({ weekVolumeM: 20_000, daysPerWeek: 3, qualityM: [6000] })).toBe(
      20_000 - 6000 - MIN_RUN,
    );
  });

  it("floor is zero when the quality sessions and easy runs take the whole week", () => {
    expect(floorOf({ weekVolumeM: 6000 + 2 * MIN_RUN, qualityM: [6000] })).toBe(0);
    expect(floorOf({ weekVolumeM: 6000 + 2 * MIN_RUN - 1, qualityM: [6000] })).toBe(0);
  });

  it("rejects more quality sessions than the week's other days as a programmer error", () => {
    expect(() => floorOf({ daysPerWeek: 3, qualityM: [6000, 6000, 6000] })).toThrow(RangeError);
    expect(floorOf({ daysPerWeek: 3, weekVolumeM: 40_000, qualityM: [6000, 6000] })).toBe(15_000);
  });

  it("floor is the smallest of the baseline longest, 150 min, 110% and the week less the other days, never under 0", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 40_000 }),
        fc.integer({ min: 0, max: 150_000 }),
        fc.integer({ min: 3, max: 6 }),
        fc.double({ min: 180, max: 600, noNaN: true }),
        fc.integer({ min: 5500, max: 40_000 }),
        fc.array(fc.integer({ min: 3000, max: 20_000 }), { maxLength: 2 }),
        (baselineLongestM, weekVolumeM, daysPerWeek, easyPaceSPerKm, cap, qualityM) => {
          const minRunM = Math.ceil((1200 * 1000) / easyPaceSPerKm);
          const floorM = longRunFloorM({
            baselineLongestM,
            weekVolumeM,
            daysPerWeek,
            easyPaceSPerKm,
            maxRunM: cap,
            minRunM,
            qualityM,
          });
          const qualitySumM = qualityM.reduce((sum, m) => sum + m, 0);
          expect(Number.isInteger(floorM)).toBe(true);
          expect(floorM).toBe(
            Math.max(
              0,
              Math.min(
                baselineLongestM,
                Math.floor((9000 * 1000) / easyPaceSPerKm),
                cap,
                weekVolumeM - qualitySumM - (daysPerWeek - 1 - qualityM.length) * minRunM,
              ),
            ),
          );
          expect(floorM).toBeLessThanOrEqual(Math.max(0, baselineLongestM));
          if (floorM > 0) {
            // What the floor leaves holds every quality session and a 20 min run on every other day.
            expect(weekVolumeM - floorM).toBeGreaterThanOrEqual(
              qualitySumM + (daysPerWeek - 1 - qualityM.length) * minRunM,
            );
          }
        },
      ),
    );
  });

  it("leaves the long run the week less its unpadded quality sessions and 20 min on each easy day", () => {
    const room = (overrides: Partial<Parameters<typeof longRunRoomM>[0]>) =>
      longRunRoomM({
        weekVolumeM: 30_000,
        daysPerWeek: 4,
        minRunM: MIN_RUN,
        qualityM: [],
        ...overrides,
      });
    expect(room({})).toBe(30_000 - 3 * MIN_RUN);
    expect(room({ qualityM: [6000] })).toBe(30_000 - 6000 - 2 * MIN_RUN);
    expect(room({ daysPerWeek: 5, qualityM: [5500, 6500] })).toBe(30_000 - 12_000 - 2 * MIN_RUN);
    expect(room({ daysPerWeek: 3, qualityM: [6000, 6000] })).toBe(18_000);
    expect(room({ weekVolumeM: 10_000, qualityM: [6000] })).toBe(10_000 - 6000 - 2 * MIN_RUN);
  });

  it("rejects more quality sessions than the week's other days as a programmer error, room too", () => {
    expect(() =>
      longRunRoomM({ weekVolumeM: 30_000, daysPerWeek: 3, minRunM: MIN_RUN, qualityM: [1, 1, 1] }),
    ).toThrow(RangeError);
  });

  it("gives way to the other days: the room 1 m under, at and 1 m over the long run", () => {
    const at = (roomM: number) => longRunGivingWayM({ longM: 15_000, roomM, minRunM: MIN_RUN });
    expect(at(14_999)).toBe(14_999);
    expect(at(15_000)).toBe(15_000);
    expect(at(15_001)).toBe(15_000);
  });

  it("gives way no further than 20 min: the room 1 m under, at and 1 m over a 20 min run", () => {
    const at = (roomM: number) => longRunGivingWayM({ longM: 15_000, roomM, minRunM: MIN_RUN });
    expect(at(MIN_RUN - 1)).toBe(MIN_RUN);
    expect(at(MIN_RUN)).toBe(MIN_RUN);
    expect(at(MIN_RUN + 1)).toBe(MIN_RUN + 1);
    expect(at(-5000)).toBe(MIN_RUN);
  });

  it("never lengthens a long run already under 20 min", () => {
    expect(longRunGivingWayM({ longM: 3000, roomM: 0, minRunM: MIN_RUN })).toBe(3000);
  });

  it("gives way to the room down to 20 min and never lengthens the long run", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 40_000 }),
        fc.integer({ min: -50_000, max: 150_000 }),
        fc.integer({ min: 1500, max: 5000 }),
        (longM, roomM, minRunM) => {
          const givenM = longRunGivingWayM({ longM, roomM, minRunM });
          expect(givenM).toBeLessThanOrEqual(longM);
          expect(givenM).toBeGreaterThanOrEqual(Math.min(longM, minRunM));
          if (roomM >= minRunM) expect(givenM).toBeLessThanOrEqual(roomM);
          if (roomM >= longM) expect(givenM).toBe(longM);
        },
      ),
    );
  });

  it("holds the quality sessions while the longest is 1 m over or at the long run, not 1 m under it", () => {
    const holds = (longM: number) => longRunHoldsQuality({ longM, qualityM: [6321, 6007] });
    expect(holds(6320)).toBe(false);
    expect(holds(6321)).toBe(true);
    expect(holds(6322)).toBe(true);
    expect(longRunHoldsQuality({ longM: 3046, qualityM: [] })).toBe(true);
  });

  it("holds the quality sessions exactly when none passes the long run", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 40_000 }),
        fc.array(fc.integer({ min: 3000, max: 20_000 }), { maxLength: 2 }),
        (longM, qualityM) => {
          expect(longRunHoldsQuality({ longM, qualityM })).toBe(
            qualityM.length === 0 || Math.max(...qualityM) <= longM,
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
