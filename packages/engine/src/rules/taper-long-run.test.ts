import { raceDistanceKeySchema, weekdaySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, weekdayIndex } from "../dates";
import {
  inTaperLongRunBands,
  longRunDayCapM,
  longRunKeepsDay,
  taperLongRunCapM,
  weekRunCaps,
  type WeekRunCapsInput,
} from "./taper-long-run";

const WEEK_START = "2026-10-12"; // a Monday
const SUNDAY = addDays(WEEK_START, 6);

/** The race `daysOut` days after the week's Sunday. */
const raceAfterSunday = (daysOut: number) => addDays(SUNDAY, daysOut);

/**
 * A 5K week with a Sunday long run, a Thursday race 11 days after it, no long run before and a 5 km
 * seed: its long run's cap by days is 70% of 5 km, 3500 m.
 */
function weekOf(input: Partial<WeekRunCapsInput>): WeekRunCapsInput {
  return {
    distanceKey: "5k",
    raceDate: raceAfterSunday(11),
    longRunDay: "sun",
    weekStart: WEEK_START,
    longRunsBeforeM: [],
    seedM: 5000,
    runCapM: 9000,
    minRunM: 3000,
    ...input,
  };
}

describe("taper long run", () => {
  it("keeps the long run on its day 6 days out and drops it 5 days out", () => {
    expect(longRunKeepsDay(6)).toBe(true);
    expect(longRunKeepsDay(5)).toBe(false);
    expect(longRunKeepsDay(0)).toBe(false);
    expect(taperLongRunCapM({ distanceKey: "half", daysOut: 5, peakLongRunM: 16_800 })).toBe(0);
  });

  it("caps the long run 6 to 13 days out at 70% of the peak long run, a marathon's at 60%, in whole meters", () => {
    for (const daysOut of [6, 13]) {
      expect(taperLongRunCapM({ distanceKey: "half", daysOut, peakLongRunM: 16_801 })).toBe(11_760);
      expect(taperLongRunCapM({ distanceKey: "marathon", daysOut, peakLongRunM: 21_600 })).toBe(
        12_960,
      );
    }
  });

  it("leaves a 5K, 10K or half long run 14 days out to its other caps", () => {
    for (const distanceKey of ["5k", "10k", "half"] as const) {
      expect(taperLongRunCapM({ distanceKey, daysOut: 14, peakLongRunM: 16_800 })).toBeNull();
    }
  });

  it("caps a marathon long run 14 to 20 days out at 80% and none 21 days out", () => {
    expect(taperLongRunCapM({ distanceKey: "marathon", daysOut: 14, peakLongRunM: 21_600 })).toBe(
      17_280,
    );
    expect(taperLongRunCapM({ distanceKey: "marathon", daysOut: 20, peakLongRunM: 21_600 })).toBe(
      17_280,
    );
    expect(
      taperLongRunCapM({ distanceKey: "marathon", daysOut: 21, peakLongRunM: 21_600 }),
    ).toBeNull();
  });

  it("puts a long run 13 days out inside the taper's bands and one 14 days out outside, a marathon's 20 and 21", () => {
    for (const distanceKey of ["5k", "10k", "half"] as const) {
      expect(inTaperLongRunBands({ distanceKey, daysOut: 13 })).toBe(true);
      expect(inTaperLongRunBands({ distanceKey, daysOut: 14 })).toBe(false);
    }
    expect(inTaperLongRunBands({ distanceKey: "marathon", daysOut: 20 })).toBe(true);
    expect(inTaperLongRunBands({ distanceKey: "marathon", daysOut: 21 })).toBe(false);
    expect(inTaperLongRunBands({ distanceKey: "half", daysOut: 0 })).toBe(true);
  });

  it("puts a long run inside the taper's bands exactly when its days to the race give it a cap", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 0, max: 40 }),
        (distanceKey, daysOut) => {
          expect(inTaperLongRunBands({ distanceKey, daysOut })).toBe(
            taperLongRunCapM({ distanceKey, daysOut, peakLongRunM: 20_000 }) !== null,
          );
        },
      ),
    );
  });

  it("never caps above the peak long run, and never loosens closer to the race", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 1_000, max: 50_000 }),
        (distanceKey, daysOut, peakLongRunM) => {
          const cap = taperLongRunCapM({ distanceKey, daysOut, peakLongRunM });
          const closer = taperLongRunCapM({
            distanceKey,
            daysOut: Math.max(0, daysOut - 1),
            peakLongRunM,
          });
          if (cap === null) {
            expect(daysOut).toBeGreaterThanOrEqual(distanceKey === "marathon" ? 21 : 14);
            return;
          }
          expect(Number.isInteger(cap)).toBe(true);
          expect(cap).toBeLessThanOrEqual(0.8 * peakLongRunM);
          expect(cap === 0).toBe(!longRunKeepsDay(daysOut));
          expect(closer).not.toBeNull();
          expect(closer).toBeLessThanOrEqual(cap);
        },
      ),
    );
  });

  it("keeps the long run where its cap by days is at or over 20 min, and drops it where the cap is under 20 min: every run of the week capped at 20 min when the long run is dropped", () => {
    const caps = (minRunM: number, runCapM = 9000) => weekRunCaps(weekOf({ minRunM, runCapM }));
    expect(longRunDayCapM(weekOf({}))).toBe(3500);
    // 20 min under the cap, at it, and over it.
    expect(caps(3499)).toEqual({ maxRunM: 3500, longRun: true });
    expect(caps(3500)).toEqual({ maxRunM: 3500, longRun: true });
    expect(caps(3501)).toEqual({ maxRunM: 3501, longRun: false });
    expect(caps(4372)).toEqual({ maxRunM: 4372, longRun: false });
    // 110% of the recent longest still holds under both.
    expect(caps(4372, 4000)).toEqual({ maxRunM: 4000, longRun: false });
    expect(caps(3000, 3200)).toEqual({ maxRunM: 3200, longRun: true });
  });

  it("caps a long-run day 5 days out, or after the race, as 6 days out would: never at 0", () => {
    for (const daysOut of [6, 5, 0, -3]) {
      expect(longRunDayCapM(weekOf({ raceDate: raceAfterSunday(daysOut) }))).toBe(3500);
    }
    expect(weekRunCaps(weekOf({ raceDate: raceAfterSunday(5) }))).toEqual({
      maxRunM: 3500,
      longRun: true,
    });
  });

  it("caps a 5K, 10K or half long-run day 13 days out at 70%, and leaves one 14 days out to 110% of the recent longest", () => {
    for (const distanceKey of ["5k", "10k", "half"] as const) {
      const at = (daysOut: number) => weekOf({ distanceKey, raceDate: raceAfterSunday(daysOut) });
      expect(longRunDayCapM(at(13))).toBe(3500);
      expect(longRunDayCapM(at(14))).toBeNull();
      expect(weekRunCaps(at(14))).toEqual({ maxRunM: 9000, longRun: true });
    }
  });

  it("caps a marathon long-run day 13 days out at 60%, 14 to 20 days out at 80%, and none 21 days out", () => {
    const at = (daysOut: number) =>
      weekOf({
        distanceKey: "marathon",
        raceDate: raceAfterSunday(daysOut),
        seedM: 20_000,
        runCapM: 30_000,
      });
    expect(longRunDayCapM(at(13))).toBe(12_000);
    expect(longRunDayCapM(at(14))).toBe(16_000);
    expect(longRunDayCapM(at(20))).toBe(16_000);
    expect(longRunDayCapM(at(21))).toBeNull();
    expect(weekRunCaps(at(20))).toEqual({ maxRunM: 16_000, longRun: true });
    expect(weekRunCaps(at(21))).toEqual({ maxRunM: 30_000, longRun: true });
  });

  it("counts the days from the week's long-run day: a Saturday long run 14 days out has no cap where Sunday's 13 days out does", () => {
    const raceDate = raceAfterSunday(13);
    expect(longRunDayCapM(weekOf({ raceDate, longRunDay: "sun" }))).toBe(3500);
    expect(longRunDayCapM(weekOf({ raceDate, longRunDay: "sat" }))).toBeNull();
  });

  it("measures the cap from the largest long run before the week, and from the seed only when there is none", () => {
    expect(longRunDayCapM(weekOf({ longRunsBeforeM: [9000, 12_000, 10_000] }))).toBe(8400);
    expect(longRunDayCapM(weekOf({ longRunsBeforeM: [4000], seedM: 6000 }))).toBe(2800);
    expect(longRunDayCapM(weekOf({ longRunsBeforeM: [], seedM: 6000 }))).toBe(4200);
  });

  it("puts no cap by days on a plan with no race: only 110% of the recent longest holds", () => {
    const fitness = weekOf({ raceDate: null, runCapM: 3000, minRunM: 3500 });
    expect(longRunDayCapM(fitness)).toBeNull();
    expect(weekRunCaps(fitness)).toEqual({ maxRunM: 3000, longRun: true });
  });

  const weekArb = fc
    .record({
      distanceKey: fc.constantFrom(...raceDistanceKeySchema.options),
      weeks: fc.integer({ min: 0, max: 300 }),
      raceDays: fc.option(fc.integer({ min: -7, max: 50 })),
      longRunDay: fc.constantFrom(...weekdaySchema.options),
      longRunsBeforeM: fc.array(fc.integer({ min: 2000, max: 40_000 }), { maxLength: 20 }),
      seedM: fc.integer({ min: 5000, max: 35_000 }),
      runCapM: fc.integer({ min: 2000, max: 45_000 }),
      minRunM: fc.integer({ min: 1500, max: 6000 }),
    })
    .map(({ weeks, raceDays, ...drawn }): WeekRunCapsInput => {
      const weekStart = addDays("2025-01-06", 7 * weeks);
      return {
        ...drawn,
        weekStart,
        raceDate: raceDays === null ? null : addDays(weekStart, raceDays),
      };
    });

  it("never lets a run pass 110% of the recent longest, nor the long run's cap by days by more than 20 min, and drops the long run exactly where that cap is under 20 min", () => {
    fc.assert(
      fc.property(weekArb, (week) => {
        const dayCapM = longRunDayCapM(week);
        const { maxRunM, longRun } = weekRunCaps(week);
        expect(maxRunM).toBeLessThanOrEqual(week.runCapM);
        expect(maxRunM).toBeLessThanOrEqual(Math.max(dayCapM ?? Infinity, week.minRunM));
        expect(longRun).toBe(dayCapM === null || dayCapM >= week.minRunM);
        // The long run, the week's longest, fits its cap; without one no run passes 20 min.
        expect(maxRunM).toBeLessThanOrEqual(longRun ? (dayCapM ?? Infinity) : week.minRunM);
        expect(maxRunM).toBe(Math.min(week.runCapM, Math.max(dayCapM ?? Infinity, week.minRunM)));
      }),
    );
  });

  it("caps a long-run day by days only inside the taper bands, in whole meters, never at 0 nor over 80% of the largest long run before, and never looser closer to the race", () => {
    fc.assert(
      fc.property(weekArb, (week) => {
        const dayCapM = longRunDayCapM(week);
        if (week.raceDate === null) {
          expect(dayCapM).toBeNull();
          return;
        }
        const longDate = addDays(week.weekStart, weekdayIndex(week.longRunDay));
        const daysOut = daysBetween(longDate, week.raceDate);
        expect(dayCapM !== null).toBe(
          inTaperLongRunBands({ distanceKey: week.distanceKey, daysOut }),
        );
        if (dayCapM === null) return;
        const peakM =
          week.longRunsBeforeM.length === 0 ? week.seedM : Math.max(...week.longRunsBeforeM);
        expect(Number.isInteger(dayCapM)).toBe(true);
        expect(dayCapM).toBeGreaterThan(0);
        expect(dayCapM).toBeLessThanOrEqual(0.8 * peakM);
        const closer = longRunDayCapM({ ...week, raceDate: addDays(week.raceDate, -1) });
        expect(closer).not.toBeNull();
        expect(closer).toBeLessThanOrEqual(dayCapM);
      }),
    );
  });
});
