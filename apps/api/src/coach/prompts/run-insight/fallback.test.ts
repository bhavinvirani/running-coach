import { coachFallbackReasonSchema, SESSION_TITLE_MAX } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { buildRunInsightFallback, RUN_INSIGHT_FALLBACK_REASONS } from "./fallback";
import type { InsightActivity, InsightSession } from "./input";
import { runInsightSchema } from "./schema";

// The card built without the model: the run's numbers and, when the plan has one, the next session.

const run: InsightActivity = {
  type: "running",
  startLocal: "2026-10-06 07:00:00",
  distanceM: 8000,
  durationS: 2700,
  avgHr: 145,
  maxHr: 160,
  cadence: 170,
  calories: 500,
  elevationGainM: 30,
  isIndoor: false,
  isManual: false,
};
const next: InsightSession = {
  date: "2026-10-08",
  type: "intervals",
  title: null,
  distanceM: 9000,
  durationS: 3000,
};
const km = { units: "km", coachDetail: "standard" } as const;

describe("buildRunInsightFallback", () => {
  it("has a card for every reason the API stores", () => {
    expect(RUN_INSIGHT_FALLBACK_REASONS).toEqual(coachFallbackReasonSchema.options);
  });

  it("names the next planned session in the next step", () => {
    const card = buildRunInsightFallback(run, km, "timeout", { planned: [], next });

    expect(card.nextStep).toBe(
      "Next planned session: Thursday 8 October 2026, Intervals (intervals), 9.0 km, 50:00. Run it as written. Rest or run easy if anything hurts or you feel unwell.",
    );
  });

  it("names the next session in miles for a user in miles", () => {
    const card = buildRunInsightFallback(run, { units: "mi", coachDetail: "short" }, "refusal", {
      planned: [],
      next,
    });

    expect(card.nextStep).toContain("Intervals (intervals), 5.6 mi, 50:00");
  });

  it("stays inside the schema with the longest custom workout title", () => {
    const title = "x".repeat(SESSION_TITLE_MAX);
    const card = buildRunInsightFallback(run, km, "unavailable", {
      planned: [],
      next: { ...next, title },
    });

    expect(runInsightSchema.parse(card).nextStep).toContain(title);
  });

  it.each([
    ["the user has no plan", null],
    ["the plan has nothing after this run", { planned: [], next: null }],
  ])("keeps the generic next step when %s", (_, plan) => {
    const card = buildRunInsightFallback(run, km, "max_tokens", plan);

    expect(card.nextStep).toBe(
      "Follow the plan for your next session. Rest or run easy if anything hurts or you feel unwell.",
    );
  });
});
