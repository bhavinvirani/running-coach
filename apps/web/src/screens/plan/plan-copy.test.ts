import { describe, expect, it } from "vitest";
import { goalFixture } from "@/test/fixtures";
import { goalFacts, goalHeadline, paceZoneName, warningSentence } from "./plan-copy";

describe("goalHeadline", () => {
  it("names a race by its distance and a fitness goal as Fitness", () => {
    expect(goalHeadline(goalFixture())).toBe("10K");
    expect(goalHeadline(goalFixture({ distanceKey: "half" }))).toBe("Half");
    expect(goalHeadline(goalFixture({ kind: "fitness", raceDate: null, targetTimeS: null }))).toBe(
      "Fitness",
    );
  });
});

describe("goalFacts", () => {
  it("lists a race's day and target, then the plan's length and the runs a week", () => {
    expect(goalFacts(goalFixture(), 3)).toEqual([
      "Race on 25 Oct 2026",
      "Target 49:00",
      "3 weeks",
      "4 runs a week",
    ]);
  });

  it("leaves out a target time the runner did not set and shows hours past the hour", () => {
    expect(goalFacts(goalFixture({ targetTimeS: null }), 1)).toEqual([
      "Race on 25 Oct 2026",
      "1 week",
      "4 runs a week",
    ]);
    expect(goalFacts(goalFixture({ distanceKey: "half", targetTimeS: 6300 }), 12)[1]).toBe(
      "Target 1:45:00",
    );
  });

  it("names a fitness goal's focus distance, or nothing for any distance", () => {
    const fitness = goalFixture({
      kind: "fitness",
      raceDate: null,
      targetTimeS: null,
      daysPerWeek: 3,
    });
    expect(goalFacts(fitness, 12)).toEqual(["10K focus", "12 weeks", "3 runs a week"]);
    expect(goalFacts({ ...fitness, distanceKey: null }, 12)).toEqual(["12 weeks", "3 runs a week"]);
  });
});

describe("paceZoneName", () => {
  it("names each zone in words", () => {
    expect(paceZoneName("easy")).toBe("Easy");
    expect(paceZoneName("threshold")).toBe("Threshold");
    expect(paceZoneName("repetition")).toBe("Repetition");
  });
});

describe("warningSentence", () => {
  it("says a close race leaves a shorter plan, with both week counts (race date too close)", () => {
    expect(warningSentence({ code: "race_date_close", weeks: 1, minimumWeeks: 12 }, "km")).toBe(
      "The race is 1 week away, under the 12 weeks a plan for it usually takes: this plan is the taper and what fits before it.",
    );
  });

  it("says where a runner with no recent runs starts, in the runner's unit", () => {
    expect(warningSentence({ code: "no_recent_runs", startVolumeM: 16093 }, "km")).toBe(
      "No runs in the last 4 weeks, so the plan starts from 16.1 km a week.",
    );
    expect(warningSentence({ code: "no_recent_runs", startVolumeM: 16093 }, "mi")).toBe(
      "No runs in the last 4 weeks, so the plan starts from 10.0 mi a week.",
    );
  });

  it("says how far the long run's peak falls short and why", () => {
    expect(
      warningSentence(
        { code: "long_run_short", peakLongRunM: 26000, requiredLongRunM: 32000 },
        "km",
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
      ),
    ).toBe(
      "Your target of 1:45:00 is well ahead of the 1:52:30 your recent times predict, so the paces follow the prediction.",
    );
  });
});
