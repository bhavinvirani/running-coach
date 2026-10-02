import { describe, expect, it } from "vitest";
import { planFixture } from "@/test/fixtures";
import {
  dayType,
  phaseName,
  planDays,
  weekHolds,
  weekTitle,
  weekdayInitial,
  weekdayName,
} from "./plan-week";

const [first, , last] = planFixture().weeks;

describe("planDays", () => {
  it("gives seven days Monday to Sunday with each day's sessions, rest days empty", () => {
    const days = planDays(first!);
    expect(days.map((day) => [day.weekday, day.date, day.sessions.length])).toEqual([
      ["mon", "2026-10-05", 0],
      ["tue", "2026-10-06", 1],
      ["wed", "2026-10-07", 1],
      ["thu", "2026-10-08", 1],
      ["fri", "2026-10-09", 1],
      ["sat", "2026-10-10", 0],
      ["sun", "2026-10-11", 1],
    ]);
  });
});

describe("dayType", () => {
  it("is rest for a day without a session and the session's type otherwise", () => {
    expect(planDays(last!).map(dayType)).toEqual([
      "rest",
      "easy",
      "rest",
      "race_practice",
      "easy",
      "rest",
      "race",
    ]);
  });

  it("shows the run when a strength session shares its day", () => {
    const [easy, strength] = first!.sessions;
    const day = { weekday: "tue", date: "2026-10-06", sessions: [strength!, easy!] } as const;
    expect(dayType(day)).toBe("easy");
    expect(dayType({ ...day, sessions: [strength!] })).toBe("strength");
  });
});

describe("weekHolds", () => {
  it("holds its Monday to its Sunday and nothing outside them", () => {
    expect(weekHolds(first!, "2026-10-04")).toBe(false);
    expect(weekHolds(first!, "2026-10-05")).toBe(true);
    expect(weekHolds(first!, "2026-10-11")).toBe(true);
    expect(weekHolds(first!, "2026-10-12")).toBe(false);
  });
});

describe("labels", () => {
  it("names weeks, phases and weekdays", () => {
    expect(weekTitle(3)).toBe("Week 3");
    expect(phaseName("base")).toBe("Base");
    expect(phaseName("race")).toBe("Race week");
    expect(weekdayName("thu")).toBe("Thu");
    expect(weekdayInitial("thu")).toBe("T");
  });
});
