import { describe, expect, it } from "vitest";
import { goalFixture, planFixture } from "@/test/fixtures";
import { goalFacts, goalPaceFacts, goalWeeks, warningSentence } from "./plan-copy";

describe("goalWeeks", () => {
  it("gives the weeks left as the figure and its unit, singular for one", () => {
    expect(goalWeeks(20)).toEqual({ value: "20", unit: "weeks" });
    expect(goalWeeks(12)).toEqual({ value: "12", unit: "weeks" });
    expect(goalWeeks(1)).toEqual({ value: "1", unit: "week" });
    expect(goalWeeks(0)).toEqual({ value: "0", unit: "weeks" });
  });
});

describe("goalFacts", () => {
  it("names the race in full, then its day and the runs a week", () => {
    expect(goalFacts(goalFixture({ distanceKey: "half", raceDate: "2027-02-21" }))).toEqual([
      "Half marathon",
      "Race on 21 Feb 2027",
      "4 runs a week",
    ]);
    expect(goalFacts(goalFixture())).toEqual(["10K", "Race on 25 Oct 2026", "4 runs a week"]);
  });

  it("names a fitness goal and its focus distance, or no distance for any", () => {
    const fitness = goalFixture({
      kind: "fitness",
      raceDate: null,
      targetTimeS: null,
      daysPerWeek: 3,
    });
    expect(goalFacts(fitness)).toEqual(["Fitness", "10K focus", "3 runs a week"]);
    expect(goalFacts({ ...fitness, distanceKey: null })).toEqual(["Fitness", "3 runs a week"]);
  });
});

describe("goalPaceFacts", () => {
  const paces = planFixture().paces;

  it("puts the target beside the race pace and the finish time it means over the race", () => {
    // The race band is 4:54-4:58 /km: 4:56 over 10 km is 49:20.
    expect(goalPaceFacts(goalFixture(), paces, "km")).toEqual([
      "Target 49:00",
      "Race pace 4:54-4:58 /km, about 49:20",
    ]);
  });

  it("shows the time the paces predict next to a target well ahead of it (target time ambitious)", () => {
    const half = goalFixture({ distanceKey: "half", targetTimeS: 6180 });
    const race = { fastSPerKm: 330, slowSPerKm: 336 };
    // 5:33 /km over 21.0975 km is 7025.5 s.
    expect(goalPaceFacts(half, { ...paces, race }, "km")).toEqual([
      "Target 1:43:00",
      "Race pace 5:30-5:36 /km, about 1:57:05",
    ]);
  });

  it("shows only the race pace without a target (no target)", () => {
    expect(goalPaceFacts(goalFixture({ targetTimeS: null }), paces, "km")).toEqual([
      "Race pace 4:54-4:58 /km, about 49:20",
    ]);
  });

  it("times a fitness plan over its shape's distance, 10K when it has none", () => {
    const fitness = goalFixture({ kind: "fitness", raceDate: null, targetTimeS: null });
    expect(goalPaceFacts({ ...fitness, distanceKey: null }, paces, "km")).toEqual([
      "Race pace 4:54-4:58 /km, about 49:20",
    ]);
    // 4:56 /km over 21.0975 km is 6244.9 s.
    expect(goalPaceFacts({ ...fitness, distanceKey: "half" }, paces, "km")).toEqual([
      "Race pace 4:54-4:58 /km, about 1:44:05",
    ]);
  });

  it("gives the race pace per mile and the same finish time (unit conversion)", () => {
    expect(goalPaceFacts(goalFixture(), paces, "mi")).toEqual([
      "Target 49:00",
      "Race pace 7:53-8:00 /mi, about 49:20",
    ]);
  });
});

describe("warningSentence", () => {
  it("says a close race leaves a shorter plan, with both week counts (race date too close)", () => {
    expect(warningSentence({ code: "race_date_close", weeks: 1, minimumWeeks: 12 }, "km", 4)).toBe(
      "The race is 1 week away, under the 12 weeks a plan for it usually takes: this plan is the taper and what fits before it.",
    );
  });

  it("says where a runner with no recent runs starts, in the runner's unit", () => {
    expect(warningSentence({ code: "no_recent_runs", startVolumeM: 16093 }, "km", 4)).toBe(
      "No runs in the last 4 weeks, so the plan starts from 16.1 km a week.",
    );
    expect(warningSentence({ code: "no_recent_runs", startVolumeM: 16093 }, "mi", 4)).toBe(
      "No runs in the last 4 weeks, so the plan starts from 10.0 mi a week.",
    );
  });

  it("says the start volume was lifted to what the runs a week need, in the runner's unit (start volume lifted)", () => {
    const lifted = {
      code: "start_volume_lifted",
      recentWeeklyM: 8000,
      startVolumeM: 13000,
    } as const;
    expect(warningSentence(lifted, "km", 3)).toBe(
      "Your recent 8.0 km a week is under what 3 runs need, so the plan starts at 13.0 km.",
    );
    expect(warningSentence(lifted, "mi", 3)).toBe(
      "Your recent 5.0 mi a week is under what 3 runs need, so the plan starts at 8.1 mi.",
    );
  });

  it("says how far the long run's peak falls short and why", () => {
    expect(
      warningSentence(
        { code: "long_run_short", peakLongRunM: 26000, requiredLongRunM: 32000 },
        "km",
        4,
      ),
    ).toBe(
      "The long run peaks at 26.0 km, under the 32.0 km this race usually asks for, so that each week's increase stays safe.",
    );
  });

  it("says an ambitious target gives way to the predicted time", () => {
    expect(
      warningSentence(
        { code: "target_time_ambitious", targetTimeS: 6300, predictedTimeS: 6750 },
        "km",
        4,
      ),
    ).toBe(
      "Your target of 1:45:00 is well ahead of the 1:52:30 your recent times predict, so the paces follow the prediction.",
    );
  });
});
