import {
  BASELINE_WEEKS,
  ENGINE_VERSION,
  generatePlan,
  MAX_PLAN_WEEKS,
  maxWeeklyVolumeM,
  MIN_DAYS_PER_WEEK,
  MIN_PLAN_WEEKS,
  planStartVolume,
  sessionTarget,
  START_VOLUME_FLOOR_M,
} from "@running-coach/engine";
import {
  DISTANCE_METERS,
  type GoalInput,
  type Plan,
  type PlanBaseline,
  planResponseSchema,
  type SaveGoalResponse,
  saveGoalResponseSchema,
  sessionStepsSchema,
} from "@running-coach/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, goal, plan, planSession } from "../../src/db/schema";
import { addDays } from "../../src/lib/local-date";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { createComputedRun, createRunOn, createSession, setSettings, storedSession } from "../seed";

// PUT /api/goal on the real Postgres, with the clock pinned (Date only, timers run) so
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
      ({
        id: _id,
        status: _status,
        activityId: _activityId,
        source: _source,
        title: _title,
        onGarmin: _onGarmin,
        ...session
      }) => session,
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

/** The engine inputs the API measured and stored on the plan. */
async function storedInputs(saved: Plan) {
  const [row] = await db.select({ inputs: plan.inputs }).from(plan).where(eq(plan.id, saved.id));
  if (!row) throw new Error(`Plan ${saved.id} is not stored`);
  return row.inputs;
}

/** One run of `distanceM` on the Sunday of each baseline week, the last 4 days before today. */
async function runWeekly(userId: string, distanceM: number): Promise<void> {
  for (let weeksBack = 1; weeksBack <= BASELINE_WEEKS; weeksBack += 1) {
    await createRunOn(userId, addDays(THIS_WEEK, 6 - 7 * weeksBack), { distanceM });
  }
}

async function vdotSourceOf(agent: Agent, body: GoalInput = { ...halfMarathon, recentTime: null }) {
  return (await savePlan(agent, body)).vdotSource;
}

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

  it.each([
    ["faster than any run: a 5K in 5 minutes", 300],
    ["slower than a walk: a 5K in 4 hours", 4 * 3600],
  ])(
    "returns 400 validation on recentTime.timeS for an entered time %s and saves nothing",
    async (_case, timeS) => {
      const agent = await signedInAgent(app);

      const response = await agent
        .put("/api/goal")
        .send({ ...halfMarathon, recentTime: { distanceKey: "5k", timeS } });

      const problem = expectProblem(response, 400, "validation");
      expect(problem.issues).toEqual([expect.objectContaining({ path: "recentTime.timeS" })]);
      await storedNothing();
    },
  );

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

    it("ignores a race at 25 min/km and a best effort at 1 min/km for a plausible best effort (GPS glitches)", async () => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      // A walk tagged as a race, which would otherwise win over every best effort as a race.
      await createRunOn(userId, addDays(TODAY, -10), {
        eventType: "race",
        distanceM: 5000,
        durationS: 5 * 1500,
      });
      // A GPS jump inside a run, faster than any human.
      await createComputedRun(
        userId,
        { "5k": 300 },
        { startLocal: `${addDays(TODAY, -5)} 08:00:00` },
      );
      const plausible = await createComputedRun(
        userId,
        { "5k": 1500 },
        { startLocal: `${addDays(TODAY, -20)} 08:00:00` },
      );

      // 3 days, so the walk's 5 km in the baseline cannot make 4 days too many.
      expect(
        await vdotSourceOf(agent, { ...halfMarathon, daysPerWeek: 3, recentTime: null }),
      ).toMatchObject({
        origin: "best_effort",
        timeS: 1500,
        activityId: plausible.id,
      });
    });

    it("ignores the best efforts of a run edited since they were computed or turned manual (duplicate or edited activities)", async () => {
      const agent = await signedInAgent(app);
      const userId = await ownerId();
      const kept = await createComputedRun(
        userId,
        { "5k": 1600 },
        { startLocal: `${addDays(TODAY, -30)} 08:00:00` },
      );
      const edited = await createComputedRun(
        userId,
        { "5k": 1300 },
        { startLocal: `${addDays(TODAY, -20)} 08:00:00` },
      );
      // What the sync's upsert does when Garmin changes the run's distance or time.
      await db.update(activity).set({ bestEffortsVersion: null }).where(eq(activity.id, edited.id));
      // The same run entered again by hand: its stored efforts no longer count.
      await createComputedRun(
        userId,
        { "5k": 1300 },
        { startLocal: `${addDays(TODAY, -20)} 08:00:00`, isManual: true },
      );

      expect(await vdotSourceOf(agent)).toMatchObject({
        origin: "best_effort",
        timeS: 1600,
        activityId: kept.id,
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

  it("answers race_too_far for a race further than 52 weeks out and saves nothing (race date change)", async () => {
    const agent = await signedInAgent(app);
    const raceDate = sundayOfWeek(MAX_PLAN_WEEKS + 1);

    const result = await putGoal(agent, { ...halfMarathon, raceDate });

    expect(result).toEqual({
      ok: false,
      conflict: { code: "race_too_far", raceDate, latestRaceDate: sundayOfWeek(MAX_PLAN_WEEKS) },
    });
    await storedNothing();
  });

  it("plans a race exactly 52 weeks out to the race", async () => {
    const agent = await signedInAgent(app);

    const made = await savePlan(agent, { ...halfMarathon, raceDate: sundayOfWeek(MAX_PLAN_WEEKS) });

    expect(made.weeks).toHaveLength(MAX_PLAN_WEEKS);
    expect(made.endDate).toBe(sundayOfWeek(MAX_PLAN_WEEKS));
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

  it("moves a custom 45 min easy workout's distance to the new easy pace from today on, past and skipped ones keeping theirs (regenerating a plan without losing history)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const first = await savePlan(agent, halfMarathon);
    const steps = sessionStepsSchema.parse([
      { kind: "run", zone: "easy", distanceM: null, durationS: 45 * 60 },
    ]);
    const custom = (date: string, status: "planned" | "moved" | "skipped" = "planned") =>
      createSession(userId, null, {
        date,
        status,
        title: "45 min easy",
        steps,
        target: sessionTarget(steps, first.paces),
      });
    const upcoming = await custom(TODAY);
    const moved = await custom(addDays(TODAY, 2), "moved");
    const skipped = await custom(addDays(TODAY, 3), "skipped");
    const past = await custom(addDays(TODAY, -1));

    // A faster 5K: faster easy paces, so 45 minutes cover more ground.
    const second = await savePlan(agent, {
      ...halfMarathon,
      recentTime: { distanceKey: "5k", timeS: 1380 },
    });

    const before = sessionTarget(steps, first.paces);
    const after = sessionTarget(steps, second.paces);
    expect(after.distanceM).toBeGreaterThan(before.distanceM);
    expect(after.durationS).toBe(45 * 60);
    expect((await storedSession(upcoming.id)).target).toEqual(after);
    expect((await storedSession(moved.id)).target).toEqual(after);
    expect((await storedSession(skipped.id)).target).toEqual(before);
    expect((await storedSession(past.id)).target).toEqual(before);
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

  it("builds the baseline from the 4 weeks before this week: manual runs out of the volume and the longest run but in the days since the last run, indoor runs in (indoor runs)", async () => {
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
    // Manual: no distance counts, though it is the longest; the latest is still a day the runner ran.
    await createRunOn(userId, addDays(THIS_WEEK, -10), { distanceM: 40_000, isManual: true });
    await createRunOn(userId, addDays(TODAY, -1), { distanceM: 5000, isManual: true });
    // This week: the longest run, not volume. Five weeks back: nothing.
    await createRunOn(userId, addDays(TODAY, -2), { distanceM: 9000 });
    await createRunOn(userId, addDays(THIS_WEEK, -35), { distanceM: 25_000 });
    const tenK: GoalInput = { ...halfMarathon, distanceKey: "10k", raceDate: sundayOfWeek(12) };

    const made = await savePlan(agent, tenK);

    const baseline: PlanBaseline = {
      weeklyVolumesM: weeksM,
      longestRunM: 18_000,
      daysSinceLastRun: 1,
    };
    const inputs = await storedInputs(made);
    expect(inputs.baseline).toEqual(baseline);
    const start = planStartVolume(inputs);
    if (!start.ok) throw new Error(`Expected a start volume, got ${start.conflict.code}`);
    // Above the floor, so week 1 follows the runner's own volume.
    expect(start.startVolumeM).toBeGreaterThan(START_VOLUME_FLOOR_M["10k"]);
    expect(made.weeks[0]?.distanceM).toBe(start.startVolumeM);
    expect(made.warnings.map((warning) => warning.code)).not.toContain("no_recent_runs");
  });

  it.each([
    ["at 5 km a week on 3 days", 5000, 3],
    // Not even 3 days fit in 11 km, so no fewer days keep to 10% either.
    ["at 10 km a week on 6 days", 10_000, 6],
  ])("lifts week 1 with start_volume_lifted for a runner %s", async (_case, weekM, daysPerWeek) => {
    const agent = await signedInAgent(app);
    await runWeekly(await ownerId(), weekM);

    const made = await savePlan(agent, {
      ...halfMarathon,
      distanceKey: "10k",
      raceDate: sundayOfWeek(12),
      daysPerWeek,
    });

    const start = planStartVolume(await storedInputs(made));
    if (!start.ok) throw new Error(`Expected a start volume, got ${start.conflict.code}`);
    expect(start.startVolumeM).toBeGreaterThan(maxWeeklyVolumeM(weekM));
    expect(made.warnings).toContainEqual({
      code: "start_volume_lifted",
      recentWeeklyM: weekM,
      startVolumeM: start.startVolumeM,
    });
    expect(made.weeks[0]?.distanceM).toBe(start.startVolumeM);
  });

  it("answers too_many_days with the recent and needed volumes for 6 days from a 15 km week and saves nothing", async () => {
    const agent = await signedInAgent(app);
    await runWeekly(await ownerId(), 15_000);

    const result = await putGoal(agent, {
      ...halfMarathon,
      distanceKey: "10k",
      raceDate: sundayOfWeek(12),
      daysPerWeek: 6,
    });

    if (result.ok || result.conflict.code !== "too_many_days") {
      throw new Error(`Expected too_many_days, got ${JSON.stringify(result)}`);
    }
    expect(result.conflict).toMatchObject({ daysPerWeek: 6, recentWeeklyM: 15_000 });
    expect(result.conflict.maxDaysPerWeek).toBeGreaterThanOrEqual(MIN_DAYS_PER_WEEK["10k"]);
    expect(result.conflict.maxDaysPerWeek).toBeLessThan(6);
    expect(result.conflict.neededWeeklyM).toBeGreaterThan(maxWeeklyVolumeM(15_000));
    await storedNothing();
  });
});
