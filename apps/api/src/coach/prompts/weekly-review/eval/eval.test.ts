import { describe, expect, it } from "vitest";
import { readEvalCases } from "../../../eval";
import { voiceProblems } from "../../../voice";
import { buildWeeklyReviewFallback, WEEKLY_REVIEW_FALLBACK_REASONS } from "../fallback";
import { buildWeeklyReviewInput } from "../input";
import { weeklyReviewOutputSchema, weeklyReviewSchema } from "../schema";
import { type WeeklyReviewEvalInput, weeklyReviewOutputProblems } from "./definition";

// The weekly-review v1 eval: each case is an input and a recorded output, checked for schema validity,
// voice (src/coach/voice.ts), the changes' rules (weeklyReviewOutputProblems) and the rules that depend
// on the input. The outputs are the recorded live v1 run on the Claude plan (`pnpm coach:eval --prompt
// weekly-review --plan --write`, src/coach/eval.ts with definition.ts).

const cases = await readEvalCases<WeeklyReviewEvalInput>(import.meta.dirname);

describe("weekly-review eval", () => {
  it("has 3 to 5 cases: with and without a plan, a paused week, a missed session, and a change proposed", () => {
    const inputs = cases.map(({ evalCase }) => evalCase.input);
    const outputs = cases.map(({ evalCase }) => weeklyReviewOutputSchema.parse(evalCase.output));
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.length).toBeLessThanOrEqual(5);
    expect(inputs.some((input) => input.plan === null)).toBe(true);
    expect(inputs.some((input) => input.plan !== null)).toBe(true);
    expect(inputs.some((input) => input.week.summary.paused)).toBe(true);
    expect(
      inputs.some((input) => input.week.sessions.some((session) => session.status === "missed")),
    ).toBe(true);
    expect(outputs.some((output) => output.changes.length > 0)).toBe(true);
  });

  describe.each(cases)("$name", ({ evalCase: { input, output } }) => {
    it("recorded output fits the schema, the voice and the changes' rules", () => {
      const parsed = weeklyReviewOutputSchema.parse(output);
      expect(weeklyReviewOutputProblems(parsed)).toEqual([]);
    });

    it("proposes changes only when allowed, only to sessions that may change, and no rise after a paused week", () => {
      const { changes } = weeklyReviewOutputSchema.parse(output);
      const { plan, week } = input;
      if (plan === null || !plan.changeAllowed) expect(changes).toEqual([]);
      const changeable = new Set(
        (plan?.sessions ?? []).filter((session) => session.changeable).map(({ label }) => label),
      );
      for (const change of changes) expect(changeable.has(change.session)).toBe(true);
      if (week.summary.paused) {
        for (const change of changes) {
          if (change.kind === "scale") expect(change.factor).toBeLessThanOrEqual(1);
        }
      }
    });

    it.each(WEEKLY_REVIEW_FALLBACK_REASONS)(
      "fallback card for %s fits the card's schema and the voice",
      (reason) => {
        const card = weeklyReviewSchema.parse(
          buildWeeklyReviewFallback(input.week, input.plan, input.settings, reason),
        );
        expect(voiceProblems(card, weeklyReviewSchema)).toEqual([]);
      },
    );

    it("input states the units, the detail level and the plan, and no key, token or email", () => {
      const message = buildWeeklyReviewInput(input.week, input.plan, input.settings);
      expect(message).toContain(`Detail level: ${input.settings.coachDetail}`);
      expect(message).toContain(input.settings.units === "km" ? " km" : " mi");
      expect(message.includes("Plan: none")).toBe(input.plan === null);
      expect(message).not.toMatch(/@|token|key/i);
    });
  });
});
