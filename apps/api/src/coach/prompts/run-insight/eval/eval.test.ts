import { describe, expect, it } from "vitest";
import { readRunInsightEvalCases, runInsightOutputProblems } from "../../../run-insight-eval";
import { voiceProblems } from "../../../voice";
import { buildRunInsightFallback, RUN_INSIGHT_FALLBACK_REASONS } from "../fallback";
import { buildRunInsightInput } from "../input";
import { runInsightOutputSchema, runInsightSchema } from "../schema";

// The run-insight v2 eval: each case is an input and a recorded output, checked for schema validity,
// voice (src/coach/voice.ts) and the plan change's rules (runInsightOutputProblems). The outputs are
// the recorded live v2 run on the Claude plan (`pnpm coach:eval --plan --write`,
// src/coach/run-insight-eval.ts).

const cases = await readRunInsightEvalCases(import.meta.dirname);

describe("run-insight eval", () => {
  it("has 3 to 5 cases: with and without a plan, a change allowed and proposed, a change not allowed", () => {
    const inputs = cases.map(({ evalCase }) => evalCase.input);
    const outputs = cases.map(({ evalCase }) => runInsightOutputSchema.parse(evalCase.output));
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.length).toBeLessThanOrEqual(5);
    expect(inputs.some((input) => input.plan === null)).toBe(true);
    expect(inputs.some((input) => input.plan !== null)).toBe(true);
    expect(
      inputs.some(
        (input, index) =>
          input.context.planChange.allowed && outputs[index]?.adjustment.kind !== "none",
      ),
    ).toBe(true);
    expect(inputs.some((input) => !input.context.planChange.allowed)).toBe(true);
  });

  describe.each(cases)("$name", ({ evalCase: { input, output } }) => {
    it("recorded output fits the schema, the voice and the plan change's rules", () => {
      const parsed = runInsightOutputSchema.parse(output);
      expect(runInsightOutputProblems(parsed)).toEqual([]);
    });

    it("proposes no change when the input does not allow one", () => {
      const parsed = runInsightOutputSchema.parse(output);
      if (!input.context.planChange.allowed) expect(parsed.adjustment.kind).toBe("none");
    });

    it.each(RUN_INSIGHT_FALLBACK_REASONS)(
      "fallback card for %s fits the stored card's schema and the voice, without a change, rest_and_check only during a pause for illness or injury",
      (reason) => {
        const card = runInsightSchema.parse(
          buildRunInsightFallback(
            input.activity,
            input.settings,
            reason,
            input.plan,
            input.context.pause,
          ),
        );
        expect(voiceProblems(card, runInsightSchema)).toEqual([]);
        const { pause } = input.context;
        expect(card.caution).toBe(
          pause !== null && pause.reason !== "break" ? "rest_and_check" : "none",
        );
      },
    );

    it("input states the numbers in the user's units, the detail level, the plan and the change rule", () => {
      const message = buildRunInsightInput(
        input.activity,
        input.settings,
        input.plan,
        input.context,
      );
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
      expect(message).toMatch(/^Previous run: .+$/m);
      expect(message.includes("Training pause: ")).toBe(input.context.pause !== null);
      expect(message).toMatch(
        input.context.planChange.allowed
          ? /^Plan change for the next session: allowed$/m
          : /^Plan change for the next session: not allowed \(.+\)$/m,
      );
      expect(message).not.toMatch(/@|token|key/i);
    });
  });
});
