import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunInsightFallback } from "../fallback";
import { buildRunInsightInput, type InsightActivity, type InsightSettings } from "../input";
import { type RunInsight, runInsightSchema } from "../schema";

// The run-insight eval: each case is an input and a recorded output, checked for schema validity and
// voice. The v1 outputs were written by hand in bootstrap; slice 8 records live runs.

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

const BANNED = /\b(great|congrat\w*|amazing|awesome|well done)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const TEXT_FIELDS = ["headline", "whatHappened", "whatItMeans", "nextStep"] as const;

function expectVoice(card: RunInsight): void {
  const texts = TEXT_FIELDS.map((field) => card[field]);
  for (const text of texts) {
    expect(text).not.toMatch(BANNED);
    expect(text).not.toMatch(EMOJI);
    expect(text.trim().endsWith("?")).toBe(false);
  }
  expect(texts.join(" ")).toMatch(/\d/);
  for (const field of TEXT_FIELDS) {
    const max = runInsightSchema.shape[field].maxLength;
    expect(max).not.toBeNull();
    expect(card[field].length).toBeLessThanOrEqual(max ?? 0);
  }
}

describe("run-insight eval", () => {
  it("has 3 to 5 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(cases.length).toBeLessThanOrEqual(5);
  });

  describe.each(cases)("$name", ({ input, output }) => {
    it("recorded output fits the schema and the voice", () => {
      const card = runInsightSchema.parse(output);
      expectVoice(card);
    });

    it("fallback card fits the schema and the voice for every reason", () => {
      for (const reason of ["missing_key", "refusal", "timeout", "key_invalid"] as const) {
        const card = runInsightSchema.parse(
          buildRunInsightFallback(input.activity, input.settings, reason),
        );
        expectVoice(card);
      }
    });

    it("input states the numbers in the user's units and the detail level", () => {
      const message = buildRunInsightInput(input.activity, input.settings);
      expect(message).toContain(`Detail level: ${input.settings.coachDetail}`);
      expect(message).toContain(input.settings.units === "km" ? " km" : " mi");
      expect(message).not.toMatch(/@|token|key/i);
    });
  });
});
