import { sessionTarget } from "@running-coach/engine";
import {
  type CustomSessionInput,
  ErrorCode,
  moveSessionResponseSchema,
  sessionDetailResponseSchema,
} from "@running-coach/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { plan, planSession } from "../../src/db/schema";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import {
  createCustomSession,
  moveSession,
  skipSession,
  updateCustomSession,
} from "../../src/services/sessions";
import { desiredWorkout } from "../../src/services/workout-push-plan";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import {
  connectGarmin,
  createPause,
  createPlan,
  createSession,
  createUser,
  FASTER_PACES,
  INTERVAL_STEPS,
  PACES,
  setSettings,
  storedSession,
  TEMPO_STEPS,
} from "../seed";

// /api/sessions on the real Postgres. pg-boss runs without workers, so a push a change queues stays
// queued. Sessions are dated in January 2030, today or later whatever day the tests run, and in 2020 for
// the past; the "today" boundaries are tested through the services with a pinned instant.

const app = createTestApp();

const MONDAY = "2030-01-07";
const TUESDAY = "2030-01-08";
const THURSDAY = "2030-01-10";
const SATURDAY = "2030-01-12";
const SUNDAY = "2030-01-13";
const NEXT_MONDAY = "2030-01-14";
const PAST = "2020-01-07";

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

/** The signed-in owner with an active plan over January 2030 and, unless "none", a Garmin login. */
async function owner(garmin: "ok" | "expired" | "none" = "ok") {
  const agent = await signedInAgent(app);
  const userId = await ownerId();
  if (garmin !== "none") await connectGarmin(userId, undefined, { status: garmin });
  const active = await createPlan(userId, { startDate: "2029-12-31", endDate: "2030-03-31" });
  return { agent, userId, planId: active.id };
}

async function pushJobs(userId: string) {
  return getBoss().findJobs(pushQueue.name, { key: userId });
}

const hills: CustomSessionInput = {
  date: THURSDAY,
  type: "intervals",
  title: "Hill reps",
  steps: INTERVAL_STEPS,
};

function detailOf(response: request.Response) {
  return sessionDetailResponseSchema.parse(response.body);
}

describe("GET /api/sessions/:id", () => {
  it("returns the session with its plan's paces and the push status", async () => {
    const { agent, userId, planId } = await owner();
    const tempo = await createSession(userId, planId, {
      date: TUESDAY,
      type: "tempo",
      steps: TEMPO_STEPS,
    });

    const response = await agent.get(`/api/sessions/${tempo.id}`);

    expect(response.status).toBe(200);
    expect(detailOf(response)).toEqual({
      session: {
        id: tempo.id,
        date: TUESDAY,
        type: "tempo",
        target: tempo.target,
        steps: TEMPO_STEPS,
        status: "planned",
        source: "plan",
        title: null,
        activityId: null,
        adjustment: null,
        paused: false,
        onGarmin: false,
      },
      paces: PACES,
      garmin: { connection: "ok", pushing: false, pushedAt: null, error: null, others: [] },
    });
  });

  it("reads a custom workout at the active plan's paces and a superseded plan's session at its own", async () => {
    const { agent, userId, planId } = await owner();
    const custom = await createSession(userId, null, { date: TUESDAY, title: "Strides" });
    await db.update(plan).set({ status: "superseded" }).where(eq(plan.id, planId));
    await createPlan(userId, { version: 2, paces: FASTER_PACES });
    const old = await createSession(userId, planId, { date: TUESDAY });

    expect(detailOf(await agent.get(`/api/sessions/${custom.id}`))).toMatchObject({
      session: { source: "custom", title: "Strides" },
      paces: FASTER_PACES,
    });
    expect(detailOf(await agent.get(`/api/sessions/${old.id}`)).paces).toEqual(PACES);
  });

  it("says the session is on Garmin when Garmin holds its current workout on its date", async () => {
    const { agent, userId, planId } = await owner();
    const easy = await createSession(userId, planId, { date: TUESDAY });
    await db
      .update(planSession)
      .set({
        garminWorkoutId: "900000001",
        garminScheduleId: "800000001",
        garminDate: TUESDAY,
        garminHash: desiredWorkout(easy, PACES, "km")!.hash,
      })
      .where(eq(planSession.id, easy.id));

    expect(detailOf(await agent.get(`/api/sessions/${easy.id}`)).session.onGarmin).toBe(true);
    await setSettings(userId, { units: "mi" });
    // The name on the watch is in the runner's units: another workout until the push sends it.
    expect(detailOf(await agent.get(`/api/sessions/${easy.id}`)).session.onGarmin).toBe(false);
  });

  it("returns 404 for another runner's session and an unknown id, 400 for a malformed id", async () => {
    const { agent } = await owner();
    const other = await createUser("other@example.com");
    const { id: otherPlan } = await createPlan(other);
    const theirs = await createSession(other, otherPlan, { date: TUESDAY });

    expectProblem(await agent.get(`/api/sessions/${theirs.id}`), 404, ErrorCode.notFound);
    expectProblem(
      await agent.get("/api/sessions/00000000-0000-4000-8000-000000000000"),
      404,
      ErrorCode.notFound,
    );
    expectProblem(await agent.get("/api/sessions/not-a-uuid"), 400, ErrorCode.validation);
  });

  it("returns 401 without a session", async () => {
    expectProblem(
      await request(app).get("/api/sessions/00000000-0000-4000-8000-000000000000"),
      401,
      ErrorCode.unauthorized,
    );
  });
});

describe("POST /api/sessions", () => {
  it("creates a custom workout at the active plan's paces and queues one push (custom session)", async () => {
    const { agent, userId } = await owner();

    const response = await agent.post("/api/sessions").send(hills);
    await agent.post("/api/sessions").send({ ...hills, title: null, date: SATURDAY });

    expect(response.status).toBe(201);
    const body = detailOf(response);
    expect(body).toMatchObject({
      session: {
        date: THURSDAY,
        type: "intervals",
        title: "Hill reps",
        steps: INTERVAL_STEPS,
        target: sessionTarget(INTERVAL_STEPS, PACES),
        status: "planned",
        source: "custom",
        onGarmin: false,
      },
      paces: PACES,
      garmin: { connection: "ok", pushing: true },
    });
    expect(await storedSession(body.session.id)).toMatchObject({ planId: null, phase: null });
    // The second creation folds into the push already waiting.
    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it("queues no push for a runner without a working Garmin login (not connected, token expiry)", async () => {
    for (const garmin of ["none", "expired"] as const) {
      const { agent, userId } = await owner(garmin);

      const response = await agent.post("/api/sessions").send(hills);

      expect(response.status).toBe(201);
      expect(detailOf(response).garmin).toMatchObject({
        connection: garmin === "none" ? "not_connected" : "expired",
        pushing: false,
      });
      expect(await pushJobs(userId)).toEqual([]);
      await db.execute("truncate goal, plan_session, garmin_connection cascade");
    }
  });

  it("returns 409 plan_missing without an active plan", async () => {
    const agent = await signedInAgent(app);

    expectProblem(await agent.post("/api/sessions").send(hills), 409, ErrorCode.planMissing);
  });

  it("returns 400 for a date before today and for a workout the contract refuses", async () => {
    const { agent } = await owner();

    const past = expectProblem(
      await agent.post("/api/sessions").send({ ...hills, date: PAST }),
      400,
      ErrorCode.validation,
    );
    expect(past.issues).toEqual([{ path: "date", message: expect.any(String) as string }]);
    for (const body of [
      { ...hills, type: "race" },
      { ...hills, steps: [] },
      { ...hills, title: "x".repeat(61) },
      { ...hills, steps: Array(51).fill(INTERVAL_STEPS[0]) },
    ]) {
      expectProblem(await agent.post("/api/sessions").send(body), 400, ErrorCode.validation);
    }
  });

  it("returns 401 without a session", async () => {
    expectProblem(
      await request(app).post("/api/sessions").send(hills),
      401,
      ErrorCode.unauthorized,
    );
  });
});

describe("PUT /api/sessions/:id", () => {
  it("replaces a custom workout's day, type, title and steps, its target recomputed, and queues a push", async () => {
    const { agent, userId } = await owner();
    const custom = await createSession(userId, null, { date: TUESDAY, title: "Strides" });

    const response = await agent
      .put(`/api/sessions/${custom.id}`)
      .send({ date: SATURDAY, type: "tempo", title: "Cruise", steps: TEMPO_STEPS });

    expect(response.status).toBe(200);
    expect(detailOf(response).session).toMatchObject({
      id: custom.id,
      date: SATURDAY,
      type: "tempo",
      title: "Cruise",
      steps: TEMPO_STEPS,
      target: sessionTarget(TEMPO_STEPS, PACES),
      status: "planned",
    });
    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it("returns 409 session_locked for a plan session, a skipped, done or past workout, or a day before today", async () => {
    const { agent, userId, planId } = await owner();
    const planned = await createSession(userId, planId, { date: TUESDAY });
    const skipped = await createSession(userId, null, { date: TUESDAY, status: "skipped" });
    const done = await createSession(userId, null, { date: TUESDAY, status: "done" });
    const past = await createSession(userId, null, { date: PAST });
    const custom = await createSession(userId, null, { date: TUESDAY });

    for (const [id, body] of [
      [planned.id, hills],
      [skipped.id, hills],
      [done.id, hills],
      [past.id, hills],
      [custom.id, { ...hills, date: PAST }],
    ] as const) {
      expectProblem(
        await agent.put(`/api/sessions/${id}`).send(body),
        409,
        ErrorCode.sessionLocked,
      );
    }
    expect(await storedSession(custom.id)).toEqual(custom);
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("returns 404 for another runner's workout and 400 for a body the contract refuses", async () => {
    const { agent, userId } = await owner();
    const theirs = await createSession(await createUser("other@example.com"), null, {
      date: TUESDAY,
    });
    const custom = await createSession(userId, null, { date: TUESDAY });

    expectProblem(
      await agent.put(`/api/sessions/${theirs.id}`).send(hills),
      404,
      ErrorCode.notFound,
    );
    expectProblem(
      await agent.put(`/api/sessions/${custom.id}`).send({ ...hills, type: "rest" }),
      400,
      ErrorCode.validation,
    );
  });

  it("returns 401 without a session", async () => {
    expectProblem(
      await request(app).put("/api/sessions/00000000-0000-4000-8000-000000000000").send(hills),
      401,
      ErrorCode.unauthorized,
    );
  });
});

describe("POST /api/sessions/:id/move", () => {
  it("moves a session to another day of its week, marks it moved and queues a push (moved session)", async () => {
    const { agent, userId, planId } = await owner();
    const easy = await createSession(userId, planId, { date: TUESDAY });

    const response = await agent.post(`/api/sessions/${easy.id}/move`).send({ date: THURSDAY });

    expect(response.status).toBe(200);
    expect(moveSessionResponseSchema.parse(response.body)).toMatchObject({
      session: { id: easy.id, date: THURSDAY, status: "moved", source: "plan" },
      warning: null,
      garmin: { pushing: true },
    });
    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it("warns, never refuses, when the move leaves two hard sessions within 48 h, and ignores skipped ones", async () => {
    const { agent, userId, planId } = await owner();
    const tempo = await createSession(userId, planId, {
      date: TUESDAY,
      type: "tempo",
      steps: TEMPO_STEPS,
    });
    await createSession(userId, planId, { date: SUNDAY, type: "long" });
    await createSession(userId, planId, { date: THURSDAY, type: "intervals", status: "skipped" });

    const nextToLong = await agent.post(`/api/sessions/${tempo.id}/move`).send({ date: SATURDAY });
    const nextToSkipped = await agent
      .post(`/api/sessions/${tempo.id}/move`)
      .send({ date: THURSDAY });

    expect(moveSessionResponseSchema.parse(nextToLong.body)).toMatchObject({
      session: { date: SATURDAY, status: "moved" },
      warning: { code: "hard_days_close", otherType: "long", otherDate: SUNDAY },
    });
    expect(moveSessionResponseSchema.parse(nextToSkipped.body)).toMatchObject({
      session: { date: THURSDAY },
      warning: null,
    });
  });

  it("moves a custom workout and leaves its status planned when the day does not change", async () => {
    const { agent, userId } = await owner();
    const custom = await createSession(userId, null, { date: TUESDAY });

    const same = await agent.post(`/api/sessions/${custom.id}/move`).send({ date: TUESDAY });
    const moved = await agent.post(`/api/sessions/${custom.id}/move`).send({ date: MONDAY });

    expect(moveSessionResponseSchema.parse(same.body).session.status).toBe("planned");
    expect(moveSessionResponseSchema.parse(moved.body).session).toMatchObject({
      date: MONDAY,
      status: "moved",
      source: "custom",
    });
  });

  it("returns 409 session_locked out of its week, and for a past, done, skipped or superseded session (missed sessions are never made up)", async () => {
    const { agent, userId, planId } = await owner();
    const easy = await createSession(userId, planId, { date: TUESDAY });
    const locked = [
      await createSession(userId, planId, { date: PAST }),
      await createSession(userId, planId, { date: TUESDAY, status: "done" }),
      await createSession(userId, planId, { date: TUESDAY, status: "missed" }),
      await createSession(userId, planId, { date: TUESDAY, status: "skipped" }),
    ];
    await db.update(plan).set({ status: "superseded" }).where(eq(plan.id, planId));
    const { id: newPlan } = await createPlan(userId, { version: 2 });
    const current = await createSession(userId, newPlan, { date: TUESDAY });

    expectProblem(
      await agent.post(`/api/sessions/${current.id}/move`).send({ date: NEXT_MONDAY }),
      409,
      ErrorCode.sessionLocked,
    );
    expectProblem(
      await agent.post(`/api/sessions/${current.id}/move`).send({ date: "2030-01-06" }),
      409,
      ErrorCode.sessionLocked,
    );
    for (const session of [easy, ...locked]) {
      expectProblem(
        await agent.post(`/api/sessions/${session.id}/move`).send({ date: THURSDAY }),
        409,
        ErrorCode.sessionLocked,
      );
    }
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("returns 404 for another runner's session, 400 for a malformed date and 401 without a session", async () => {
    const { agent } = await owner();
    const other = await createUser("other@example.com");
    const theirs = await createSession(other, (await createPlan(other)).id, { date: TUESDAY });

    expectProblem(
      await agent.post(`/api/sessions/${theirs.id}/move`).send({ date: THURSDAY }),
      404,
      ErrorCode.notFound,
    );
    expectProblem(
      await agent.post(`/api/sessions/${theirs.id}/move`).send({ date: "Thursday" }),
      400,
      ErrorCode.validation,
    );
    expectProblem(
      await request(app).post(`/api/sessions/${theirs.id}/move`).send({ date: THURSDAY }),
      401,
      ErrorCode.unauthorized,
    );
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("skips a plan session and a custom workout and queues a push (skipped session)", async () => {
    const { agent, userId, planId } = await owner();
    const easy = await createSession(userId, planId, { date: TUESDAY });
    const custom = await createSession(userId, null, { date: THURSDAY });

    const skipped = await agent.delete(`/api/sessions/${easy.id}`);
    const deleted = await agent.delete(`/api/sessions/${custom.id}`);

    expect(detailOf(skipped).session).toMatchObject({ id: easy.id, status: "skipped" });
    expect(detailOf(deleted).session).toMatchObject({ id: custom.id, status: "skipped" });
    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it("returns 409 session_locked for a past, done or skipped session", async () => {
    const { agent, userId, planId } = await owner();
    for (const values of [
      { date: PAST },
      { date: TUESDAY, status: "done" as const },
      { date: TUESDAY, status: "skipped" as const },
    ]) {
      const session = await createSession(userId, planId, values);
      expectProblem(
        await agent.delete(`/api/sessions/${session.id}`),
        409,
        ErrorCode.sessionLocked,
      );
    }
  });

  it("returns 404 for another runner's session and 401 without a session", async () => {
    const { agent } = await owner();
    const other = await createUser("other@example.com");
    const theirs = await createSession(other, null, { date: TUESDAY });

    expectProblem(await agent.delete(`/api/sessions/${theirs.id}`), 404, ErrorCode.notFound);
    expect((await storedSession(theirs.id)).status).toBe("planned");
    expectProblem(
      await request(app).delete(`/api/sessions/${theirs.id}`),
      401,
      ErrorCode.unauthorized,
    );
  });
});

describe("today in the runner's time zone", () => {
  // 00:30 on Sunday 2026-10-04 in Auckland, still Saturday 2026-10-03 in UTC.
  const now = new Date("2026-10-03T11:30:00Z");

  async function aucklandRunner() {
    const userId = await createUser();
    await setSettings(userId, { timezone: "Pacific/Auckland" });
    const { id: planId } = await createPlan(userId);
    return { userId, planId };
  }

  it("treats the runner's yesterday as past though it is still today in UTC (time zones)", async () => {
    const { userId, planId } = await aucklandRunner();
    const saturday = await createSession(userId, planId, { date: "2026-10-03" });
    const sunday = await createSession(userId, planId, { date: "2026-10-04" });

    await expect(skipSession(userId, saturday.id, now)).rejects.toMatchObject({
      code: ErrorCode.sessionLocked,
    });
    await expect(moveSession(userId, sunday.id, "2026-10-03", now)).rejects.toMatchObject({
      code: ErrorCode.sessionLocked,
    });
    await expect(
      createCustomSession(userId, { ...hills, date: "2026-10-03" }, now),
    ).rejects.toMatchObject({ code: ErrorCode.validation });
    expect((await skipSession(userId, sunday.id, now)).session.status).toBe("skipped");
    expect(
      (await createCustomSession(userId, { ...hills, date: "2026-10-04" }, now)).session.date,
    ).toBe("2026-10-04");
  });

  it("keeps today's workout on today and refuses an edit onto the runner's yesterday", async () => {
    const { userId } = await aucklandRunner();
    const custom = await createSession(userId, null, { date: "2026-10-04" });

    await expect(
      updateCustomSession(userId, custom.id, { ...hills, date: "2026-10-03" }, now),
    ).rejects.toMatchObject({ code: ErrorCode.sessionLocked });
    const moved = await moveSession(userId, custom.id, "2026-10-04", now);
    expect(moved.session.date).toBe("2026-10-04");
  });
});

describe("sessions during a pause", () => {
  it("returns 409 session_locked for a move, a skip or an edit of a session the open pause holds, and stores nothing (illness or injury pause)", async () => {
    const { agent, userId, planId } = await owner();
    const tuesday = await createSession(userId, planId, { date: TUESDAY });
    const custom = await createSession(userId, null, { date: THURSDAY, title: "Strides" });
    await createPause(userId, { startedOn: MONDAY });

    expectProblem(
      await agent.post(`/api/sessions/${tuesday.id}/move`).send({ date: SATURDAY }),
      409,
      ErrorCode.sessionLocked,
    );
    expectProblem(await agent.delete(`/api/sessions/${tuesday.id}`), 409, ErrorCode.sessionLocked);
    expectProblem(
      await agent.put(`/api/sessions/${custom.id}`).send(hills),
      409,
      ErrorCode.sessionLocked,
    );

    expect(await storedSession(tuesday.id)).toMatchObject({ date: TUESDAY, status: "planned" });
    expect(await storedSession(custom.id)).toMatchObject({ title: "Strides", status: "planned" });
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("changes sessions again once the pause has ended", async () => {
    const { agent, userId, planId } = await owner();
    const tuesday = await createSession(userId, planId, { date: TUESDAY });
    await createPause(userId, { startedOn: MONDAY, endedOn: MONDAY });

    const response = await agent.delete(`/api/sessions/${tuesday.id}`);

    expect(response.status).toBe(200);
    expect(detailOf(response).session).toMatchObject({ status: "skipped", paused: false });
  });
});
