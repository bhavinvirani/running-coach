import { describe, expect, it } from "vitest";
import {
  runInsightOutputSchema,
  runInsightSchema,
} from "../../src/coach/prompts/run-insight/schema";
import { weeklyReviewOutputSchema } from "../../src/coach/prompts/weekly-review/schema";
import { namesDistanceOrTime, voiceProblems } from "../../src/coach/voice";

const card = {
  headline: "18.0 km long run at 5:40 /km.",
  whatHappened: "Average heart rate 148 bpm.",
  whatItMeans: "An aerobic long run.",
  nextStep: "Run easy next.",
  caution: "easy_next",
};

describe("voiceProblems", () => {
  it("finds nothing in a plain card with a number", () => {
    expect(voiceProblems(card, runInsightSchema)).toEqual([]);
  });

  it("flags praise openers, emoji and a closing question by field", () => {
    const problems = voiceProblems(
      {
        ...card,
        headline: "Great run! 18.0 km.",
        whatItMeans: "Strong pace 🏃",
        nextStep: "How do your legs feel?",
      },
      runInsightSchema,
    );

    expect(problems).toEqual([
      "headline: praise or hype word",
      "whatItMeans: emoji",
      "nextStep: ends with a question",
    ]);
  });

  it("flags a card without any number", () => {
    const problems = voiceProblems(
      { ...card, headline: "A long run.", whatHappened: "Steady heart rate." },
      runInsightSchema,
    );

    expect(problems).toEqual(["no number in any field"]);
  });

  it("flags a field longer than its schema max", () => {
    const problems = voiceProblems(
      { ...card, headline: `18 ${"x".repeat(120)}` },
      runInsightSchema,
    );

    expect(problems).toEqual(["headline: 123 characters, max 120"]);
  });

  it("checks the nested adjustment's next step like any field, and skips it when null", () => {
    const none = { ...card, adjustment: { kind: "none", factor: null, nextStep: null } };
    expect(voiceProblems(none, runInsightOutputSchema)).toEqual([]);

    const problems = voiceProblems(
      {
        ...card,
        adjustment: { kind: "easy", factor: null, nextStep: `Amazing ${"x".repeat(400)}` },
      },
      runInsightOutputSchema,
    );

    expect(problems).toEqual([
      "adjustment.nextStep: praise or hype word",
      "adjustment.nextStep: 408 characters, max 400",
    ]);
  });

  it("checks every change in a list of objects by its index (weekly-review changes)", () => {
    const review = {
      headline: "3 of 4 sessions done, 32.0 km.",
      whatHappened: "Saturday's easy run was missed.",
      whatItMeans: "84% of the planned distance.",
      nextWeek: "3 sessions and 33.0 km.",
    };
    const change = { session: "s1", kind: "easy", factor: null, note: "Run Thursday easy." };
    expect(voiceProblems({ ...review, changes: [change] }, weeklyReviewOutputSchema)).toEqual([]);

    const problems = voiceProblems(
      {
        ...review,
        changes: [change, { ...change, session: "s2", note: `Well done ${"x".repeat(200)}` }],
      },
      weeklyReviewOutputSchema,
    );

    expect(problems).toEqual([
      "changes[1].note: praise or hype word",
      "changes[1].note: 210 characters, max 200",
    ]);
  });
});

describe("namesDistanceOrTime", () => {
  it.each(["Run it as 6.4 km.", "Run 4 miles.", "Run for 30 minutes.", "Finish in 36:00."])(
    "finds a distance or time in %s",
    (text) => {
      expect(namesDistanceOrTime(text)).toBe(true);
    },
  );

  it("finds none in a day and a reason", () => {
    expect(
      namesDistanceOrTime("Run Thursday's tempo easy, so the legs recover after 3 runs."),
    ).toBe(false);
  });
});
