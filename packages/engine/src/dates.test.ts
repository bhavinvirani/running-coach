import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, nextMonday, weekdayIndex, weekdayOf } from "./dates";

const isoDate = fc.integer({ min: 0, max: 20_000 }).map((days) => addDays("2000-01-03", days));

describe("dates", () => {
  it("adds days across a month, a year and the spring DST change", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-10-05", -5)).toBe("2026-09-30");
  });

  it("counts days from one date to another, negative when the second is earlier", () => {
    expect(daysBetween("2026-10-05", "2026-10-05")).toBe(0);
    expect(daysBetween("2026-10-05", "2026-10-11")).toBe(6);
    expect(daysBetween("2026-10-05", "2026-10-04")).toBe(-1);
    expect(daysBetween("2028-02-27", "2028-03-01")).toBe(3);
  });

  it("names the weekday of a date, Monday first", () => {
    expect(weekdayOf("2026-10-05")).toBe("mon");
    expect(weekdayOf("2026-10-11")).toBe("sun");
    expect(weekdayIndex("mon")).toBe(0);
    expect(weekdayIndex("sun")).toBe(6);
  });

  it("finds the next Monday, or the same day on a Monday", () => {
    expect(nextMonday("2026-10-05")).toBe("2026-10-05");
    expect(nextMonday("2026-10-06")).toBe("2026-10-12");
    expect(nextMonday("2026-10-11")).toBe("2026-10-12");
  });

  it("rejects a string that is not a calendar date as a programmer error", () => {
    expect(() => addDays("2026-13-01", 1)).toThrow(RangeError);
    expect(() => weekdayOf("not a date")).toThrow(RangeError);
    for (const date of ["2026-02-29", "1900-02-29", "2026-04-31", "2026-00-10", "2026-01-00"]) {
      expect(() => weekdayOf(date), date).toThrow(RangeError);
    }
  });

  it("knows leap years and years before 100: 2024-02-29, 2000-02-29 and 0099-03-01", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2000-02-29", 1)).toBe("2000-03-01");
    expect(addDays("0099-02-28", 1)).toBe("0099-03-01");
  });

  it("round-trips: adding the days between two dates gives the second date", () => {
    fc.assert(
      fc.property(isoDate, isoDate, (from, to) => {
        expect(addDays(from, daysBetween(from, to))).toBe(to);
      }),
    );
  });

  it("puts every next Monday on a Monday within 6 days", () => {
    fc.assert(
      fc.property(isoDate, (date) => {
        const monday = nextMonday(date);
        expect(weekdayOf(monday)).toBe("mon");
        expect(daysBetween(date, monday)).toBeGreaterThanOrEqual(0);
        expect(daysBetween(date, monday)).toBeLessThanOrEqual(6);
      }),
    );
  });
});
