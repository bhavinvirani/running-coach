import { WALK_RUN_TITLE } from "@running-coach/engine";
import {
  endPauseResponseSchema,
  type GoalInput,
  pauseResponseSchema,
  planResponseSchema,
} from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { trainingPause } from "../../src/db/schema";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { endPause, startPause } from "../../src/services/pause";
import { browserAgent, createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import {
  connectGarmin,
  createPause,
  createPlan,
  createRunOn,
  createSession,
  createUser,
  PLAN_INPUTS,
  setSettings,
  storedAdjustments,
  storedSession,
  TEMPO_STEPS,
} from "../seed";

// /api/pause on the real Postgres ("Not feeling 100%", slice 9). Routes run on a pinned clock (Date only,
// timers run) where "today" matters; "I'm back" and its re-entry are tested through the service with a
// pinned instant: Wednesday 2026-10-14, the runner in UTC, an easy 8 km planned today and on Friday. pg-boss
// runs without workers, so a push a change queues stays queued.

const app = createTestApp();

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.useRealTimers();
});

function clockAt(now: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}

const NOW = new Date("2026-10-14T10:00:00Z");
const TODAY = "2026-10-14";
const FRIDAY = "2026-10-16";
const PLANNED_M = 8000;

/** A client without a session cookie. */
function signedOut() {
  return browserAgent(app);
}

async function storedPauses(userId: string) {
  return db.select().from(trainingPause).where(eq(trainingPause.userId, userId));
}

async function pushJobs(userId: string) {
  return getBoss().findJobs(pushQueue.name, { key: userId });
}

describe("GET /api/pause", () => {
  it("returns null while training runs", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.get("/api/pause");

    expect(response.status).toBe(200);
    expect(pauseResponseSchema.parse(response.body)).toEqual({ pause: null });
  });

  it("returns the open pause and not an ended one", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await createPause(userId, { startedOn: "2026-09-01", endedOn: "2026-09-05", reason: "break" });
    const open = await createPause(userId, { startedOn: "2026-10-12", reason: "injured" });

    const response = await agent.get("/api/pause");

    expect(pauseResponseSchema.parse(response.body)).toEqual({
      pause: {
        id: open.id,
        reason: "injured",
        startDate: "2026-10-12",
        createdAt: open.createdAt.toISOString(),
      },
    });
  });

  it("returns 401 without a session", async () => {
    expectProblem(await signedOut().get("/api/pause"), 401, "unauthorized");
  });
});

describe("POST /api/pause", () => {
  it("starts a pause on the runner's today in their time zone, not the UTC date (time zones and DST)", async () => {
    clockAt(new Date("2026-10-14T23:30:00Z"));
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await setSettings(userId, { timezone: "Asia/Tokyo" });

    const response = await agent.post("/api/pause").send({ reason: "sick" });

    expect(response.status).toBe(200);
    const { pause } = pauseResponseSchema.parse(response.body);
    expect(pause).toMatchObject({ reason: "sick", startDate: "2026-10-15" });
    expect(await storedPauses(userId)).toEqual([
      expect.objectContaining({ id: pause!.id, startedOn: "2026-10-15", endedOn: null }),
    ]);
  });

  it("answers the open pause unchanged on a second tap, whatever its reason (double tap)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const first = pauseResponseSchema.parse(
      (await agent.post("/api/pause").send({ reason: "injured" })).body,
    );

    const second = await agent.post("/api/pause").send({ reason: "break" });

    expect(second.status).toBe(200);
    expect(pauseResponseSchema.parse(second.body)).toEqual(first);
    expect(await storedPauses(userId)).toHaveLength(1);
  });

  it("returns 400 validation and stores nothing for an unknown reason or a missing one", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();

    expectProblem(await agent.post("/api/pause").send({ reason: "tired" }), 400, "validation");
    expectProblem(await agent.post("/api/pause").send({}), 400, "validation");

    expect(await storedPauses(userId)).toEqual([]);
  });

  it("returns 401 without a session", async () => {
    expectProblem(
      await signedOut().post("/api/pause").send({ reason: "sick" }),
      401,
      "unauthorized",
    );
  });

  it("queues a workout push, which takes the paused sessions off the watch, and none on a second tap", async () => {
    const userId = await createUser();
    await connectGarmin(userId);

    await startPause(userId, "sick");
    await startPause(userId, "sick");

    expect(await pushJobs(userId)).toHaveLength(1);
  });
});

/** The runner in UTC with an active plan made before any of the runs, an easy 8 km today and on Friday. */
async function pausedRunner({
  lastRun,
  startedOn,
  reason = "break",
}: {
  lastRun: string | null;
  startedOn: string;
  reason?: "sick" | "injured" | "break";
}) {
  const userId = await createUser();
  if (lastRun !== null) await createRunOn(userId, lastRun);
  const active = await createPlan(userId, { createdAt: new Date("2026-09-01T00:00:00Z") });
  const today = await createSession(userId, active.id, { date: TODAY });
  const friday = await createSession(userId, active.id, { date: FRIDAY });
  const pause = await createPause(userId, { startedOn, reason });
  return { userId, planId: active.id, today, friday, pause };
}

describe("POST /api/pause/end", () => {
  it("answers reEntry null and changes nothing when no pause is open (double I'm back)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();

    const response = await agent.post("/api/pause/end");

    expect(response.status).toBe(200);
    expect(endPauseResponseSchema.parse(response.body)).toEqual({ pause: null, reEntry: null });
    expect(await storedAdjustments(userId)).toEqual([]);
  });

  it("ends the open pause today and answers how the plan restarts", async () => {
    clockAt(NOW);
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await createRunOn(userId, "2026-10-11");
    const pause = await createPause(userId, { startedOn: "2026-10-12", reason: "break" });

    const response = await agent.post("/api/pause/end");

    expect(endPauseResponseSchema.parse(response.body)).toEqual({
      pause: null,
      reEntry: { daysOff: 3, factor: 1, walkRun: false, fromDate: TODAY, sessionsChanged: 0 },
    });
    expect(await storedPauses(userId)).toEqual([
      expect.objectContaining({ id: pause.id, endedOn: TODAY }),
    ]);
    expect(pauseResponseSchema.parse((await agent.get("/api/pause")).body)).toEqual({
      pause: null,
    });
  });

  it("returns 401 without a session", async () => {
    expectProblem(await signedOut().post("/api/pause/end"), 401, "unauthorized");
  });

  it("skips the sessions left in the pause, custom ones too, never rescheduled, and logs each as a rest", async () => {
    const { userId, planId, pause } = await pausedRunner({
      lastRun: "2026-10-11",
      startedOn: "2026-10-12",
    });
    const before = await createSession(userId, planId, { date: "2026-10-11" });
    const monday = await createSession(userId, planId, { date: "2026-10-12" });
    const moved = await createSession(userId, planId, { date: "2026-10-13", status: "moved" });
    const custom = await createSession(userId, null, { date: "2026-10-13", title: "Strides" });

    await endPause(userId, NOW);

    for (const session of [monday, moved, custom]) {
      expect(await storedSession(session.id)).toMatchObject({
        date: session.date,
        status: "skipped",
      });
    }
    expect((await storedSession(before.id)).status).toBe("done");
    const rows = await storedAdjustments(userId);
    expect(rows.map((row) => row.planSessionId).toSorted()).toEqual(
      [monday.id, moved.id, custom.id].toSorted(),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        source: "pause",
        kind: "rest",
        outcome: "applied",
        pauseId: pause.id,
        activityId: null,
        after: { status: "skipped" },
      });
    }
  });

  it("marks the session of a run during the pause done, and skips the others (run during a pause)", async () => {
    const { userId, planId } = await pausedRunner({ lastRun: null, startedOn: "2026-10-12" });
    const monday = await createSession(userId, planId, { date: "2026-10-12" });
    const tuesday = await createSession(userId, planId, { date: "2026-10-13" });
    const run = await createRunOn(userId, "2026-10-13");

    const { reEntry } = await endPause(userId, NOW);

    expect(await storedSession(tuesday.id)).toMatchObject({ status: "done", activityId: run.id });
    expect((await storedSession(monday.id)).status).toBe("skipped");
    expect(reEntry?.daysOff).toBe(1);
  });

  it.each([
    [6, 1, "2026-10-08"],
    [7, 0.7, "2026-10-07"],
    [13, 0.7, "2026-10-01"],
    [14, 0.5, "2026-09-30"],
  ])(
    "after a %i-day break eases the first week back to %d of plan, logged against the pause",
    async (daysOff, factor, lastRun) => {
      const { userId, today, friday, pause } = await pausedRunner({
        lastRun,
        startedOn: "2026-10-12",
      });

      const { reEntry } = await endPause(userId, NOW);

      const eased = Math.round(PLANNED_M * factor);
      expect(reEntry).toEqual({
        daysOff,
        factor,
        walkRun: false,
        fromDate: TODAY,
        sessionsChanged: factor === 1 ? 0 : 2,
      });
      expect((await storedSession(today.id)).target.distanceM).toBe(eased);
      expect((await storedSession(friday.id)).target.distanceM).toBe(eased);
      const rows = (await storedAdjustments(userId)).filter((row) => row.kind === "re_entry");
      expect(rows).toHaveLength(factor === 1 ? 0 : 2);
      for (const row of rows) {
        expect(row).toMatchObject({
          source: "pause",
          outcome: "applied",
          pauseId: pause.id,
          requested: { factor, walkRun: false, daysOff },
          applied: { factor, walkRun: false, daysOff },
        });
      }
    },
  );

  it("makes the first 7 days back walk-run with no quality after illness or injury, and the days after as planned (illness or injury pause)", async () => {
    const { userId, planId, today, friday } = await pausedRunner({
      lastRun: "2026-10-11",
      startedOn: "2026-10-12",
      reason: "injured",
    });
    const tempo = await createSession(userId, planId, {
      date: "2026-10-15",
      type: "tempo",
      steps: TEMPO_STEPS,
    });
    const nextWeek = await createSession(userId, planId, { date: "2026-10-21" });

    const { reEntry } = await endPause(userId, NOW);

    expect(reEntry).toMatchObject({ daysOff: 3, factor: 1, walkRun: true, sessionsChanged: 3 });
    for (const session of [today, tempo, friday]) {
      const stored = await storedSession(session.id);
      expect(stored).toMatchObject({ type: "easy", title: WALK_RUN_TITLE, status: "planned" });
      expect(stored.steps).toHaveLength(1);
      expect("repeat" in stored.steps[0]!).toBe(true);
    }
    expect(await storedSession(nextWeek.id)).toMatchObject({
      type: "easy",
      title: null,
      target: { distanceM: PLANNED_M },
    });
  });

  it("is a no-op the second time: one adjustment per session per pause (double I'm back)", async () => {
    const { userId, today } = await pausedRunner({
      lastRun: "2026-09-30",
      startedOn: "2026-10-01",
    });
    await endPause(userId, NOW);
    const eased = await storedSession(today.id);
    const rows = await storedAdjustments(userId);

    const second = await endPause(userId, NOW);

    expect(second).toEqual({ pause: null, reEntry: null });
    expect(await storedSession(today.id)).toEqual(eased);
    expect(await storedAdjustments(userId)).toEqual(rows);
  });

  it("gives a plan built after the last run, whose first week already carries the re-entry, walk-run only (no double re-entry)", async () => {
    const userId = await createUser();
    await createRunOn(userId, "2026-09-28");
    const active = await createPlan(userId, {
      // Built 14 days after that run: week 1, this week, already starts at half the recent volume.
      createdAt: new Date("2026-10-12T09:00:00Z"),
      startDate: "2026-10-12",
      inputs: {
        ...PLAN_INPUTS,
        baseline: {
          weeklyVolumesM: [30_000, 30_000, 0, 0],
          longestRunM: 15_000,
          daysSinceLastRun: 14,
        },
      },
    });
    const today = await createSession(userId, active.id, { date: TODAY });
    const nextWeek = await createSession(userId, active.id, { date: "2026-10-21" });
    const pause = await createPause(userId, { startedOn: "2026-10-12", reason: "sick" });

    const { reEntry } = await endPause(userId, NOW);

    expect(reEntry).toMatchObject({ daysOff: 16, factor: 1, walkRun: true, sessionsChanged: 1 });
    expect((await storedSession(today.id)).title).toBe(WALK_RUN_TITLE);
    expect((await storedSession(nextWeek.id)).target.distanceM).toBe(PLANNED_M);
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        pauseId: pause.id,
        kind: "re_entry",
        requested: { factor: 0.5, walkRun: true, daysOff: 16 },
        applied: { factor: 1, walkRun: true, daysOff: 16 },
      }),
    ]);
  });

  it("eases a plan built during the break by what its first week does not carry yet: 15 days off over a 0.7 baseline runs at 0.5 / 0.7, not 0.35 (regenerating a plan, race date change)", async () => {
    const userId = await createUser();
    await createRunOn(userId, "2026-09-01");
    await createPause(userId, { startedOn: "2026-09-02", reason: "break" });
    // The goal saved on Wednesday 9 September, 8 days after the run: week 1 starts at 0.7 of the volume.
    const active = await createPlan(userId, {
      createdAt: new Date("2026-09-09T12:00:00Z"),
      startDate: "2026-09-14",
      inputs: { ...PLAN_INPUTS, baseline: { ...PLAN_INPUTS.baseline, daysSinceLastRun: 8 } },
    });
    const thursday = await createSession(userId, active.id, { date: "2026-09-17" });

    const { reEntry } = await endPause(userId, new Date("2026-09-16T10:00:00Z"));

    expect(reEntry).toMatchObject({ daysOff: 15, walkRun: false, sessionsChanged: 1 });
    expect(reEntry!.factor).toBeCloseTo(0.5 / 0.7, 10);
    expect((await storedSession(thursday.id)).target.distanceM).toBeCloseTo(
      (PLANNED_M * 0.5) / 0.7,
      -2,
    );
    const [row] = await storedAdjustments(userId);
    expect(row?.requested).toEqual({ factor: 0.5, walkRun: false, daysOff: 15 });
    expect((row?.applied as { factor: number }).factor).toBeCloseTo(0.5 / 0.7, 10);
  });

  it("eases a plan built from a 0.5 baseline once its first week is past: a return 7 weeks later runs at 0.5, never skipped (no double re-entry)", async () => {
    const userId = await createUser();
    await createRunOn(userId, "2026-08-07");
    await createPause(userId, { startedOn: "2026-08-23", reason: "break" });
    const active = await createPlan(userId, {
      createdAt: new Date("2026-08-22T12:00:00Z"),
      startDate: "2026-08-24",
      inputs: {
        ...PLAN_INPUTS,
        baseline: {
          weeklyVolumesM: [30_000, 30_000, 0, 0],
          longestRunM: 15_000,
          daysSinceLastRun: 15,
        },
      },
    });
    const today = await createSession(userId, active.id, { date: TODAY });

    const { reEntry } = await endPause(userId, NOW);

    expect(reEntry).toMatchObject({ daysOff: 68, factor: 0.5, sessionsChanged: 1 });
    expect((await storedSession(today.id)).target.distanceM).toBe(PLANNED_M * 0.5);
  });

  it("counts the longest stretch without a run: a run synced during the pause on the day I'm back ends 16 days off, not 0 (run during a pause)", async () => {
    const { userId, today, friday } = await pausedRunner({
      lastRun: "2026-09-27",
      startedOn: "2026-09-28",
    });
    await createRunOn(userId, "2026-10-13");

    const { reEntry } = await endPause(userId, new Date("2026-10-13T10:00:00Z"));

    expect(reEntry).toEqual({
      daysOff: 16,
      factor: 0.5,
      walkRun: false,
      fromDate: "2026-10-13",
      sessionsChanged: 2,
    });
    expect((await storedSession(today.id)).target.distanceM).toBe(PLANNED_M * 0.5);
    expect((await storedSession(friday.id)).target.distanceM).toBe(PLANNED_M * 0.5);
  });

  it("counts the longest stretch without a run: a run on day 3 of the pause and 12 more days off ease to 0.7 (run during a pause)", async () => {
    const { userId, today } = await pausedRunner({
      lastRun: "2026-09-27",
      startedOn: "2026-09-28",
    });
    await createRunOn(userId, "2026-09-30");

    const { reEntry } = await endPause(userId, new Date("2026-10-12T10:00:00Z"));

    expect(reEntry).toMatchObject({ daysOff: 12, factor: 0.7, fromDate: "2026-10-12" });
    expect((await storedSession(today.id)).target.distanceM).toBe(PLANNED_M * 0.7);
  });

  it("counts the days off from the pause's start for a runner without any run", async () => {
    const { userId } = await pausedRunner({ lastRun: null, startedOn: "2026-09-30" });

    const { reEntry } = await endPause(userId, NOW);

    expect(reEntry).toMatchObject({ daysOff: 14, factor: 0.5, sessionsChanged: 2 });
  });

  it("ends the pause without an active plan, with nothing to ease", async () => {
    const userId = await createUser();
    await createRunOn(userId, "2026-09-30");
    const custom = await createSession(userId, null, { date: "2026-10-13" });
    await createPause(userId, { startedOn: "2026-10-12", reason: "injured" });

    const response = await endPause(userId, NOW);

    expect(response).toEqual({
      pause: null,
      reEntry: { daysOff: 14, factor: 0.5, walkRun: true, fromDate: TODAY, sessionsChanged: 0 },
    });
    expect((await storedSession(custom.id)).status).toBe("skipped");
    expect(await storedPauses(userId)).toEqual([expect.objectContaining({ endedOn: TODAY })]);
  });

  it("queues a workout push, which puts the sessions back on the watch", async () => {
    const userId = await createUser();
    await connectGarmin(userId);
    await createPause(userId, { startedOn: "2026-10-12" });

    await endPause(userId);

    expect(await pushJobs(userId)).toHaveLength(1);
  });
});

describe("a goal saved mid-pause", () => {
  const fitness: GoalInput = {
    kind: "fitness",
    distanceKey: null,
    raceDate: null,
    targetTimeS: null,
    daysPerWeek: 4,
    longRunDay: "sun",
    recentTime: { distanceKey: "5k", timeS: 1500 },
  };

  it("keeps the pause, which belongs to the runner, and the new plan's sessions read paused (illness or injury pause)", async () => {
    clockAt(new Date("2026-10-01T12:00:00Z"));
    const agent = await signedInAgent(app);
    await agent.post("/api/pause").send({ reason: "injured" });

    expect((await agent.put("/api/goal").send(fitness)).status).toBe(200);

    expect(pauseResponseSchema.parse((await agent.get("/api/pause")).body).pause).toMatchObject({
      reason: "injured",
      startDate: "2026-10-01",
    });
    const { plan } = planResponseSchema.parse((await agent.get("/api/plan")).body);
    const sessions = plan!.weeks.flatMap((week) => week.sessions);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.paused)).toBe(true);
  });
});
