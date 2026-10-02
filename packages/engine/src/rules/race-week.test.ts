import { weekdaySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween } from "../dates";
import { raceWeekDays } from "./race-week";

const MONDAY = "2026-10-05";

describe("race week", () => {
  it("puts race practice 3 days before a Sunday race and easy runs on free days before Saturday", () => {
    expect(
      raceWeekDays({
        weekStart: MONDAY,
        raceDate: "2026-10-11",
        longRunDay: "sun",
        daysPerWeek: 4,
        lastHardDate: "2026-10-01",
      }),
    ).toEqual({ racePracticeDate: "2026-10-08", easyDates: ["2026-10-07", "2026-10-09"] });
  });

  it("skips race practice the day after last week's hard Sunday and fills the free days easy", () => {
    expect(
      raceWeekDays({
        weekStart: MONDAY,
        raceDate: "2026-10-08",
        longRunDay: "sun",
        daysPerWeek: 4,
        lastHardDate: "2026-10-04",
      }),
    ).toEqual({ racePracticeDate: null, easyDates: ["2026-10-05", "2026-10-06"] });
  });

  it("keeps race practice 2 days after last week's hard day", () => {
    expect(
      raceWeekDays({
        weekStart: MONDAY,
        raceDate: "2026-10-08",
        longRunDay: "sat",
        daysPerWeek: 3,
        lastHardDate: "2026-10-03",
      }).racePracticeDate,
    ).toBe("2026-10-05");
  });

  it("holds nothing before a Monday or Tuesday race: the day before is rest", () => {
    for (const raceDate of ["2026-10-05", "2026-10-06"]) {
      expect(
        raceWeekDays({
          weekStart: MONDAY,
          raceDate,
          longRunDay: "sun",
          daysPerWeek: 6,
          lastHardDate: null,
        }),
      ).toEqual({ racePracticeDate: null, easyDates: [] });
    }
  });

  it("holds race practice in a first-week race with nothing before it", () => {
    expect(
      raceWeekDays({
        weekStart: MONDAY,
        raceDate: "2026-10-10",
        longRunDay: "sun",
        daysPerWeek: 3,
        lastHardDate: null,
      }),
    ).toEqual({ racePracticeDate: "2026-10-07", easyDates: ["2026-10-05"] });
  });

  it("rejects a race outside the week as a programmer error", () => {
    expect(() =>
      raceWeekDays({
        weekStart: MONDAY,
        raceDate: "2026-10-12",
        longRunDay: "sun",
        daysPerWeek: 3,
        lastHardDate: null,
      }),
    ).toThrow(RangeError);
  });

  it("keeps every run before the day before the race, race practice 3 days out and 48 h after the last hard day", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom(...weekdaySchema.options),
        fc.integer({ min: 3, max: 6 }),
        fc.option(fc.integer({ min: 1, max: 6 })),
        (raceIndex, longRunDay, daysPerWeek, hardDaysBefore) => {
          const raceDate = addDays(MONDAY, raceIndex);
          const lastHardDate = hardDaysBefore === null ? null : addDays(MONDAY, -hardDaysBefore);
          const { racePracticeDate, easyDates } = raceWeekDays({
            weekStart: MONDAY,
            raceDate,
            longRunDay,
            daysPerWeek,
            lastHardDate,
          });
          const dates = [...easyDates, ...(racePracticeDate === null ? [] : [racePracticeDate])];
          expect(new Set(dates).size).toBe(dates.length);
          expect(dates.length).toBeLessThanOrEqual(daysPerWeek - 1);
          for (const date of dates) {
            expect(daysBetween(MONDAY, date)).toBeGreaterThanOrEqual(0);
            expect(daysBetween(date, raceDate)).toBeGreaterThanOrEqual(2);
          }
          if (racePracticeDate !== null) {
            expect(daysBetween(racePracticeDate, raceDate)).toBe(3);
            if (lastHardDate !== null) {
              expect(daysBetween(lastHardDate, racePracticeDate)).toBeGreaterThanOrEqual(2);
            }
          }
          // Every free day before the day before the race is used, up to the days asked for.
          expect(dates.length).toBe(Math.min(daysPerWeek - 1, Math.max(0, raceIndex - 1)));
        },
      ),
    );
  });
});
