import { raceDistanceKeySchema, type RaceDistanceKey } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  baselineReEntryFactor,
  recentVolumeM,
  reEnteredVolumeM,
  startVolume,
  trailingEmptyWeeks,
} from "./baseline";

const FLOOR = { "5k": 15_000, "10k": 20_000, half: 25_000, marathon: 30_000 } as const;
const MIN_DAYS = { "5k": 3, "10k": 3, half: 3, marathon: 4 } as const;

function baseline(weeklyVolumesM: number[], daysSinceLastRun: number | null) {
  return { weeklyVolumesM, longestRunM: 10_000, daysSinceLastRun };
}

/** A stand-in for the week builder: 6 km a day the runner asks for. */
const sixKmADay = (days: number) => days * 6000;

function start(
  weeklyVolumesM: number[],
  daysSinceLastRun: number | null,
  daysPerWeek: number,
  distanceKey: RaceDistanceKey = "half",
  neededWeeklyM = sixKmADay,
) {
  return startVolume({
    baseline: baseline(weeklyVolumesM, daysSinceLastRun),
    distanceKey,
    daysPerWeek,
    neededWeeklyM,
  });
}

describe("baseline", () => {
  it("averages only the weeks with running", () => {
    expect(recentVolumeM([10_000, 0, 20_000, 0])).toBe(15_000);
    expect(recentVolumeM([30_000, 30_000, 30_000, 30_000])).toBe(30_000);
  });

  it("gives 0 when no baseline week has running", () => {
    expect(recentVolumeM([0, 0, 0, 0])).toBe(0);
  });

  it("counts the empty weeks since the last week with running", () => {
    expect(trailingEmptyWeeks([60_000, 0, 0, 0])).toBe(3);
    expect(trailingEmptyWeeks([5000, 0, 5000, 0])).toBe(1);
    expect(trailingEmptyWeeks([1, 2, 3, 4])).toBe(0);
    expect(trailingEmptyWeeks([0, 0, 0, 0])).toBe(4);
  });

  it("re-enters at the smaller of the factors for the days off and the empty weeks: 7 days each", () => {
    expect(baselineReEntryFactor(baseline([40_000, 40_000, 40_000, 40_000], 3))).toBe(1);
    expect(baselineReEntryFactor(baseline([40_000, 40_000, 40_000, 0], 3))).toBe(0.7);
    expect(baselineReEntryFactor(baseline([40_000, 40_000, 0, 0], 3))).toBe(0.5);
    expect(baselineReEntryFactor(baseline([40_000, 40_000, 40_000, 40_000], 7))).toBe(0.7);
    expect(baselineReEntryFactor(baseline([40_000, 40_000, 40_000, 0], 20))).toBe(0.5);
    expect(baselineReEntryFactor(baseline([0, 0, 0, 0], null))).toBe(0);
  });

  it("restarts at 30 km, not 60, after three empty weeks and a run yesterday", () => {
    expect(reEnteredVolumeM(baseline([60_000, 0, 0, 0], 1))).toBe(30_000);
  });

  it("restarts 40 km weeks at 20 km after 20 days off and at 28 km after one empty week", () => {
    expect(reEnteredVolumeM(baseline([40_000, 40_000, 40_000, 40_000], 20))).toBe(20_000);
    expect(reEnteredVolumeM(baseline([40_000, 40_000, 40_000, 0], 2))).toBe(28_000);
  });

  it("starts at the recent volume when it holds the days asked for: at the needed volume and 1 m over", () => {
    expect(start([24_000, 24_000, 24_000, 24_000], 2, 4)).toEqual({
      ok: true,
      startVolumeM: 24_000,
      warning: null,
    });
    expect(start([24_001, 24_001, 24_001, 24_001], 2, 4)).toMatchObject({ startVolumeM: 24_001 });
  });

  it("starts at re-entry, not a floor, after 20 days off: 20 km from 40 km weeks", () => {
    expect(start([40_000, 40_000, 40_000, 40_000], 20, 3)).toEqual({
      ok: true,
      startVolumeM: 20_000,
      warning: null,
    });
  });

  it("lifts week 1 to the needed volume without a warning when that is within 10% of recent", () => {
    // 21 819 m * 1.1 = 24 000.9 m: 24 000 m is allowed.
    expect(start([21_819, 21_819, 21_819, 21_819], 2, 4)).toEqual({
      ok: true,
      startVolumeM: 24_000,
      warning: null,
    });
  });

  it("reports too_many_days with the most days that fit once the lift passes 10%: 1 m under it", () => {
    // 21 818 m * 1.1 = 23 999.8 m: 24 000 m on 4 days is over; 18 000 m on 3 days fits.
    expect(start([21_818, 21_818, 21_818, 21_818], 2, 4)).toEqual({
      ok: false,
      conflict: {
        code: "too_many_days",
        daysPerWeek: 4,
        maxDaysPerWeek: 3,
        recentWeeklyM: 21_818,
        neededWeeklyM: 24_000,
      },
    });
  });

  it("reports too_many_days with the largest number of days that fit, not the smallest", () => {
    // 28 000 m allows 30 800 m: 5 days need 30 000 m, 6 need 36 000 m.
    expect(start([28_000, 28_000, 28_000, 28_000], 2, 6)).toMatchObject({
      ok: false,
      conflict: { code: "too_many_days", daysPerWeek: 6, maxDaysPerWeek: 5 },
    });
  });

  it("lifts week 1 with start_volume_lifted when not even 3 days fit the 10% rule", () => {
    expect(start([10_000, 10_000, 10_000, 10_000], 2, 5)).toEqual({
      ok: true,
      startVolumeM: 30_000,
      warning: { code: "start_volume_lifted", recentWeeklyM: 10_000, startVolumeM: 30_000 },
    });
  });

  it("never offers a marathon fewer than 4 days: lifts instead of reporting 3", () => {
    // 20 000 m allows 22 000 m: 3 days (18 000 m) would fit, but a marathon needs 4 (24 000 m).
    expect(start([20_000, 20_000, 20_000, 20_000], 2, 5, "marathon")).toEqual({
      ok: true,
      startVolumeM: 30_000,
      warning: { code: "start_volume_lifted", recentWeeklyM: 20_000, startVolumeM: 30_000 },
    });
  });

  it("warns no_recent_runs and starts at the larger of the needed volume and the floor with no history", () => {
    expect(start([0, 0, 0, 0], 40, 4, "half")).toEqual({
      ok: true,
      startVolumeM: 25_000,
      warning: { code: "no_recent_runs", startVolumeM: 25_000 },
    });
    expect(start([0, 0, 0, 0], null, 6, "half")).toEqual({
      ok: true,
      startVolumeM: 36_000,
      warning: { code: "no_recent_runs", startVolumeM: 36_000 },
    });
  });

  it("treats volume with no runs on record as no history", () => {
    expect(start([12_000, 0, 0, 0], null, 3, "5k")).toEqual({
      ok: true,
      startVolumeM: 18_000,
      warning: { code: "no_recent_runs", startVolumeM: 18_000 },
    });
  });

  it("starts at recent volume or the needed one, conflicts only when fewer days fit 10%, and lifts past it only when none do", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.array(fc.nat({ max: 120_000 }), { minLength: 4, maxLength: 4 }),
        fc.option(fc.nat({ max: 60 })),
        fc.integer({ min: 3, max: 6 }),
        fc.integer({ min: 2000, max: 12_000 }),
        (distanceKey, weeklyVolumesM, daysSinceLastRun, daysPerWeek, perDayM) => {
          const neededWeeklyM = (days: number) => days * perDayM;
          const recentM = reEnteredVolumeM(baseline(weeklyVolumesM, daysSinceLastRun));
          const allowedM = Math.floor(recentM * 1.1);
          const neededM = neededWeeklyM(daysPerWeek);
          const result = start(
            weeklyVolumesM,
            daysSinceLastRun,
            daysPerWeek,
            distanceKey,
            neededWeeklyM,
          );
          expect(Number.isInteger(recentM)).toBe(true);
          if (!result.ok) {
            if (result.conflict.code !== "too_many_days") throw new Error("only too_many_days");
            const { maxDaysPerWeek } = result.conflict;
            expect(result.conflict).toEqual({
              code: "too_many_days",
              daysPerWeek,
              maxDaysPerWeek,
              recentWeeklyM: recentM,
              neededWeeklyM: neededM,
            });
            expect(neededM).toBeGreaterThan(allowedM);
            expect(maxDaysPerWeek).toBeGreaterThanOrEqual(MIN_DAYS[distanceKey]);
            expect(maxDaysPerWeek).toBeLessThan(daysPerWeek);
            expect(neededWeeklyM(maxDaysPerWeek)).toBeLessThanOrEqual(allowedM);
            expect(neededWeeklyM(maxDaysPerWeek + 1)).toBeGreaterThan(allowedM);
            return;
          }
          const { startVolumeM, warning } = result;
          expect(Number.isInteger(startVolumeM)).toBe(true);
          if (recentM === 0) {
            expect(startVolumeM).toBe(Math.max(neededM, FLOOR[distanceKey]));
            expect(warning).toEqual({ code: "no_recent_runs", startVolumeM });
          } else if (warning === null) {
            expect(startVolumeM).toBe(Math.max(recentM, neededM));
            expect(startVolumeM).toBeLessThanOrEqual(Math.max(recentM, allowedM));
          } else {
            expect(warning).toEqual({
              code: "start_volume_lifted",
              recentWeeklyM: recentM,
              startVolumeM: neededM,
            });
            expect(startVolumeM).toBe(neededM);
            expect(neededWeeklyM(MIN_DAYS[distanceKey])).toBeGreaterThan(allowedM);
          }
        },
      ),
    );
  });
});
