import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, daysBetween, today, weekStart } from "./dates";

describe("today", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the date in the runner's time zone from the browser clock", () => {
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    expect(today("Europe/London")).toBe("2026-10-02");
  });

  it("is already tomorrow east of UTC and still yesterday west of it (time zones)", () => {
    // 23:30 UTC on Sunday 4 Oct: Monday in Tokyo, Sunday in New York.
    vi.setSystemTime(new Date("2026-10-04T23:30:00Z"));
    expect(today("Asia/Tokyo")).toBe("2026-10-05");
    expect(today("America/New_York")).toBe("2026-10-04");
  });

  it("keeps the local date on the night the clocks go back (DST)", () => {
    // 00:30 UTC on 25 Oct 2026 is 01:30 BST, the first of London's two 01:30s.
    vi.setSystemTime(new Date("2026-10-25T00:30:00Z"));
    expect(today("Europe/London")).toBe("2026-10-25");
  });
});

describe("addDays", () => {
  it("adds days across a month and a year", () => {
    expect(addDays("2026-10-05", 6)).toBe("2026-10-11");
    expect(addDays("2026-10-26", 6)).toBe("2026-11-01");
    expect(addDays("2026-12-28", 6)).toBe("2027-01-03");
  });

  it("moves one calendar day per day over a DST change (DST)", () => {
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
  });

  it("goes back with a negative count", () => {
    expect(addDays("2026-10-05", -1)).toBe("2026-10-04");
  });
});

describe("daysBetween", () => {
  it("counts whole days forward and back, across a DST change (DST)", () => {
    expect(daysBetween("2026-10-05", "2026-10-08")).toBe(3);
    expect(daysBetween("2026-10-08", "2026-10-05")).toBe(-3);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-10-05", "2026-10-05")).toBe(0);
  });
});

describe("weekStart", () => {
  it("finds the Monday of the Monday-to-Sunday week, across a month", () => {
    expect(weekStart("2026-10-05")).toBe("2026-10-05");
    expect(weekStart("2026-10-08")).toBe("2026-10-05");
    expect(weekStart("2026-10-11")).toBe("2026-10-05");
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
  });
});
