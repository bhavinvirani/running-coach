import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { voiceProblems } from "../../../voice";
import { buildRunInsightFallback, RUN_INSIGHT_FALLBACK_REASONS } from "../fallback";
import { buildRunInsightInput, type InsightActivity, type InsightSettings } from "../input";
import { runInsightSchema } from "../schema";

// The run-insight eval: each case is an input and a recorded output, checked for schema validity and
// voice (src/coach/voice.ts). The v1 outputs were written by hand in bootstrap; slice 8 records live runs.

interface EvalCase {
  input: { activity: InsightActivity; settings: InsightSettings };
  output: unknown;
}

const dir = import.meta.dirname;
const cases = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => ({
    name: path.basename(file, ".json"),
    ...(JSON.parse(readFileSync(path.join(dir, file), "utf8")) as EvalCase),
  }));

describe("run-insight eval", () => {
  it("has 3 to 5 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.length).toBeLessThanOrEqual(5);
  });

  describe.each(cases)("$name", ({ input, output }) => {
    it("recorded output fits the schema and the voice", () => {
      const card = runInsightSchema.parse(output);
      expect(voiceProblems(card, runInsightSchema)).toEqual([]);
    });

    it.each(RUN_INSIGHT_FALLBACK_REASONS)(
      "fallback card for %s fits the schema and the voice",
      (reason) => {
        const card = runInsightSchema.parse(
          buildRunInsightFallback(input.activity, input.settings, reason),
        );
        expect(voiceProblems(card, runInsightSchema)).toEqual([]);
      },
    );

    it("input states the numbers in the user's units and the detail level", () => {
      const message = buildRunInsightInput(input.activity, input.settings);
      expect(message).toContain(`Detail level: ${input.settings.coachDetail}`);
      expect(message).toContain(input.settings.units === "km" ? " km" : " mi");
      expect(message).not.toMatch(/@|token|key/i);
    });
  });
});
