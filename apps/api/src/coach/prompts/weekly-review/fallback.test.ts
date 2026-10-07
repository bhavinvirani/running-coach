import { coachFallbackReasonSchema, SESSION_TITLE_MAX } from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { voiceProblems } from "../../voice";
import { buildWeeklyReviewFallback, WEEKLY_REVIEW_FALLBACK_REASONS } from "./fallback";
import type {
  ReviewExtraRun,
  ReviewPlan,
  ReviewPlanSession,
  ReviewWeek,
  ReviewWeekSession,
} from "./input";
import { weeklyReviewSchema } from "./schema";

// The card built without the model: the week's numbers, its missed sessions and extra runs as they are,
// any pause, and the coming week's sessions, never a change.

const km = { units: "km", coachDetail: "standard" } as const;

function session(overrides: Partial<ReviewWeekSession> = {}): ReviewWeekSession {
  return {
    date: "2026-09-29",
    type: "easy",
    title: null,
    status: "done",
    distanceM: 8000,
    durationS: 2700,
    run: { distanceM: 8000, durationS: 2700, avgHr: 141, isIndoor: false },
    ...overrides,
  };
}

function coming(overrides: Partial<ReviewPlanSession> = {}): ReviewPlanSession {
  return {
    label: "s1",
    date: "2026-10-06",
    type: "easy",
    title: null,
    status: "planned",
    distanceM: 8000,
    durationS: 2700,
    changeable: true,
    ...overrides,
  };
}

/** Three of four sessions done, Friday's easy run missed, 30.0 km of 36.0 km planned. */
function week(overrides: Partial<ReviewWeek> = {}): ReviewWeek {
  return {
    weekStart: "2026-09-28",
    sessions: [
      session(),
      session({ date: "2026-10-01", type: "tempo" }),
      session({ date: "2026-10-02", status: "missed", distanceM: 6000, run: null }),
      session({ date: "2026-10-04", type: "long", distanceM: 14_000, durationS: 5040 }),
    ],
    extraRuns: [],
    summary: {
      runs: 3,
      distanceM: 30_000,
      durationS: 10_440,
      sessionsPlanned: 4,
      sessionsDone: 3,
      plannedDistanceM: 36_000,
      paused: false,
    },
    weekBefore: { runs: 4, distanceM: 33_000 },
    pause: null,
    openPause: null,
    ...overrides,
  };
}

function plan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
  return {
    goal: { kind: "race", distanceKey: "half", raceDate: "2026-12-13", targetTimeS: null },
    weekNumber: 7,
    phase: "build",
    weeksToRace: 9,
    sessions: [
      coming(),
      coming({ label: "s2", date: "2026-10-08", type: "intervals", distanceM: 9000 }),
      coming({ label: "s3", date: "2026-10-09", status: "skipped", changeable: false }),
      coming({ label: "s4", date: "2026-10-11", type: "long", distanceM: 17_000 }),
    ],
    changeAllowed: true,
    reason: null,
    ...overrides,
  };
}

const noRuns = {
  runs: 0,
  distanceM: 0,
  durationS: 0,
  sessionsPlanned: 0,
  sessionsDone: 0,
  plannedDistanceM: 0,
  paused: false,
};

describe("buildWeeklyReviewFallback", () => {
  it("has a card for every reason the API stores", () => {
    expect(WEEKLY_REVIEW_FALLBACK_REASONS).toEqual(coachFallbackReasonSchema.options);
  });

  it("heads the card with the sessions done of planned and the distance", () => {
    const card = buildWeeklyReviewFallback(week(), plan(), km, "timeout");

    expect(card.headline).toBe("3 of 4 sessions done, 30.0 km run.");
    expect(card.whatHappened).toMatch(/^3 runs, 30\.0 km in 2:54:00, against 36\.0 km planned\./);
  });

  it("heads the card with the runs and the distance when the week had no session", () => {
    const card = buildWeeklyReviewFallback(
      week({ sessions: [], summary: { ...noRuns, runs: 2, distanceM: 14_000, durationS: 4800 } }),
      null,
      km,
      "refusal",
    );

    expect(card.headline).toBe("2 runs, 14.0 km in 1:20:00.");
  });

  it("keeps a number in the headline of a week with no runs at all", () => {
    const card = buildWeeklyReviewFallback(
      week({ sessions: [], summary: noRuns, weekBefore: null }),
      null,
      km,
      "unavailable",
    );

    expect(card.headline).toBe("No runs in the week of Monday 28 September 2026.");
    expect(card.whatHappened).toBe("No runs this week.");
    expect(voiceProblems(card, weeklyReviewSchema)).toEqual([]);
  });

  it("lists missed sessions and extra runs as they are, never as moved into the coming week (missed and moved sessions)", () => {
    const extra: ReviewExtraRun = {
      date: "2026-10-03",
      distanceM: 5000,
      durationS: 1800,
      avgHr: null,
      isIndoor: true,
    };
    const card = buildWeeklyReviewFallback(
      week({
        sessions: [...week().sessions, session({ date: "2026-10-03", status: "moved", run: null })],
        extraRuns: [extra],
      }),
      plan(),
      km,
      "max_tokens",
    );

    expect(card.whatHappened).toBe(
      "3 runs, 30.0 km in 2:54:00, against 36.0 km planned. Missed: Easy on Friday 2 October 2026, 6.0 km. Runs outside the plan: 5.0 km on Saturday 3 October 2026 (indoor).",
    );
    expect(card.nextWeek).toContain("missed sessions are not made up");
    expect(card.nextWeek).toContain("Coming week: 3 sessions, 34.0 km");
  });

  it("says what the numbers mean without the model: the reason, the share of the planned distance and the week before", () => {
    const card = buildWeeklyReviewFallback(week(), plan(), km, "timeout");

    expect(card.whatItMeans).toBe(
      "No coach review: Claude took too long to answer. These are the week's numbers only. The week's runs came to 83% of the 36.0 km planned. The week before: 4 runs, 33.0 km.",
    );
  });

  it.each([
    ["key_invalid", "Claude rejected your API key. Replace it in Settings."],
    ["request_rejected", "Check billing in the Claude Console."],
    ["timeout", "Claude took too long to answer."],
    ["unavailable", "Claude is not answering right now."],
    ["invalid_output", "No coach review this week."],
  ] as const)(
    "says why there is no review for %s (invalid key, Claude quota or timeout, invalid output)",
    (reason, words) => {
      const card = buildWeeklyReviewFallback(week(), plan(), km, reason);

      expect(card.whatItMeans).toContain(words);
      expect(card.whatItMeans).not.toContain("Try again");
    },
  );

  it("tells the owner to make a new plan token and replace it on the coach service when Claude rejected it (token expiry)", () => {
    const card = buildWeeklyReviewFallback(week(), plan(), km, "plan_auth_failed");

    expect(card.whatItMeans).toContain("claude setup-token");
    expect(card.whatItMeans).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("names the coming week's sessions, distance and long run, leaving skipped sessions out", () => {
    const card = buildWeeklyReviewFallback(week(), plan(), km, "refusal");

    expect(card.nextWeek).toBe(
      "Coming week: 3 sessions, 34.0 km, with the long run of 17.0 km on Sunday 11 October 2026. Run them as planned; missed sessions are not made up. Rest or run easy if anything hurts or you feel unwell.",
    );
  });

  it("names the race when the coming week holds it", () => {
    const card = buildWeeklyReviewFallback(
      week(),
      plan({
        sessions: [
          coming(),
          coming({ label: "s2", date: "2026-10-11", type: "race", distanceM: 21_098 }),
        ],
      }),
      km,
      "refusal",
    );

    expect(card.nextWeek).toContain(
      "Coming week: 2 sessions, 29.1 km, with the race on Sunday 11 October 2026.",
    );
  });

  it("says nothing is planned when the coming week has no session to run", () => {
    const card = buildWeeklyReviewFallback(
      week(),
      plan({ sessions: [coming({ status: "skipped" })] }),
      km,
      "refusal",
    );

    expect(card.nextWeek).toBe(
      "Nothing is planned for the coming week. Rest or run easy if anything hurts or you feel unwell.",
    );
  });

  it("says there is no plan to compare with or follow when the runner has none", () => {
    const card = buildWeeklyReviewFallback(
      week({ sessions: [], summary: { ...noRuns, runs: 3, distanceM: 26_000, durationS: 9400 } }),
      null,
      km,
      "unavailable",
    );

    expect(card.whatItMeans).toContain("There is no plan to compare the week with.");
    expect(card.nextWeek).toBe(
      "There is no plan for the coming week. Keep your runs easy, or set a goal on Plan to get one. Rest or run easy if anything hurts or you feel unwell.",
    );
  });

  it("writes every distance in miles for a runner in miles (unit conversion)", () => {
    const card = buildWeeklyReviewFallback(
      week(),
      plan(),
      { units: "mi", coachDetail: "short" },
      "timeout",
    );

    expect(card.headline).toBe("3 of 4 sessions done, 18.6 mi run.");
    expect(card.whatHappened).toContain("Missed: Easy on Friday 2 October 2026, 3.7 mi.");
    expect(card.nextWeek).toContain(
      "Coming week: 3 sessions, 21.1 mi, with the long run of 10.6 mi",
    );
    expect(JSON.stringify(card)).not.toMatch(/\d km/);
  });

  it.each(["sick", "injured"] as const)(
    "reviews a week paused as %s as paused, with rest and a doctor or physio after it (paused week)",
    (reason) => {
      const card = buildWeeklyReviewFallback(
        week({
          summary: { ...week().summary, paused: true },
          pause: { reason, startDate: "2026-09-26", endDate: "2026-10-01" },
        }),
        plan(),
        km,
        "timeout",
      );

      expect(card.headline).toBe("Paused week: 3 of 4 sessions done, 30.0 km run.");
      expect(card.whatHappened).toContain(
        "from Saturday 26 September 2026 to Thursday 1 October 2026.",
      );
      expect(card.whatItMeans).toContain(
        "The week was paused, so its numbers say little about your fitness.",
      );
      expect(card.whatItMeans).not.toContain("%");
      expect(card.nextWeek).toMatch(
        /Rest or run easy if anything hurts or you feel unwell\. See a doctor or physio if it does not get better\.$/,
      );
    },
  );

  it("tells a runner still paused as sick to rest, not to run the coming week (paused week)", () => {
    const card = buildWeeklyReviewFallback(
      week({
        summary: { ...week().summary, paused: true },
        pause: { reason: "sick", startDate: "2026-10-02", endDate: null },
      }),
      plan(),
      km,
      "unavailable",
    );

    expect(card.whatHappened).toContain(
      "Training has been paused for illness since Friday 2 October 2026.",
    );
    expect(card.nextWeek).toBe(
      "Training has been paused since Friday 2 October 2026. Rest until you feel well, then tap I'm back on Today. See a doctor or physio if it does not get better.",
    );
  });

  it("tells a runner still on a break to tap I'm back when ready, without naming the coming week (paused week)", () => {
    const card = buildWeeklyReviewFallback(
      week({
        summary: { ...week().summary, paused: true },
        pause: { reason: "break", startDate: "2026-10-02", endDate: null },
      }),
      null,
      km,
      "refusal",
    );

    expect(card.nextWeek).toBe(
      "Training has been paused since Friday 2 October 2026. Tap I'm back on Today when you are ready to train. Rest or run easy if anything hurts or you feel unwell.",
    );
  });

  it.each(WEEKLY_REVIEW_FALLBACK_REASONS)(
    "never tells a runner who paused after the week to run the coming week as planned, for %s (illness or injury pause)",
    (reason) => {
      for (const [pauseReason, planIn] of [
        ["sick", plan()],
        ["injured", plan()],
        ["break", plan()],
        ["sick", null],
      ] as const) {
        const card = buildWeeklyReviewFallback(
          week({ openPause: { reason: pauseReason, startDate: "2026-10-05", endDate: null } }),
          planIn,
          km,
          reason,
        );

        expect(JSON.stringify(card)).not.toMatch(/as planned|Run them|Coming week:/);
        expect(card.nextWeek).toBe(
          pauseReason === "break"
            ? "Training has been paused since Monday 5 October 2026. Tap I'm back on Today when you are ready to train. Rest or run easy if anything hurts or you feel unwell."
            : "Training has been paused since Monday 5 October 2026. Rest until you feel well, then tap I'm back on Today. See a doctor or physio if it does not get better.",
        );
        expect(voiceProblems(weeklyReviewSchema.parse(card), weeklyReviewSchema)).toEqual([]);
      }
    },
  );

  it("takes the pause open now over the week's ended one when it says what to do next (illness or injury pause)", () => {
    const card = buildWeeklyReviewFallback(
      week({
        summary: { ...week().summary, paused: true },
        pause: { reason: "break", startDate: "2026-09-26", endDate: "2026-10-01" },
        openPause: { reason: "injured", startDate: "2026-10-05", endDate: null },
      }),
      plan(),
      km,
      "timeout",
    );

    expect(card.whatHappened).toContain(
      "Training was paused for a break from Saturday 26 September 2026 to Thursday 1 October 2026.",
    );
    expect(card.nextWeek).toBe(
      "Training has been paused since Monday 5 October 2026. Rest until you feel well, then tap I'm back on Today. See a doctor or physio if it does not get better.",
    );
  });

  it("stays inside the schema with the longest titles, many missed sessions and many extra runs", () => {
    const title = "x".repeat(SESSION_TITLE_MAX);
    const dates = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
    const card = buildWeeklyReviewFallback(
      week({
        sessions: dates.map((date) => session({ date, title, status: "missed", run: null })),
        extraRuns: dates.map((date) => ({
          date,
          distanceM: 5000,
          durationS: 1800,
          avgHr: null,
          isIndoor: true,
        })),
        pause: { reason: "injured", startDate: "2026-09-27", endDate: "2026-09-30" },
      }),
      plan({
        sessions: dates.map((date, index) =>
          coming({ label: `s${index + 1}`, date, title, type: "long" }),
        ),
      }),
      km,
      "plan_auth_failed",
    );

    expect(weeklyReviewSchema.safeParse(card).success).toBe(true);
    expect(card.whatHappened).toContain(title);
    expect(card.whatHappened).toMatch(/; and \d more\./);
    expect(voiceProblems(card, weeklyReviewSchema)).toEqual([]);
  });

  it.each(WEEKLY_REVIEW_FALLBACK_REASONS)(
    "fits the stored card's schema and the voice for %s",
    (reason) => {
      for (const [weekIn, planIn] of [
        [week(), plan()],
        [week({ sessions: [], summary: noRuns, weekBefore: null }), null],
      ] as const) {
        const card = weeklyReviewSchema.parse(
          buildWeeklyReviewFallback(weekIn, planIn, km, reason),
        );
        expect(voiceProblems(card, weeklyReviewSchema)).toEqual([]);
        expect(card).not.toHaveProperty("changes");
      }
    },
  );
});
