import { describe, expect, it } from "vitest";
import { weeklyReviewCardFixture } from "@/test/fixtures-weekly-review";
import { comingSessionState, planLimitLine, weekStats } from "./weekly-review";

const summary = weeklyReviewCardFixture().summary;

describe("weekStats", () => {
  it("gives distance run of planned, sessions done of planned and time, in km", () => {
    expect(weekStats(summary, "km")).toEqual([
      { label: "Distance", value: "31.4", unit: "of 38.0 km" },
      { label: "Sessions", value: "4", unit: "of 5" },
      { label: "Time", value: "3:04:12" },
    ]);
  });

  it("gives both distances in mi when the runner uses miles (unit conversion)", () => {
    expect(weekStats(summary, "mi")[0]).toEqual({
      label: "Distance",
      value: "19.5",
      unit: "of 23.6 mi",
    });
  });

  it("counts runs instead of 0 of 0 sessions, and shows the distance alone, for a week with nothing planned (no plan)", () => {
    const unplanned = { ...summary, sessionsPlanned: 0, sessionsDone: 0, plannedDistanceM: 0 };
    expect(weekStats(unplanned, "km")).toEqual([
      { label: "Distance", value: "31.4", unit: "km" },
      { label: "Runs", value: "4" },
      { label: "Time", value: "3:04:12" },
    ]);
  });

  it("shows a week without a run as zero, not as missing (paused week)", () => {
    const empty = {
      ...summary,
      runs: 0,
      distanceM: 0,
      durationS: 0,
      sessionsDone: 0,
      paused: true,
    };
    expect(weekStats(empty, "km")).toEqual([
      { label: "Distance", value: "0.0", unit: "of 38.0 km" },
      { label: "Sessions", value: "0", unit: "of 5" },
      { label: "Time", value: "00:00" },
    ]);
  });
});

describe("comingSessionState", () => {
  it("names done, missed and skipped sessions and says nothing for one still to come", () => {
    expect(comingSessionState("done")).toBe("Done");
    expect(comingSessionState("missed")).toBe("Missed");
    expect(comingSessionState("skipped")).toBe("Skipped");
    expect(comingSessionState("planned")).toBeNull();
    expect(comingSessionState("moved")).toBeNull();
  });
});

describe("planLimitLine", () => {
  it("says when the coach writes the review, in the runner's time zone (plan usage limit, time zones)", () => {
    expect(planLimitLine("2026-10-12T13:00:00Z", "Europe/London")).toBe(
      "Your Claude plan's usage limit is reached. The coach writes your weekly review Mon 12 Oct, 14:00.",
    );
    expect(planLimitLine("2026-10-12T13:00:00Z", "America/New_York")).toBe(
      "Your Claude plan's usage limit is reached. The coach writes your weekly review Mon 12 Oct, 09:00.",
    );
  });
});
