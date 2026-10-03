import { describe, expect, it } from "vitest";
import { conflictSentence, timePace } from "./goal-copy";

describe("conflictSentence", () => {
  it("says a marathon on 3 days would break the long-run cap, and what to change (long run cap)", () => {
    expect(
      conflictSentence(
        { code: "long_run_cap", distanceKey: "marathon", daysPerWeek: 3, minDaysPerWeek: 4 },
        "km",
      ),
    ).toBe(
      "A marathon plan needs at least 4 running days a week: with 3, the long run would be over the long-run cap. Add a day or pick a shorter race.",
    );
    expect(
      conflictSentence(
        { code: "long_run_cap", distanceKey: "half", daysPerWeek: 3, minDaysPerWeek: 4 },
        "km",
      ),
    ).toMatch(/^A half marathon plan needs/);
  });

  it("names the days and the recent weekly volume in the runner's unit (too many days)", () => {
    const tooMany = {
      code: "too_many_days",
      daysPerWeek: 6,
      maxDaysPerWeek: 4,
      baselineWeeklyM: 18000,
    } as const;
    expect(conflictSentence(tooMany, "km")).toBe(
      "6 runs a week would be more than 10% over the 18.0 km a week you have been running. Pick 4 days or fewer.",
    );
    expect(conflictSentence(tooMany, "mi")).toBe(
      "6 runs a week would be more than 10% over the 11.2 mi a week you have been running. Pick 4 days or fewer.",
    );
  });

  it("says a runner with no recent running cannot start on that many days (too many days, no runs)", () => {
    expect(
      conflictSentence(
        { code: "too_many_days", daysPerWeek: 5, maxDaysPerWeek: 3, baselineWeeklyM: 0 },
        "km",
      ),
    ).toBe(
      "With no running in the last 4 weeks, 5 runs a week would build up faster than 10% a week. Pick 3 days or fewer.",
    );
  });

  it("names the earliest start when the race comes before it (race too soon)", () => {
    expect(
      conflictSentence(
        { code: "race_too_soon", raceDate: "2026-10-03", earliestStart: "2026-10-05" },
        "km",
      ),
    ).toBe(
      "The plan would start on 5 Oct 2026, after the race on 3 Oct 2026. Pick a race date on or after 5 Oct 2026.",
    );
  });

  it("asks for a recent race time when nothing sets the paces (no recent time)", () => {
    expect(conflictSentence({ code: "no_recent_time" }, "km")).toBe(
      "There is no recent race or best effort to set your paces from. Enter a recent race time below.",
    );
  });
});

describe("timePace", () => {
  it("divides a target time by the race distance: 1:43:00 over a half is 4:53 /km", () => {
    expect(timePace("half", 6180, "km")).toBe("Pace 4:53 /km");
    expect(timePace("10k", 2940, "km")).toBe("Pace 4:54 /km");
  });

  it("gives the pace per mile for a runner in miles (unit conversion)", () => {
    // 6180 s over 13.11 mi is 471.4 s/mi.
    expect(timePace("half", 6180, "mi")).toBe("Pace 7:51 /mi");
    expect(timePace("1mi", 400, "mi")).toBe("Pace 6:40 /mi");
  });

  it("says nothing until there is a distance and a time", () => {
    expect(timePace(null, 6180, "km")).toBeNull();
    expect(timePace("5k", 0, "km")).toBeNull();
  });
});
