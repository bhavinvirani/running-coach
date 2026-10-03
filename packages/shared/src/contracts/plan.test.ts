import { describe, expect, it } from "vitest";
import {
  generatedPlanSchema,
  paceBandSchema,
  planConflictSchema,
  planGenerationInputSchema,
  planGenerationResultSchema,
  planResponseSchema,
  saveGoalResponseSchema,
  sessionStepsSchema,
  stepSchema,
} from "./plan";

const band = { fastSPerKm: 255, slowSPerKm: 270 };
const paces = {
  easy: { fastSPerKm: 317, slowSPerKm: 350 },
  marathon: band,
  threshold: { fastSPerKm: 250, slowSPerKm: 260 },
  interval: { fastSPerKm: 230, slowSPerKm: 240 },
  repetition: { fastSPerKm: 215, slowSPerKm: 225 },
  race: { fastSPerKm: 262, slowSPerKm: 266 },
};

const goal = {
  kind: "race",
  distanceKey: "half",
  raceDate: "2027-01-10",
  targetTimeS: null,
  daysPerWeek: 4,
  longRunDay: "sun",
  recentTime: null,
};

const vdotSource = {
  origin: "race",
  distanceM: 10000,
  timeS: 2680,
  activityId: "8f0c8a52-3d8e-4a77-9a39-6c1f1b0e2a11",
  date: "2026-09-06",
};

const generatedSession = {
  date: "2026-10-06",
  type: "intervals",
  target: { distanceM: 9000, durationS: 2940, zone: "interval" },
  steps: [
    { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
    {
      repeat: 5,
      steps: [
        { kind: "work", zone: "interval", distanceM: 1000, durationS: null },
        { kind: "recovery", zone: "easy", distanceM: null, durationS: 180 },
      ],
    },
    { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
  ],
};

const generatedPlan = {
  engineVersion: "0.2.0",
  startDate: "2026-10-05",
  endDate: "2027-01-10",
  vdot: 41.3,
  paces,
  warnings: [
    { code: "race_date_close", weeks: 10, minimumWeeks: 12 },
    { code: "start_volume_lifted", recentWeeklyM: 8000, startVolumeM: 13000 },
  ],
  weeks: [
    {
      number: 1,
      startDate: "2026-10-05",
      phase: "base",
      distanceM: 32000,
      sessions: [generatedSession],
    },
  ],
};

const planWeek = {
  number: 1,
  startDate: "2026-10-05",
  phase: "base",
  distanceM: 32000,
  sessions: [
    {
      ...generatedSession,
      id: "4d3a8a3c-2f8e-4c6d-9c2a-8d9c4a2e3f44",
      status: "planned",
      source: "plan",
      title: null,
      activityId: null,
      onGarmin: false,
    },
  ],
};

const planRow = {
  id: "2b1f6e1a-0d6c-4a4b-9a0e-6b7a2e0c1d22",
  goalId: "3c2f7f2b-1e7d-4b5c-8b1f-7c8b3f1d2e33",
  version: 2,
  status: "active",
  vdotSource,
  createdAt: "2026-10-02T08:00:00Z",
  ...generatedPlan,
  weeks: [planWeek],
};

const goalRow = {
  ...goal,
  id: "3c2f7f2b-1e7d-4b5c-8b1f-7c8b3f1d2e33",
  updatedAt: "2026-10-02T08:00:00Z",
};

describe("paceBandSchema", () => {
  it("accepts a band whose fast end is the faster pace, and a single-pace band", () => {
    expect(paceBandSchema.safeParse(band).success).toBe(true);
    expect(paceBandSchema.safeParse({ fastSPerKm: 255, slowSPerKm: 255 }).success).toBe(true);
  });

  it("rejects a band whose fast end is slower than its slow end", () => {
    expect(paceBandSchema.safeParse({ fastSPerKm: 271, slowSPerKm: 270 }).success).toBe(false);
  });
});

describe("stepSchema", () => {
  it("takes a step by distance or by time, never both or neither", () => {
    expect(
      stepSchema.safeParse({ kind: "work", zone: "threshold", distanceM: 3000, durationS: null })
        .success,
    ).toBe(true);
    expect(
      stepSchema.safeParse({ kind: "warmup", zone: "easy", distanceM: null, durationS: 900 })
        .success,
    ).toBe(true);
    expect(
      stepSchema.safeParse({ kind: "work", zone: "threshold", distanceM: 3000, durationS: 780 })
        .success,
    ).toBe(false);
    expect(
      stepSchema.safeParse({ kind: "work", zone: "threshold", distanceM: null, durationS: null })
        .success,
    ).toBe(false);
  });

  it("rejects a pace on a step, which comes from the plan's bands", () => {
    expect(
      stepSchema.safeParse({
        kind: "work",
        zone: "threshold",
        distanceM: 3000,
        durationS: null,
        paceSPerKm: 255,
      }).success,
    ).toBe(false);
  });
});

describe("sessionStepsSchema", () => {
  it("accepts repeats among plain steps and needs at least two repetitions", () => {
    expect(sessionStepsSchema.safeParse(generatedSession.steps).success).toBe(true);
    expect(
      sessionStepsSchema.safeParse([
        { repeat: 1, steps: [{ kind: "work", zone: "interval", distanceM: 400, durationS: null }] },
      ]).success,
    ).toBe(false);
  });
});

describe("planGenerationInputSchema", () => {
  const input = {
    goal,
    startDate: "2026-10-05",
    baseline: {
      weeklyVolumesM: [20000, 22000, 18000, 24000],
      longestRunM: 12000,
      daysSinceLastRun: 2,
    },
    vdotSource,
  };

  it("accepts a Monday start with a baseline and a source", () => {
    expect(planGenerationInputSchema.safeParse(input).success).toBe(true);
  });

  it("accepts a runner with no history: zero weeks, no last run, no source", () => {
    const parsed = planGenerationInputSchema.safeParse({
      ...input,
      baseline: { weeklyVolumesM: [0, 0, 0, 0], longestRunM: 0, daysSinceLastRun: null },
      vdotSource: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a start that is not a Monday and a baseline that is not four weeks", () => {
    expect(planGenerationInputSchema.safeParse({ ...input, startDate: "2026-10-06" }).success).toBe(
      false,
    );
    expect(
      planGenerationInputSchema.safeParse({
        ...input,
        baseline: { ...input.baseline, weeklyVolumesM: [20000, 22000, 18000] },
      }).success,
    ).toBe(false);
  });
});

describe("planGenerationResultSchema", () => {
  it("accepts a generated plan", () => {
    expect(planGenerationResultSchema.safeParse({ ok: true, plan: generatedPlan }).success).toBe(
      true,
    );
    expect(generatedPlanSchema.safeParse({ ...generatedPlan, weeks: [] }).success).toBe(false);
  });

  it("accepts each conflict with its numbers", () => {
    const conflicts = [
      { code: "long_run_cap", distanceKey: "marathon", daysPerWeek: 3, minDaysPerWeek: 4 },
      {
        code: "too_many_days",
        daysPerWeek: 6,
        maxDaysPerWeek: 3,
        recentWeeklyM: 9000,
        neededWeeklyM: 22000,
      },
      { code: "race_too_far", raceDate: "2028-10-01", latestRaceDate: "2027-10-03" },
      { code: "race_too_soon", raceDate: "2026-10-04", earliestStart: "2026-10-05" },
      { code: "no_recent_time" },
    ];
    for (const conflict of conflicts) {
      expect(planConflictSchema.safeParse(conflict).success).toBe(true);
      expect(planGenerationResultSchema.safeParse({ ok: false, conflict }).success).toBe(true);
    }
  });

  it("rejects a plan beside a conflict and a conflict the app does not know", () => {
    expect(
      planGenerationResultSchema.safeParse({
        ok: false,
        conflict: { code: "no_recent_time" },
        plan: generatedPlan,
      }).success,
    ).toBe(false);
    expect(planConflictSchema.safeParse({ code: "too_hard" }).success).toBe(false);
  });
});

describe("planResponseSchema", () => {
  it("accepts no goal yet", () => {
    expect(planResponseSchema.safeParse({ goal: null, plan: null }).success).toBe(true);
  });

  it("accepts a goal with its active plan", () => {
    expect(planResponseSchema.safeParse({ goal: goalRow, plan: planRow }).success).toBe(true);
  });

  it("rejects a session without a status or a week without a phase", () => {
    const sessions = planWeek.sessions.map(({ status: _status, ...rest }) => rest);
    expect(
      planResponseSchema.safeParse({
        goal: goalRow,
        plan: { ...planRow, weeks: [{ ...planWeek, sessions }] },
      }).success,
    ).toBe(false);
    const { phase: _phase, ...weekWithoutPhase } = planWeek;
    expect(
      planResponseSchema.safeParse({
        goal: goalRow,
        plan: { ...planRow, weeks: [weekWithoutPhase] },
      }).success,
    ).toBe(false);
  });
});

describe("saveGoalResponseSchema", () => {
  it("accepts the saved goal with its plan, or the conflict alone", () => {
    expect(
      saveGoalResponseSchema.safeParse({ ok: true, goal: goalRow, plan: planRow }).success,
    ).toBe(true);
    expect(
      saveGoalResponseSchema.safeParse({ ok: false, conflict: { code: "no_recent_time" } }).success,
    ).toBe(true);
    expect(saveGoalResponseSchema.safeParse({ ok: true, goal: goalRow, plan: null }).success).toBe(
      false,
    );
  });
});
