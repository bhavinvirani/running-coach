import { describe, expect, it } from "vitest";
import type { WeeklyReviewOutput } from "../schema";
import { weeklyReviewOutputProblems } from "./definition";

// The changes' rules the eval adds to the voice for weekly-review v1's output.

const card = {
  headline: "3 of 4 sessions done, 32.0 km against a planned 38.0 km.",
  whatHappened: "Saturday's easy 6.0 km was missed.",
  whatItMeans: "Heart rate ran high on the easy runs.",
  nextWeek: "3 sessions, 33.0 km, with a 16.0 km long run on Sunday.",
} as const;

const note = "Run Thursday's intervals as an easy run, so the legs recover.";

function output(changes: WeeklyReviewOutput["changes"]): WeeklyReviewOutput {
  return { ...card, changes };
}

describe("weeklyReviewOutputProblems", () => {
  it("finds nothing in no change, or changes on distinct sessions within the rules", () => {
    expect(weeklyReviewOutputProblems(output([]))).toEqual([]);
    expect(
      weeklyReviewOutputProblems(
        output([
          { session: "s2", kind: "easy", factor: null, note },
          { session: "s3", kind: "scale", factor: 0.8, note: "Keep Sunday's long run shorter." },
        ]),
      ),
    ).toEqual([]);
  });

  it.each([
    ["kilometers", "Run Sunday's long run as 12.8 km."],
    ["miles", "Run Sunday's long run as 8 miles."],
    ["a clock time", "Run Sunday's long run in 1:15."],
    ["minutes", "Run Sunday for 70 minutes."],
  ])("flags a note that names a distance or time (%s)", (_case, text) => {
    expect(
      weeklyReviewOutputProblems(
        output([{ session: "s3", kind: "scale", factor: 0.8, note: text }]),
      ),
    ).toEqual(["changes[0].note: names a distance or time"]);
  });

  it("flags a scale without a factor or outside 0.5 to 1.1, and a factor on another kind", () => {
    expect(
      weeklyReviewOutputProblems(output([{ session: "s1", kind: "scale", factor: null, note }])),
    ).toEqual(["changes[0].factor: missing for scale"]);
    expect(
      weeklyReviewOutputProblems(output([{ session: "s1", kind: "scale", factor: 1.3, note }])),
    ).toEqual(["changes[0].factor: 1.3, outside 0.5 to 1.1"]);
    expect(
      weeklyReviewOutputProblems(output([{ session: "s1", kind: "rest", factor: 0.8, note }])),
    ).toEqual(["changes[0].factor: set for rest"]);
  });

  it("flags a second change to the same session", () => {
    expect(
      weeklyReviewOutputProblems(
        output([
          { session: "s2", kind: "easy", factor: null, note },
          { session: "s2", kind: "rest", factor: null, note: "Skip Thursday's run." },
        ]),
      ),
    ).toEqual(["changes[1].session: s2 named twice"]);
  });

  it("checks each note's voice by its index", () => {
    expect(
      weeklyReviewOutputProblems(
        output([{ session: "s2", kind: "easy", factor: null, note: "Great week, run easy." }]),
      ),
    ).toEqual(["changes[0].note: praise or hype word"]);
  });
});
