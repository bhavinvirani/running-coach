import { describe, expect, it } from "vitest";
import {
  addDays,
  dateChunks,
  daysBetween,
  localDateOf,
  mondayOf,
  noonUtc,
} from "../../src/lib/local-date";
import { syncStartDate } from "../../src/services/garmin-sync";

describe("local dates", () => {
  it("adds days across month ends and DST changes", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-08-29", "2026-09-28")).toBe(30);
  });

  it("gives an instant's calendar date in the user's zone", () => {
    const instant = new Date("2026-08-30T22:40:00Z");
    expect(localDateOf(instant, "Europe/Berlin")).toBe("2026-08-31");
    expect(localDateOf(instant, "America/Los_Angeles")).toBe("2026-08-30");
  });

  it("splits a range into 7-day chunks, oldest first, the last one short", () => {
    expect(dateChunks("2026-09-20", "2026-09-28", 7)).toEqual([
      { start: "2026-09-20", end: "2026-09-26" },
      { start: "2026-09-27", end: "2026-09-28" },
    ]);
    expect(dateChunks("2026-09-28", "2026-09-28", 7)).toEqual([
      { start: "2026-09-28", end: "2026-09-28" },
    ]);
  });

  it("gives the Monday that starts a date's week, the date itself on a Monday, across months and years", () => {
    expect(mondayOf("2026-10-05")).toBe("2026-10-05");
    expect(mondayOf("2026-10-07")).toBe("2026-10-05");
    expect(mondayOf("2026-10-11")).toBe("2026-10-05");
    expect(mondayOf("2026-10-01")).toBe("2026-09-28");
    expect(mondayOf("2027-01-02")).toBe("2026-12-28");
  });

  it("rejects anything but YYYY-MM-DD", () => {
    expect(() => addDays("28/09/2026", 1)).toThrow(RangeError);
  });
});

describe("syncStartDate", () => {
  it("goes 30 days back on the first sync", () => {
    expect(syncStartDate(null, "UTC", "2026-09-28")).toBe("2026-08-29");
  });

  it("re-reads the day before the cursor's local date", () => {
    const cursor = new Date("2026-09-27T23:30:00Z");
    expect(syncStartDate(cursor, "Europe/Berlin", "2026-09-30")).toBe("2026-09-27");
    expect(syncStartDate(cursor, "UTC", "2026-09-30")).toBe("2026-09-26");
  });

  it("resumes at or before the day after a chunk's noon-UTC cursor in every zone", () => {
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC", "Asia/Kolkata"]) {
      const start = syncStartDate(noonUtc("2026-09-04"), zone, "2026-09-28");
      expect(daysBetween(start, "2026-09-05")).toBeGreaterThanOrEqual(1);
    }
  });

  it("never starts after today", () => {
    expect(syncStartDate(new Date("2026-10-05T12:00:00Z"), "UTC", "2026-09-28")).toBe("2026-09-28");
  });
});
