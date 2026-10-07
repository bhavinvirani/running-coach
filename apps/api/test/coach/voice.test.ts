import { describe, expect, it } from "vitest";
import {
  runInsightOutputSchema,
  runInsightSchema,
} from "../../src/coach/prompts/run-insight/schema";
import { voiceProblems } from "../../src/coach/voice";

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
});
