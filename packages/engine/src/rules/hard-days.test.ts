import { weekdaySchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { weekdayIndex } from "../dates";
import { isSpacedFromHardDay, weekLayout } from "./hard-days";

describe("hard days", () => {
  it("puts two quality sessions 2 and 4 days after a Sunday long run, inside the week", () => {
    expect(
      weekLayout({ longRunDay: "sun", daysPerWeek: 4, qualityCount: 2, lastHardDaysBefore: null }),
    ).toEqual({
      longRun: "sun",
      quality: ["tue", "thu"],
      easy: ["wed"],
    });
  });

  it("puts two quality sessions on Monday and Wednesday around a Saturday long run", () => {
    expect(
      weekLayout({ longRunDay: "sat", daysPerWeek: 4, qualityCount: 2, lastHardDaysBefore: 2 })
        .quality,
    ).toEqual(["mon", "wed"]);
  });

  it("puts one quality session 3 days after the long run", () => {
    expect(
      weekLayout({ longRunDay: "mon", daysPerWeek: 3, qualityCount: 1, lastHardDaysBefore: 3 }),
    ).toEqual({
      longRun: "mon",
      quality: ["thu"],
      easy: ["sat"],
    });
  });

  it("fills easy days 3, 5, 1 and 6 days after the long run, then the free days left", () => {
    expect(
      weekLayout({ longRunDay: "sun", daysPerWeek: 6, qualityCount: 2, lastHardDaysBefore: 1 })
        .easy,
    ).toEqual(["wed", "fri", "mon"]);
    expect(
      weekLayout({ longRunDay: "sun", daysPerWeek: 6, qualityCount: 1, lastHardDaysBefore: 1 })
        .easy,
    ).toEqual(["fri", "mon", "sat", "tue"]);
    expect(
      weekLayout({ longRunDay: "sun", daysPerWeek: 5, qualityCount: 0, lastHardDaysBefore: 1 })
        .easy,
    ).toEqual(["wed", "fri", "mon", "sat"]);
  });

  it.each([
    [3, 3],
    [2, 2],
    [8, 1],
    [4, -1],
    [4, 1.5],
  ])(
    "rejects %s days with %s quality sessions as a programmer error",
    (daysPerWeek, qualityCount) => {
      expect(() =>
        weekLayout({ longRunDay: "sun", daysPerWeek, qualityCount, lastHardDaysBefore: null }),
      ).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5])(
    "rejects a last hard day %s days before Monday as a programmer error",
    (days) => {
      expect(() =>
        weekLayout({
          longRunDay: "sun",
          daysPerWeek: 4,
          qualityCount: 1,
          lastHardDaysBefore: days,
        }),
      ).toThrow(RangeError);
    },
  );

  it("moves a Monday session a day later after a hard Sunday: Friday long run, 2 sessions then 1", () => {
    // Last week's L+2 was Sunday; this week's lone L+3 would be the Monday after it.
    expect(
      weekLayout({ longRunDay: "fri", daysPerWeek: 4, qualityCount: 1, lastHardDaysBefore: 1 }),
    ).toEqual({
      longRun: "fri",
      quality: ["tue"],
      easy: ["mon", "wed"],
    });
  });

  it("moves a Monday session a day later after a hard Sunday: Thursday long run, 1 session then 2", () => {
    // Last week's L+3 was Sunday; this week's L+4 would be the Monday after it.
    expect(
      weekLayout({ longRunDay: "thu", daysPerWeek: 5, qualityCount: 2, lastHardDaysBefore: 1 }),
    ).toEqual({
      longRun: "thu",
      quality: ["sat", "tue"],
      easy: ["sun", "fri"],
    });
  });

  it("keeps the Monday session when the last hard day was Saturday", () => {
    expect(
      weekLayout({ longRunDay: "fri", daysPerWeek: 4, qualityCount: 1, lastHardDaysBefore: 2 })
        .quality,
    ).toEqual(["mon"]);
  });

  it("spaces a hard day 2 days from the last one, not 1", () => {
    expect(isSpacedFromHardDay({ lastHardDate: "2026-10-04", date: "2026-10-06" })).toBe(true);
    expect(isSpacedFromHardDay({ lastHardDate: "2026-10-04", date: "2026-10-05" })).toBe(false);
    expect(isSpacedFromHardDay({ lastHardDate: null, date: "2026-10-05" })).toBe(true);
  });

  it("keeps every pair of hard days 2 days apart over any run of weeks, on distinct days", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...weekdaySchema.options),
        fc.integer({ min: 3, max: 6 }),
        fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 8 }),
        (longRunDay, daysPerWeek, counts) => {
          const hard: number[] = [];
          counts.forEach((wanted, week) => {
            const qualityCount = Math.min(wanted, daysPerWeek - 1);
            const last = hard.at(-1);
            const layout = weekLayout({
              longRunDay,
              daysPerWeek,
              qualityCount,
              lastHardDaysBefore: last === undefined ? null : 7 * week - last,
            });
            const days = [layout.longRun, ...layout.quality, ...layout.easy];
            expect(layout.quality).toHaveLength(qualityCount);
            expect(new Set(days).size).toBe(days.length);
            expect(days).toHaveLength(daysPerWeek);
            hard.push(
              ...[layout.longRun, ...layout.quality]
                .map((day) => 7 * week + weekdayIndex(day))
                .sort((a, b) => a - b),
            );
          });
          const sorted = [...hard].sort((a, b) => a - b);
          expect(sorted).toEqual(hard);
          sorted.slice(1).forEach((day, k) => expect(day - sorted[k]!).toBeGreaterThanOrEqual(2));
        },
      ),
      { numRuns: 500 },
    );
  });
});
