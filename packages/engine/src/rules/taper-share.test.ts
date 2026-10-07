import { raceDistanceKeySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, weekdayIndex, weekdayOf } from "../dates";
import {
  isRaceBandWeek,
  taperCeilingM,
  taperShare,
  taperWeekCount,
  thursdayDaysOut,
} from "./taper-share";

const MONDAY = "2026-12-07";
// The race on each weekday of the week of MONDAY: Monday 2026-12-07 to Sunday 2026-12-13.
const RACE_ON = (weekday: number) => addDays(MONDAY, weekday);
// The Monday `weeks` weeks before the race's own week.
const weekBefore = (raceDate: string, weeks: number) =>
  addDays(raceDate, -weekdayIndex(weekdayOf(raceDate)) - 7 * weeks);

describe("taper share", () => {
  it("counts a week's days to the race from its Thursday", () => {
    expect(thursdayDaysOut({ weekStart: MONDAY, raceDate: "2026-12-13" })).toBe(3);
    expect(thursdayDaysOut({ weekStart: MONDAY, raceDate: "2026-12-07" })).toBe(-3);
    expect(thursdayDaysOut({ weekStart: "2026-11-30", raceDate: "2026-12-09" })).toBe(6);
  });

  it("puts a week whose Thursday is 6 days out in the race band at 40%, and one 7 days out at 70%", () => {
    // A Wednesday race: the week before's Thursday is 6 days out; a Thursday race's, 7.
    expect(taperShare({ distanceKey: "half", raceDate: RACE_ON(2), weekStart: "2026-11-30" })).toBe(
      0.4,
    );
    expect(taperShare({ distanceKey: "half", raceDate: RACE_ON(3), weekStart: "2026-11-30" })).toBe(
      0.7,
    );
    expect(isRaceBandWeek({ raceDate: RACE_ON(2), weekStart: "2026-11-30" })).toBe(true);
    expect(isRaceBandWeek({ raceDate: RACE_ON(3), weekStart: "2026-11-30" })).toBe(false);
  });

  it("holds a week whose Thursday is 13 days out at 70% (marathon 60%) and ends the taper at 14 days out", () => {
    for (const distanceKey of ["5k", "10k", "half"] as const) {
      expect(taperShare({ distanceKey, raceDate: RACE_ON(2), weekStart: "2026-11-23" })).toBe(0.7);
      expect(taperShare({ distanceKey, raceDate: RACE_ON(3), weekStart: "2026-11-23" })).toBeNull();
    }
    expect(
      taperShare({ distanceKey: "marathon", raceDate: RACE_ON(2), weekStart: "2026-11-23" }),
    ).toBe(0.6);
    expect(
      taperShare({ distanceKey: "marathon", raceDate: RACE_ON(3), weekStart: "2026-11-23" }),
    ).toBe(0.8);
  });

  it("holds a marathon week whose Thursday is 20 days out at 80% and ends its taper at 21 days out", () => {
    expect(
      taperShare({ distanceKey: "marathon", raceDate: RACE_ON(2), weekStart: "2026-11-16" }),
    ).toBe(0.8);
    expect(
      taperShare({ distanceKey: "marathon", raceDate: RACE_ON(3), weekStart: "2026-11-16" }),
    ).toBeNull();
  });

  it("puts the race week in the race band whatever the race's weekday, its Thursday before or after the race", () => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      expect(
        taperShare({ distanceKey: "10k", raceDate: RACE_ON(weekday), weekStart: MONDAY }),
      ).toBe(0.4);
    }
  });

  it("caps a taper week at its share of the taper peak in whole meters, and leaves a week before the taper alone", () => {
    // 40% of 56 001 m is 22 400.4 m; 70% of it 39 200.7 m.
    expect(
      taperCeilingM({
        distanceKey: "half",
        raceDate: RACE_ON(6),
        weekStart: MONDAY,
        peakM: 56_001,
      }),
    ).toBe(22_400);
    expect(
      taperCeilingM({
        distanceKey: "half",
        raceDate: RACE_ON(6),
        weekStart: "2026-11-30",
        peakM: 56_001,
      }),
    ).toBe(39_200);
    expect(
      taperCeilingM({
        distanceKey: "half",
        raceDate: RACE_ON(6),
        weekStart: "2026-11-23",
        peakM: 56_001,
      }),
    ).toBeNull();
  });

  it("gives Monday to Wednesday races 3 taper weeks (marathon 4) and Thursday to Sunday races 2 (marathon 3)", () => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const early = weekday <= 2;
      expect(taperWeekCount({ distanceKey: "5k", raceDate: RACE_ON(weekday) })).toBe(early ? 3 : 2);
      expect(taperWeekCount({ distanceKey: "marathon", raceDate: RACE_ON(weekday) })).toBe(
        early ? 4 : 3,
      );
    }
  });

  it("bands every week by its Thursday's days to the race, for every race weekday and distance", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
        (distanceKey, weekday, weeks) => {
          const raceDate = RACE_ON(weekday);
          const weekStart = weekBefore(raceDate, weeks);
          const daysOut = thursdayDaysOut({ weekStart, raceDate });
          expect(daysOut).toBe(weekday - 3 + 7 * weeks);
          const marathon = distanceKey === "marathon";
          const expected =
            daysOut <= 6
              ? 0.4
              : daysOut <= 13
                ? marathon
                  ? 0.6
                  : 0.7
                : marathon && daysOut <= 20
                  ? 0.8
                  : null;
          expect(taperShare({ distanceKey, raceDate, weekStart })).toBe(expected);
          expect(isRaceBandWeek({ raceDate, weekStart })).toBe(daysOut <= 6);
          // The taper weeks are exactly the weeks with a band, counted back from the race week.
          expect(weeks < taperWeekCount({ distanceKey, raceDate })).toBe(expected !== null);
        },
      ),
    );
  });

  it("never lets a week closer to the race hold a larger share", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...raceDistanceKeySchema.options),
        fc.integer({ min: 0, max: 6 }),
        (distanceKey, weekday) => {
          const raceDate = RACE_ON(weekday);
          const shares = Array.from({ length: taperWeekCount({ distanceKey, raceDate }) }, (_, k) =>
            taperShare({ distanceKey, raceDate, weekStart: weekBefore(raceDate, k) }),
          );
          expect(shares.every((share) => share !== null && share >= 0.4 && share <= 0.8)).toBe(
            true,
          );
          expect(shares).toEqual([...shares].sort((a, b) => a! - b!));
        },
      ),
    );
  });
});
