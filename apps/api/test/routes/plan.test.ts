import {
  ENGINE_VERSION,
  generatePlan,
  MIN_DAYS_PER_WEEK,
  MIN_PLAN_WEEKS,
  START_VOLUME_FLOOR_M,
  startVolume,
} from "@running-coach/engine";
import {
  DISTANCE_METERS,
  type GoalInput,
  type Plan,
  type PlanBaseline,
  planResponseSchema,
  type SaveGoalResponse,
  saveGoalResponseSchema,
} from "@running-coach/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { goal, plan, planSession } from "../../src/db/schema";
import { addDays } from "../../src/lib/local-date";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { createComputedRun, createRunOn, setSettings } from "../seed";

// GET /api/plan and PUT /api/goal on the real Postgres, with the clock pinned (Date only, timers run) so
// "today", the first Monday and the baseline weeks are fixed.

const app = createTestApp();

// A Thursday at noon UTC: the plan starts on Monday 2026-10-05, and the baseline is the 4 weeks before
// the week of Monday 2026-09-28.
const NOW = new Date("2026-10-01T12:00:00Z");
const TODAY = "2026-10-01";
const THIS_WEEK = "2026-09-28";
const START = "2026-10-05";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

type Agent = Awaited<ReturnType<typeof signedInAgent>>;

/** The Sunday that ends the plan's nth week, so a race there makes an n-week plan. */
function sundayOfWeek(weeks: number): string {
  return addDays(START, 7 * weeks - 1);
}

const halfMarathon: GoalInput = {
  kind: "race",
  distanceKey: "half",
  raceDate: sundayOfWeek(20),
  targetTimeS: null,
  daysPerWeek: 4,
  longRunDay: "sun",
  recentTime: { distanceKey: "5k", timeS: 1500 },
};

const fitness: GoalInput = {
  kind: "fitness",
  distanceKey: null,
  raceDate: null,
  targetTimeS: null,
  daysPerWeek: 4,
  longRunDay: "sun",
  recentTime: { distanceKey: "5k", timeS: 1500 },
};

async function putGoal(agent: Agent, body: GoalInput): Promise<SaveGoalResponse> {
  const response = await agent.put("/api/goal").send(body);
  expect(response.status).toBe(200);
  return saveGoalResponseSchema.parse(response.body);
}

async function savePlan(agent: Agent, body: GoalInput): Promise<Plan> {
  const result = await putGoal(agent, body);
  if (!result.ok) throw new Error(`Expected a plan, got the conflict ${result.conflict.code}`);
  return result.plan;
}

async function getPlan(agent: Agent) {
  const response = await agent.get("/api/plan");
  expect(response.status).toBe(200);
  return planResponseSchema.parse(response.body);
}

/** The weeks without row identity or progress, as the engine generates them. */
function generatedWeeks(weeks: Plan["weeks"]) {
  return weeks.map((week) => ({
    ...week,
    sessions: week.sessions.map(
      ({ id: _id, status: _status, activityId: _activityId, ...session }) => session,
    ),
  }));
}

/** The plan without what makes each saved version its own row. */
function content(saved: Plan) {
  const { id: _id, version: _version, status: _status, createdAt: _createdAt, ...rest } = saved;
  return { ...rest, weeks: generatedWeeks(saved.weeks) };
}

async function storedNothing(): Promise<void> {
  expect(await db.select().from(goal)).toEqual([]);
  expect(await db.select().from(plan)).toEqual([]);
  expect(await db.select().from(planSession)).toEqual([]);
}

async function vdotSourceOf(agent: Agent, body: GoalInput = { ...halfMarathon, recentTime: null }) {
  return (await savePlan(agent, body)).vdotSource;
}

describe("GET /api/plan", () => {
  it("returns no goal and no plan before a goal is saved", async () => {
    const agent = await signedInAgent(app);

    expect(await getPlan(agent)).toEqual({ goal: null, plan: null });
  });

  it("returns 401 problem+json without a session", async () => {
    expectProblem(await request(app).get("/api/plan"), 401, "unauthorized");
  });
});

describe("PUT /api/goal", () => {
  it("plans a half marathon 20 weeks out from an entered 5K, the race on race day, and GET returns it", async () => {
    const agent = await signedInAgent(app);

    const result = await putGoal(agent, halfMarathon);

    if (!result.ok) throw new Error(`Expected a plan, got ${result.conflict.code}`);
    const { goal: saved, plan: made } = result;
    expect(saved).toMatchObject(halfMarathon);
    expect(made).toMatchObject({
      version: 1,
      status: "active",
      engineVersion: ENGINE_VERSION,
      startDate: START,
      endDate: halfMarathon.raceDate,
      goalId: saved.id,
      vdotSource: { origin: "entered", distanceM: 5000, timeS: 1500, activityId: null, date: null },
    });
    expect(made.weeks).toHaveLength(20);
    made.weeks.forEach((week, index) => {
      expect(week.number).toBe(index + 1);
      expect(week.startDate).toBe(addDays(START, 7 * index));
      expect(week.distanceM).toBe(week.sessions.reduce((sum, s) => sum + s.target.distanceM, 0));
      for (const session of week.sessions) {
        expect(session.date >= week.startDate && session.date <= addDays(week.startDate, 6)).toBe(
          true,
        );
        expect(session).toMatchObject({ status: "planned", activityId: null });
      }
    });
    const races = made.weeks.flatMap((week) => week.sessions).filter((s) => s.type === "race");
    expect(races.map((race) => race.date)).toEqual([halfMarathon.raceDate]);
    expect(made.weeks.at(-1)?.phase).toBe("race");
    expect(await getPlan(agent)).toEqual({ goal: saved, plan: made });
  });

  it("stores the engine's plan as generated from the inputs it keeps", async () => {
    const agent = await signedInAgent(app);
    const made = await savePlan(agent, halfMarathon);

    const [row] = await db.select().from(plan).where(eq(plan.id, made.id));
    const again = generatePlan(row!.inputs);

    if (!again.ok) throw new Error("The stored inputs no longer make a plan");
    expect(row?.inputs).toMatchObject({ goal: halfMarathon, startDate: START });
    expect(generatedWeeks(made.weeks)).toEqual(again.plan.weeks);
    expect(made).toMatchObject({
      vdot: again.plan.vdot,
      paces: again.plan.paces,
      warnings: again.plan.warnings,
    });
  });

  it("gives identical plans for identical inputs, the second saved as version 2", async () => {
    const agent = await signedInAgent(app);

    const first = await savePlan(agent, halfMarathon);
    const second = await savePlan(agent, halfMarathon);

    expect(second.id).not.toBe(first.id);
    expect(second.version).toBe(2);
    expect(content(second)).toEqual(content(first));
  });

  it("returns 400 validation for a fitness goal with a race date and saves nothing", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.put("/api/goal").send({ ...fitness, raceDate: "2027-01-17" });

    const problem = expectProblem(response, 400, "validation");
    expect(problem.issues).toEqual([expect.objectContaining({ path: "raceDate" })]);
    await storedNothing();
  });

  it("returns 400 validation for an entered time too slow to set paces from and saves nothing", async () => {
    const agent = await signedInAgent(app);

    const response = await agent
      .put("/api/goal")
      .send({ ...halfMarathon, recentTime: { distanceKey: "5k", timeS: 4 * 3600 } });

    const problem = expectProblem(response, 400, "validation");
    expect(problem.issues).toEqual([expect.objectContaining({ path: "recentTime.timeS" })]);
    await storedNothing();
  });

  it("returns 401 problem+json without a session and saves nothing", async () => {
    const response = await request(app).put("/api/goal").send(halfMarathon);

    expectProblem(response, 401, "unauthorized");
    await storedNothing();
  });

  describe("VDOT source", () => {
    it("takes an entered time over a faster recorded race", async () => {
      const agent = await signedInAgent(app);
      await createRunOn(await ownerId(), addDays(TODAY, -20), {
        eventType: "race",
        distanceM: 10_000,
        durationS: 2400,
      });

      expect(await vdotSourceOf(agent, halfMarathon)).toMatchObject({ origin: "entered" });
    });

    it("takes the recorded race with the highest VDOT over a faster best effort", async () => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      const fastest = await createRunOn(userId, addDays(TODAY, -170), {
        eventType: "race",
        distanceM: 10_012.4,
        durationS: 2899.6,
      });
      await createRunOn(userId, addDays(TODAY, -30), {
        eventType: "race",
        distanceM: 5000,
        durationS: 1500,
      });
      await createRunOn(userId, addDays(TODAY, -10), {
        eventType: "race",
        distanceM: 21_100,
        durationS: 1300,
        isManual: true,
      });
      await createComputedRun(
        userId,
        { "5k": 1100 },
        { startLocal: `${addDays(TODAY, -5)} 08:00:00` },
      );

      expect(await vdotSourceOf(agent)).toEqual({
        origin: "race",
        distanceM: 10_012,
        timeS: 2900,
        activityId: fastest.id,
        date: addDays(TODAY, -170),
      });
    });

    it("takes the best effort of 5 km or more with the highest VDOT when there is no race", async () => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      const date = addDays(TODAY, -60);
      const run = await createComputedRun(
        userId,
        { "1mi": 300, "5k": 1500, "10k": 2900.4 },
        { startLocal: `${date} 08:00:00` },
      );
      await createComputedRun(
        userId,
        { "5k": 1450 },
        { startLocal: `${addDays(TODAY, -90)} 08:00:00` },
      );
      await createComputedRun(
        userId,
        { "5k": 1200 },
        { startLocal: `${addDays(TODAY, -3)} 08:00:00`, isIndoor: true, type: "treadmill_running" },
      );

      expect(await vdotSourceOf(agent)).toEqual({
        origin: "best_effort",
        distanceM: DISTANCE_METERS["10k"],
        timeS: 2900,
        activityId: run.id,
        date,
      });
    });

    it("ignores a race older than 180 days", async () => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      await createRunOn(userId, addDays(TODAY, -181), {
        eventType: "race",
        distanceM: 10_000,
        durationS: 2400,
      });
      const recent = await createComputedRun(
        userId,
        { "5k": 1600 },
        { startLocal: `${addDays(TODAY, -7)} 08:00:00` },
      );

      expect(await vdotSourceOf(agent)).toMatchObject({
        origin: "best_effort",
        activityId: recent.id,
      });
    });

    it("answers no_recent_time and saves nothing without an entered time, a race or a best effort", async () => {
      const agent = await signedInAgent(app);
      await createRunOn(await ownerId(), addDays(TODAY, -3));

      const result = await putGoal(agent, { ...halfMarathon, recentTime: null });

      expect(result).toEqual({ ok: false, conflict: { code: "no_recent_time" } });
      await storedNothing();
    });
  });

  it("answers long_run_cap for a marathon on 3 days a week and saves nothing", async () => {
    const agent = await signedInAgent(app);

    const result = await putGoal(agent, {
      ...halfMarathon,
      distanceKey: "marathon",
      daysPerWeek: 3,
    });

    expect(result).toEqual({
      ok: false,
      conflict: {
        code: "long_run_cap",
        distanceKey: "marathon",
        daysPerWeek: 3,
        minDaysPerWeek: MIN_DAYS_PER_WEEK.marathon,
      },
    });
    await storedNothing();
  });

  it("warns race_date_close for a race 4 weeks away and plans those 4 weeks", async () => {
    const agent = await signedInAgent(app);

    const made = await savePlan(agent, { ...halfMarathon, raceDate: sundayOfWeek(4) });

    expect(made.warnings).toContainEqual({
      code: "race_date_close",
      weeks: 4,
      minimumWeeks: MIN_PLAN_WEEKS.half,
    });
    expect(made.weeks).toHaveLength(4);
  });

  it("answers race_too_soon for a race before the plan's first Monday and saves nothing", async () => {
    const agent = await signedInAgent(app);
    const raceDate = addDays(START, -2);

    const result = await putGoal(agent, { ...halfMarathon, raceDate });

    expect(result).toEqual({
      ok: false,
      conflict: { code: "race_too_soon", raceDate, earliestStart: START },
    });
    await storedNothing();
  });

  it("leaves the saved goal and plan as they were when a later save conflicts", async () => {
    const agent = await signedInAgent(app);
    await savePlan(agent, halfMarathon);
    const before = await getPlan(agent);

    const result = await putGoal(agent, {
      ...halfMarathon,
      distanceKey: "marathon",
      daysPerWeek: 3,
    });

    expect(result.ok).toBe(false);
    expect(await getPlan(agent)).toEqual(before);
  });

  it("keeps history on regenerating: the old plan superseded with its sessions and run links", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const first = await savePlan(agent, halfMarathon);
    const done = first.weeks[0]!.sessions[0]!;
    const run = await createRunOn(userId, done.date);
    await db
      .update(planSession)
      .set({ status: "done", activityId: run.id })
      .where(eq(planSession.id, done.id));

    // The race moved a week later (race date change).
    const second = await savePlan(agent, { ...halfMarathon, raceDate: sundayOfWeek(21) });

    expect(second).toMatchObject({ version: 2, status: "active", goalId: first.goalId });
    expect(second.weeks).toHaveLength(21);
    const [old] = await db.select().from(plan).where(eq(plan.id, first.id));
    expect(old?.status).toBe("superseded");
    const oldSessions = await db.select().from(planSession).where(eq(planSession.planId, first.id));
    expect(oldSessions).toHaveLength(first.weeks.flatMap((week) => week.sessions).length);
    expect(oldSessions.find((session) => session.id === done.id)).toMatchObject({
      status: "done",
      activityId: run.id,
    });
    const active = await db
      .select({ id: plan.id })
      .from(plan)
      .where(and(eq(plan.userId, userId), eq(plan.status, "active")));
    expect(active).toEqual([{ id: second.id }]);
    expect(await db.select().from(goal)).toHaveLength(1);
    expect((await getPlan(agent)).plan).toEqual(second);
  });

  it.each([
    // Monday 23:30 UTC is already Tuesday in Auckland, so its Monday has passed.
    [
      "a week later in Pacific/Auckland",
      "Pacific/Auckland",
      "2026-10-05T23:30:00Z",
      "2026-10-05",
      "2026-10-12",
    ],
    // Tuesday 01:00 UTC is still Monday evening in Los Angeles, so the plan starts that day.
    [
      "a week earlier in America/Los_Angeles",
      "America/Los_Angeles",
      "2026-10-06T01:00:00Z",
      "2026-10-12",
      "2026-10-05",
    ],
  ])(
    "takes today in the runner's time zone: the plan starts %s than in UTC (time zones)",
    async (_case, timezone, instant, utcStart, localStart) => {
      vi.setSystemTime(new Date(instant));
      const agent = await signedInAgent(app);
      const userId = await ownerId();

      const inUtc = await savePlan(agent, fitness);
      await setSettings(userId, { timezone });
      const inZone = await savePlan(agent, fitness);

      expect(inUtc.startDate).toBe(utcStart);
      expect(inZone.startDate).toBe(localStart);
    },
  );

  it("builds the baseline from the 4 weeks before this week, manual runs left out and indoor runs in", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const weeksM = [30_000, 34_000, 32_000, 36_000];
    for (const [index, volumeM] of weeksM.entries()) {
      const monday = addDays(THIS_WEEK, -7 * (weeksM.length - index));
      await createRunOn(userId, addDays(monday, 1), { distanceM: 10_000 });
      await createRunOn(userId, addDays(monday, 3), {
        distanceM: 8000,
        type: "treadmill_running",
        isIndoor: true,
      });
      await createRunOn(userId, addDays(monday, 6), { distanceM: volumeM - 18_000 });
    }
    // Manual: no distance or recency counts, though it is the longest and the latest.
    await createRunOn(userId, addDays(THIS_WEEK, -10), { distanceM: 40_000, isManual: true });
    await createRunOn(userId, addDays(TODAY, -1), { distanceM: 5000, isManual: true });
    // This week: recency and the longest run, not volume. Five weeks back: nothing.
    await createRunOn(userId, addDays(TODAY, -2), { distanceM: 9000 });
    await createRunOn(userId, addDays(THIS_WEEK, -35), { distanceM: 25_000 });
    const tenK: GoalInput = { ...halfMarathon, distanceKey: "10k", raceDate: sundayOfWeek(12) };

    const made = await savePlan(agent, tenK);

    const baseline: PlanBaseline = {
      weeklyVolumesM: weeksM,
      longestRunM: 18_000,
      daysSinceLastRun: 2,
    };
    const [row] = await db.select({ inputs: plan.inputs }).from(plan).where(eq(plan.id, made.id));
    expect(row?.inputs.baseline).toEqual(baseline);
    const { startVolumeM } = startVolume({ baseline, distanceKey: "10k" });
    // Above the floor, so week 1 follows the runner's own volume.
    expect(startVolumeM).toBeGreaterThan(START_VOLUME_FLOOR_M["10k"]);
    expect(made.weeks[0]?.distanceM).toBe(startVolumeM);
    expect(made.warnings.map((warning) => warning.code)).not.toContain("no_recent_runs");
  });
});
