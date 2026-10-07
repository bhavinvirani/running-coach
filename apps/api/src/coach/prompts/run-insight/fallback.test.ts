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

  it("names the next planned session in the next step, with no caution", () => {
    const card = buildRunInsightFallback(run, km, "timeout", { planned: [], next });

    expect(card.caution).toBe("none");
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

  it("tells a user with no plan to run easy or rest, not to follow a plan, and keeps the safety sentence", () => {
    const card = buildRunInsightFallback(run, km, "max_tokens", null);

    expect(card.nextStep).toBe(
      "Keep your next run easy, or take a rest day. Rest or run easy if anything hurts or you feel unwell.",
    );
    expect(card.nextStep).not.toContain("plan");
  });

  it("tells the owner to make a new plan token and replace it on the coach service when Claude rejected it (token expiry)", () => {
    const card = buildRunInsightFallback(run, km, "plan_auth_failed", null);

    expect(card.whatItMeans).toContain("claude setup-token");
    expect(card.whatItMeans).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(card.whatItMeans).toMatch(/Try again\.$/);
    expect(runInsightSchema.parse(card).headline).toBe("8.0 km in 45:00 at 5:38 /km.");
  });

  it.each(["sick", "injured"] as const)(
    "tells a runner paused as %s to rest and see a doctor or physio, never to run the next session (illness or injury pause)",
    (reason) => {
      const card = buildRunInsightFallback(
        run,
        km,
        "timeout",
        { planned: [], next },
        { reason, startDate: "2026-10-05" },
      );

      expect(card.nextStep).toBe(
        "Training has been paused since Monday 5 October 2026. Rest until you feel well, then tap I'm back on Today. See a doctor or physio if it does not get better.",
      );
      expect(card.caution).toBe("rest_and_check");
      expect(card).not.toHaveProperty("adjustment");
    },
  );

  it("tells a runner on a break to tap I'm back when ready, without naming the next session", () => {
    const card = buildRunInsightFallback(run, km, "refusal", null, {
      reason: "break",
      startDate: "2026-10-05",
    });

    expect(card.nextStep).toBe(
      "Training has been paused since Monday 5 October 2026. Tap I'm back on Today when you are ready to train. Rest or run easy if anything hurts or you feel unwell.",
    );
    expect(card.caution).toBe("none");
  });

  it("keeps the follow-the-plan next step when the plan has nothing after this run", () => {
    const card = buildRunInsightFallback(run, km, "max_tokens", { planned: [], next: null });

    expect(card.nextStep).toBe(
      "Follow the plan for your next session. Rest or run easy if anything hurts or you feel unwell.",
    );
  });
});
