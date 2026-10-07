import { describe, expect, it } from "vitest";
import type { RunInsightOutput } from "./prompts/run-insight/schema";
import { runInsightOutputProblems } from "./run-insight-eval";

// The plan change's rules the eval adds to the voice for run-insight v2's output.

const card = {
  headline: "10.0 km at 5:00 /km, 2.0 km over the planned 8.0 km.",
  whatHappened: "10.0 km in 50:00 against a planned easy 8.0 km.",
  whatItMeans: "2.0 km over the plan adds load.",
  nextStep: "Run Thursday's easy run as written: 8.0 km.",
  caution: "easy_next",
} as const;

function output(adjustment: RunInsightOutput["adjustment"]): RunInsightOutput {
  return { ...card, adjustment };
}

describe("runInsightOutputProblems", () => {
  it("finds nothing in a scale inside 0.5 to 1.1 whose next step names no distance or time", () => {
    const scale = output({
      kind: "scale",
      factor: 0.8,
      nextStep: "Run Thursday's easy run shorter than planned, so the legs recover.",
    });

    expect(runInsightOutputProblems(scale)).toEqual([]);
    expect(
      runInsightOutputProblems(output({ kind: "none", factor: null, nextStep: null })),
    ).toEqual([]);
  });

  it.each([
    ["8.0 km", "Run Thursday's easy run as 6.4 km."],
    ["miles", "Run Thursday's easy run as 4 miles."],
    ["a clock time", "Run Thursday's easy run in 36:00."],
    ["minutes", "Run Thursday easy for 30 minutes."],
  ])("flags a change's next step that names a distance or time (%s)", (_case, nextStep) => {
    expect(runInsightOutputProblems(output({ kind: "scale", factor: 0.8, nextStep }))).toEqual([
      "adjustment.nextStep: names a distance or time",
    ]);
  });

  it("flags a scale without a factor or outside 0.5 to 1.1, and a factor on another kind", () => {
    const nextStep = "Ease Thursday's run.";
    expect(runInsightOutputProblems(output({ kind: "scale", factor: null, nextStep }))).toEqual([
      "adjustment.factor: missing for scale",
    ]);
    expect(runInsightOutputProblems(output({ kind: "scale", factor: 1.3, nextStep }))).toEqual([
      "adjustment.factor: 1.3, outside 0.5 to 1.1",
    ]);
    expect(runInsightOutputProblems(output({ kind: "rest", factor: 0.8, nextStep }))).toEqual([
      "adjustment.factor: set for rest",
    ]);
  });

  it("flags a next step on none and a change without one", () => {
    expect(
      runInsightOutputProblems(output({ kind: "none", factor: null, nextStep: "Rest Thursday." })),
    ).toEqual(["adjustment.nextStep: set for none"]);
    expect(
      runInsightOutputProblems(output({ kind: "easy", factor: null, nextStep: null })),
    ).toEqual(["adjustment.nextStep: missing for easy"]);
  });
});
