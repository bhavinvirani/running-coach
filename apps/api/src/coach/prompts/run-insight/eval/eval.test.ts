import { describe, expect, it } from "vitest";
import { readRunInsightEvalCases } from "../../../run-insight-eval";
import { voiceProblems } from "../../../voice";
import { buildRunInsightFallback, RUN_INSIGHT_FALLBACK_REASONS } from "../fallback";
import { buildRunInsightInput } from "../input";
import { runInsightSchema } from "../schema";

// The run-insight eval: each case is an input and a recorded output, checked for schema validity and
// voice (src/coach/voice.ts). The outputs are written by hand until the owner records live ones with
// `pnpm coach:eval --write` (src/coach/run-insight-eval.ts).

const cases = await readRunInsightEvalCases(import.meta.dirname);

describe("run-insight eval", () => {
  it("has 3 to 5 cases, with and without a plan", () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.length).toBeLessThanOrEqual(5);
    expect(cases.some(({ evalCase }) => evalCase.input.plan === null)).toBe(true);
    expect(cases.some(({ evalCase }) => evalCase.input.plan !== null)).toBe(true);
  });

  describe.each(cases)("$name", ({ evalCase: { input, output } }) => {
    it("recorded output fits the schema and the voice", () => {
      const card = runInsightSchema.parse(output);
      expect(voiceProblems(card, runInsightSchema)).toEqual([]);
    });

    it.each(RUN_INSIGHT_FALLBACK_REASONS)(
      "fallback card for %s fits the schema and the voice",
      (reason) => {
        const card = runInsightSchema.parse(
          buildRunInsightFallback(input.activity, input.settings, reason, input.plan),
        );
        expect(voiceProblems(card, runInsightSchema)).toEqual([]);
      },
    );

    it("input states the numbers in the user's units, the detail level and the plan", () => {
      const message = buildRunInsightInput(input.activity, input.settings, input.plan);
      const unit = input.settings.units === "km" ? " km" : " mi";
      expect(message).toContain(`Detail level: ${input.settings.coachDetail}`);
      expect(message).toContain(unit);
      if (input.plan === null) {
        expect(message).toContain("Plan: none");
        expect(message).not.toContain("Planned that day");
      } else {
        const planned = /^Planned that day: (.+)$/m.exec(message)?.[1];
        const next = /^Next planned session: (.+)$/m.exec(message)?.[1];
        expect(planned).toBeDefined();
        expect(next).toBeDefined();
        if (input.plan.planned.length > 0) expect(planned).toContain(unit);
        else expect(planned).toBe("nothing");
        if (input.plan.next) expect(next).toContain(unit);
        else expect(next).toBe("none");
        expect(message).not.toContain("Plan: none");
      }
      expect(message).not.toMatch(/@|token|key/i);
    });
  });
});
