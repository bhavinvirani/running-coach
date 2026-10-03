import {
  calendarResponseSchema,
  ErrorCode,
  garminPushResponseSchema,
  type GarminWorkoutSyncRequest,
  type OtherGarminWorkout,
} from "@running-coach/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { garminConnection, plan, planSession } from "../../src/db/schema";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { addDays, localDateOf } from "../../src/lib/local-date";
import { calendarPushLimiter, calendarUnscheduleLimiter } from "../../src/routes/calendar";
import { desiredWorkout } from "../../src/services/workout-push-plan";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import {
  bodiesSentTo,
  connectGarmin,
  createPlan,
  createSession,
  createUser,
  FASTER_PACES,
  garminBundle,
  PACES,
  setGarminBundle,
} from "../seed";

// /api/calendar on the real Postgres, against the Garmin service in fixture mode. pg-boss runs without
// workers, so a queued push stays queued. Sessions are dated in January 2030 (whatever day the tests run);
// third-party workouts are listed only within the runner's real push window, so those use today's date.

const app = createTestApp();

const MONDAY = "2030-01-07";
const TUESDAY = "2030-01-08";
const SUNDAY = "2030-01-13";

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  calendarPushLimiter.reset();
  calendarUnscheduleLimiter.reset();
});

/** The signed-in owner (UTC) with an active plan over January 2030 and, unless "none", a Garmin login. */
async function owner(garmin: "ok" | "expired" | "none" = "ok", bundle = garminBundle()) {
  const agent = await signedInAgent(app);
  const userId = await ownerId();
  if (garmin !== "none") await connectGarmin(userId, bundle, { status: garmin });
  const active = await createPlan(userId, { startDate: "2029-12-31", endDate: "2030-03-31" });
  return { agent, userId, planId: active.id };
}

/** Today in the owner's zone (UTC) and a day of the push window. */
function windowDay(offset: number): string {
  return addDays(localDateOf(new Date(), "UTC"), offset);
}

async function storeOthers(userId: string, others: OtherGarminWorkout[]) {
  await db
    .update(garminConnection)
    .set({ garminCalendar: others })
    .where(eq(garminConnection.userId, userId));
}

async function connection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection");
  return row;
}

async function pushJobs(userId: string) {
  return getBoss().findJobs(pushQueue.name, { key: userId });
}

describe("GET /api/calendar", () => {
  it("answers every day of the range with the active plan's sessions and the custom ones, plan first", async () => {
    const { agent, userId, planId } = await owner("none");
    const custom = await createSession(userId, null, { date: TUESDAY, title: "Strides" });
    const easy = await createSession(userId, planId, { date: TUESDAY });
    const skipped = await createSession(userId, planId, { date: SUNDAY, status: "skipped" });
    await createSession(userId, null, { date: SUNDAY, status: "skipped" });
    await createSession(userId, planId, { date: "2030-01-14" });
    await createSession(await createUser("other@example.com"), null, { date: TUESDAY });

    const response = await agent.get("/api/calendar").query({ from: MONDAY, to: SUNDAY });

    expect(response.status).toBe(200);
    const body = calendarResponseSchema.parse(response.body);
    expect(body.days.map((day) => day.date)).toEqual([
      MONDAY,
      TUESDAY,
      "2030-01-09",
      "2030-01-10",
      "2030-01-11",
      "2030-01-12",
      SUNDAY,
    ]);
    expect(body.days.map((day) => day.sessions.map((s) => s.id))).toEqual([
      [],
      [easy.id, custom.id],
      [],
      [],
      [],
      [],
      [skipped.id],
    ]);
    expect(body.days[1]?.sessions[1]).toMatchObject({ source: "custom", title: "Strides" });
    expect(body.paces).toEqual(PACES);
    expect(body.garmin).toEqual({
      connection: "not_connected",
      pushing: false,
      pushedAt: null,
      error: null,
      others: [],
    });
  });

  it("leaves out a superseded plan's sessions, and answers no paces without an active plan", async () => {
    const { agent, userId, planId } = await owner("none");
    await createSession(userId, planId, { date: TUESDAY });
    const custom = await createSession(userId, null, { date: TUESDAY });
    await db.update(plan).set({ status: "superseded" }).where(eq(plan.id, planId));

    const body = calendarResponseSchema.parse(
      (await agent.get("/api/calendar").query({ from: TUESDAY, to: TUESDAY })).body,
    );

    expect(body).toMatchObject({
      paces: null,
      days: [{ date: TUESDAY, sessions: [{ id: custom.id }] }],
    });
    expect(body.days[0]?.sessions[0]?.onGarmin).toBe(false);
  });

  it("marks a session on Garmin until its content changes with a new plan's paces (regenerating a plan)", async () => {
    const { agent, userId } = await owner();
    const custom = await createSession(userId, null, { date: TUESDAY });
    await db
      .update(planSession)
      .set({
        garminWorkoutId: "900000001",
        garminScheduleId: "800000001",
        garminDate: TUESDAY,
        garminHash: desiredWorkout(custom, PACES, "km")!.hash,
      })
      .where(eq(planSession.id, custom.id));
    const onGarmin = async () =>
      calendarResponseSchema.parse(
        (await agent.get("/api/calendar").query({ from: TUESDAY, to: TUESDAY })).body,
      ).days[0]?.sessions[0]?.onGarmin;

    expect(await onGarmin()).toBe(true);
    await db.update(plan).set({ paces: FASTER_PACES }).where(eq(plan.userId, userId));
    expect(await onGarmin()).toBe(false);
  });

  it("answers the push status: pushing while a push is queued, the last push and error, and the window's other workouts", async () => {
    const { agent, userId } = await owner();
    const pushedAt = new Date("2026-10-01T10:00:00Z");
    const inWindow = { scheduleId: 700000002, date: windowDay(6), title: "Strides" };
    await db
      .update(garminConnection)
      .set({
        workoutsPushedAt: pushedAt,
        workoutsPushError: ErrorCode.garminUnavailable,
        garminCalendar: [
          { scheduleId: 700000001, date: windowDay(-1), title: "Yesterday's" },
          inWindow,
          { scheduleId: 700000003, date: windowDay(7), title: null },
        ],
      })
      .where(eq(garminConnection.userId, userId));
    await pushQueue.enqueuePushWorkouts({ userId });

    const body = calendarResponseSchema.parse(
      (await agent.get("/api/calendar").query({ from: MONDAY, to: MONDAY })).body,
    );

    expect(body.garmin).toEqual({
      connection: "ok",
      pushing: true,
      pushedAt: pushedAt.toISOString(),
      error: ErrorCode.garminUnavailable,
      others: [inWindow],
    });
  });

  it("returns 400 for a range that ends before it starts, is over 42 days, or is missing a date", async () => {
    const { agent } = await owner("none");

    for (const query of [
      { from: SUNDAY, to: MONDAY },
      { from: MONDAY, to: addDays(MONDAY, 42) },
      { from: MONDAY },
      { from: MONDAY, to: "next week" },
    ]) {
      expectProblem(await agent.get("/api/calendar").query(query), 400, ErrorCode.validation);
    }
    expect(
      (await agent.get("/api/calendar").query({ from: MONDAY, to: addDays(MONDAY, 41) })).status,
    ).toBe(200);
  });

  it("returns 401 without a session", async () => {
    expectProblem(
      await request(app).get("/api/calendar").query({ from: MONDAY, to: SUNDAY }),
      401,
      ErrorCode.unauthorized,
    );
  });
});

describe("POST /api/calendar/push", () => {
  it("queues one push and answers the status, a second tap folding into it", async () => {
    const { agent, userId } = await owner();

    const first = await agent.post("/api/calendar/push");
    const second = await agent.post("/api/calendar/push");

    expect(first.status).toBe(200);
    expect(garminPushResponseSchema.parse(first.body).garmin).toMatchObject({
      connection: "ok",
      pushing: true,
    });
    expect(second.status).toBe(200);
    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it("returns 409 without a working Garmin login and queues nothing (not connected, token expiry)", async () => {
    const { agent, userId } = await owner("none");

    expectProblem(await agent.post("/api/calendar/push"), 409, ErrorCode.garminNotConnected);
    await connectGarmin(userId, garminBundle("expired"), { status: "expired" });
    expectProblem(await agent.post("/api/calendar/push"), 409, ErrorCode.garminAuthExpired);
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("returns 429 rate_limited on the 7th push in a minute", async () => {
    const { agent } = await owner();
    for (let i = 0; i < 6; i += 1) {
      expect((await agent.post("/api/calendar/push")).status).toBe(200);
    }

    const problem = expectProblem(
      await agent.post("/api/calendar/push"),
      429,
      ErrorCode.rateLimited,
    );
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).post("/api/calendar/push"), 401, ErrorCode.unauthorized);
  });
});

describe("POST /api/calendar/unschedule", () => {
  const strides = { scheduleId: 700000002, date: windowDay(1), title: "Strides" };
  const hills = { scheduleId: 700000003, date: windowDay(2), title: "Hills" };
  // The fake Garmin answers 404 when this one is unscheduled: it is already gone.
  const gone = { scheduleId: 404405, date: windowDay(3), title: null };

  it("takes listed third-party workouts off Garmin in the request, and only those (third-party workouts)", async () => {
    const { agent, userId } = await owner();
    await storeOthers(userId, [strides, hills, gone]);
    const sent = bodiesSentTo<GarminWorkoutSyncRequest>("/workouts/sync");

    const response = await agent
      .post("/api/calendar/unschedule")
      .send({ scheduleIds: [strides.scheduleId, gone.scheduleId] });

    expect(response.status).toBe(200);
    expect(garminPushResponseSchema.parse(response.body).garmin.others).toEqual([hills]);
    expect(sent()).toMatchObject([
      {
        actions: [
          { action: "unschedule", ref: String(strides.scheduleId), scheduleId: strides.scheduleId },
          { action: "unschedule", ref: String(gone.scheduleId), scheduleId: gone.scheduleId },
        ],
        calendarStart: windowDay(0),
        calendarEnd: windowDay(6),
        // The answer's calendar would go unused: the next push reads it.
        readCalendar: false,
      },
    ]);
    expect((await connection(userId)).garminCalendar).toEqual([hills]);
  });

  it("returns 404 for a workout it does not list, and calls no one (unknown third-party id)", async () => {
    const { agent, userId } = await owner();
    await storeOthers(userId, [strides, { ...hills, date: windowDay(8) }]);
    const sent = bodiesSentTo("/workouts/sync");

    expectProblem(
      await agent.post("/api/calendar/unschedule").send({ scheduleIds: [strides.scheduleId, 123] }),
      404,
      ErrorCode.notFound,
    );
    // Listed, but outside the window: the app never touches it.
    expectProblem(
      await agent.post("/api/calendar/unschedule").send({ scheduleIds: [hills.scheduleId] }),
      404,
      ErrorCode.notFound,
    );
    expect(sent()).toEqual([]);
  });

  it("records the error, keeps the list and answers it when Garmin is down (Garmin outage)", async () => {
    const { agent, userId } = await owner("ok", garminBundle("unavailable"));
    await storeOthers(userId, [strides]);

    expectProblem(
      await agent.post("/api/calendar/unschedule").send({ scheduleIds: [strides.scheduleId] }),
      502,
      ErrorCode.garminUnavailable,
    );

    expect(await connection(userId)).toMatchObject({
      garminCalendar: [strides],
      workoutsPushError: ErrorCode.garminUnavailable,
      lastError: ErrorCode.garminUnavailable,
    });
  });

  it("keeps the hour of a 429 when an unschedule is refused during it, and unschedules once the original hour has passed (Garmin 429)", async () => {
    const { agent, userId } = await owner();
    await storeOthers(userId, [strides]);
    const limitedAt = new Date(Date.now() - 30 * 60 * 1000);
    await db
      .update(garminConnection)
      .set({ lastError: ErrorCode.garminRateLimited, updatedAt: limitedAt })
      .where(eq(garminConnection.userId, userId));
    const sent = bodiesSentTo("/workouts/sync");
    const unscheduleStrides = () =>
      agent.post("/api/calendar/unschedule").send({ scheduleIds: [strides.scheduleId] });

    const refused = expectProblem(await unscheduleStrides(), 429, ErrorCode.garminRateLimited);

    expect(refused.retryAfterSeconds).toBeGreaterThan(29 * 60);
    expect(sent()).toEqual([]);
    expect(await connection(userId)).toMatchObject({
      garminCalendar: [strides],
      workoutsPushError: ErrorCode.garminRateLimited,
      lastError: ErrorCode.garminRateLimited,
      updatedAt: limitedAt,
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(limitedAt.getTime() + 61 * 60 * 1000);
    const response = await unscheduleStrides();

    expect(response.status).toBe(200);
    expect(garminPushResponseSchema.parse(response.body).garmin.others).toEqual([]);
    expect(sent()).toHaveLength(1);
    expect(await connection(userId)).toMatchObject({ garminCalendar: [], lastError: null });
  });

  it("returns 409 for an expired login without calling Garmin (token expiry)", async () => {
    const { agent, userId } = await owner("expired");
    await storeOthers(userId, [strides]);
    await setGarminBundle(userId, garminBundle());
    const sent = bodiesSentTo("/workouts/sync");

    expectProblem(
      await agent.post("/api/calendar/unschedule").send({ scheduleIds: [strides.scheduleId] }),
      409,
      ErrorCode.garminAuthExpired,
    );
    expect(sent()).toEqual([]);
  });

  it("returns 400 for no ids or more than 20, 429 on the 7th call in a minute, and 401 without a session", async () => {
    const { agent } = await owner();

    for (const body of [
      { scheduleIds: [] },
      { scheduleIds: Array.from({ length: 21 }, (_, i) => i + 1) },
    ]) {
      expectProblem(
        await agent.post("/api/calendar/unschedule").send(body),
        400,
        ErrorCode.validation,
      );
    }
    for (let i = 0; i < 4; i += 1) {
      expectProblem(
        await agent.post("/api/calendar/unschedule").send({ scheduleIds: [1] }),
        404,
        ErrorCode.notFound,
      );
    }
    expectProblem(
      await agent.post("/api/calendar/unschedule").send({ scheduleIds: [1] }),
      429,
      ErrorCode.rateLimited,
    );
    expectProblem(
      await request(app)
        .post("/api/calendar/unschedule")
        .send({ scheduleIds: [1] }),
      401,
      ErrorCode.unauthorized,
    );
  });
});
