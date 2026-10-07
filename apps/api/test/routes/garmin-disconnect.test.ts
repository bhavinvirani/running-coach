import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  disconnectGarminResponseSchema,
  ErrorCode,
  type GarminWorkoutAction,
  type GarminWorkoutSyncRequest,
} from "@running-coach/shared";
import { eq } from "drizzle-orm";
import type { Job } from "pg-boss";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import {
  activity,
  garminConnection,
  plan,
  planSession,
  type PlanSessionRow,
} from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as bestEffortsJob from "../../src/jobs/best-efforts";
import { enqueueBestEfforts } from "../../src/jobs/best-efforts-queue";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushJob from "../../src/jobs/push-workouts";
import { enqueuePushWorkouts } from "../../src/jobs/push-workouts-queue";
import * as syncJob from "../../src/jobs/sync-garmin";
import { enqueueSyncGarmin } from "../../src/jobs/sync-garmin-queue";
import { decrypt } from "../../src/lib/crypto";
import { connectGarminLimiter } from "../../src/routes/garmin";
import { disconnectGarmin } from "../../src/services/garmin-disconnect";
import { syncGarmin } from "../../src/services/garmin-sync";
import { MAX_REMOVE_ROUNDS } from "../../src/services/workout-push";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import {
  bodiesSentTo,
  connectGarmin,
  createLongRun,
  createPlan,
  createRun,
  createSession,
  createUser,
  fixtureOf,
  garminBundle,
  setGarminBundle,
  setSettings,
  storedSession,
} from "../seed";
import { createHeldSession, localDay } from "../seed-garmin-login";

// Disconnect against the Garmin service in fixture mode, whose delete and unschedule answer {} for any id
// (services/garmin fake_client.py). The routes read today from the real clock in the runner's zone (UTC by
// default), so their sessions sit a day or more from today; disconnectGarmin's own tests pin the clock.

const app = createTestApp();
const PATH = "/api/garmin/connection";

beforeAll(async () => {
  const boss = await startBoss();
  for (const job of [syncJob, pushJob, bestEffortsJob]) {
    await boss.createQueue(job.name, job.queue);
  }
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.restoreAllMocks();
  connectGarminLimiter.reset();
});

async function connections() {
  return db.select().from(garminConnection);
}

async function storedConnection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection stored");
  return row;
}

/** Every POST /workouts/sync from now on, bundle replaced by its fixture name. */
function workoutSyncs() {
  return bodiesSentTo<GarminWorkoutSyncRequest>("/workouts/sync");
}

const removes = (actions: GarminWorkoutAction[]) =>
  actions.map((action) => [action.action, action.ref]);

function expectNothingOnGarmin(row: { garminWorkoutId: string | null }) {
  expect(row).toMatchObject({
    garminWorkoutId: null,
    garminScheduleId: null,
    garminDate: null,
    garminHash: null,
  });
}

/** The session row as seeded: its Garmin ids untouched. */
async function expectUnchanged(session: { id: string }) {
  expect(await storedSession(session.id)).toEqual(session);
}

/** The session still holds the workout it was seeded with (a failed result is stored, the ids kept). */
async function expectStillHeld(session: PlanSessionRow) {
  const { garminWorkoutId, garminScheduleId, garminDate, garminHash } = session;
  expect(await storedSession(session.id)).toMatchObject({
    garminWorkoutId,
    garminScheduleId,
    garminDate,
    garminHash,
  });
}

describe("DELETE /api/garmin/connection", () => {
  it("keep: forgets the login and calls no Garmin; runs, plans and sessions stay with their Garmin ids", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId);
    const { id: planId } = await createPlan(userId);
    const held = await createHeldSession(userId, planId, localDay(1));
    await createLongRun(userId);
    const sent = workoutSyncs();

    const response = await agent.delete(`${PATH}?workouts=keep`);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(disconnectGarminResponseSchema.parse(response.body)).toEqual({ removedWorkouts: 0 });
    expect(await connections()).toEqual([]);
    expect(sent()).toEqual([]);
    await expectUnchanged(held);
    expect(await db.select().from(activity)).toHaveLength(1);
    expect(await db.select().from(plan)).toHaveLength(1);
  });

  it("keep: wipes an expired login too (token expiry)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle("expired"), {
      status: "expired",
      lastError: ErrorCode.garminAuthExpired,
    });

    const response = await agent.delete(`${PATH}?workouts=keep`);

    expect(response.body).toEqual({ removedWorkouts: 0 });
    expect(await connections()).toEqual([]);
  });

  it("remove: takes the app's workouts from today on off Garmin in one batch, answers the count, then forgets the login", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId);
    const { id: oldPlanId } = await createPlan(userId, { status: "superseded" });
    const { id: planId } = await createPlan(userId, { version: 2 });
    const tomorrow = await createHeldSession(userId, planId, localDay(1));
    const skipped = await createHeldSession(userId, planId, localDay(3), { status: "skipped" });
    const custom = await createHeldSession(userId, null, localDay(4));
    // Past the push's 7-day window, of a plan the runner replaced: still the app's workout.
    const later = await createHeldSession(userId, oldPlanId, localDay(12));
    const past = await createHeldSession(userId, planId, localDay(-3));
    const unsent = await createSession(userId, planId, { date: localDay(2) });
    await createRun(userId);
    const sent = workoutSyncs();

    const response = await agent.delete(`${PATH}?workouts=remove`);

    expect(response.status).toBe(200);
    expect(disconnectGarminResponseSchema.parse(response.body)).toEqual({ removedWorkouts: 4 });
    const batches = sent();
    expect(batches).toHaveLength(1);
    expect(removes(batches[0]!.actions).toSorted()).toEqual(
      [tomorrow, skipped, custom, later].map((s) => ["remove", s.id]).toSorted(),
    );
    expect(batches[0]).toMatchObject({ readCalendar: false, fixture: undefined });
    for (const session of [tomorrow, skipped, custom, later]) {
      expectNothingOnGarmin(await storedSession(session.id));
    }
    await expectUnchanged(past);
    await expectUnchanged(unsent);
    expect(await connections()).toEqual([]);
    expect(await db.select().from(planSession)).toHaveLength(6);
    expect(await db.select().from(activity)).toHaveLength(1);
  });

  it("remove: with nothing on Garmin answers 0 without a Garmin call, also during a 429's hour", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle(), { lastError: ErrorCode.garminRateLimited });
    const { id: planId } = await createPlan(userId);
    await createSession(userId, planId, { date: localDay(1) });
    const sent = workoutSyncs();

    const response = await agent.delete(`${PATH}?workouts=remove`);

    expect(response.body).toEqual({ removedWorkouts: 0 });
    expect(sent()).toEqual([]);
    expect(await connections()).toEqual([]);
  });

  it("remove: answers 409 garmin_auth_expired for an expired login and changes nothing (token expiry)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle("expired"), {
      status: "expired",
      lastError: ErrorCode.garminAuthExpired,
    });
    const before = await storedConnection(userId);
    const { id: planId } = await createPlan(userId);
    const held = await createHeldSession(userId, planId, localDay(1));
    const sent = workoutSyncs();

    const response = await agent.delete(`${PATH}?workouts=remove`);

    expectProblem(response, 409, ErrorCode.garminAuthExpired);
    expect(sent()).toEqual([]);
    expect(await storedConnection(userId)).toEqual(before);
    await expectUnchanged(held);
  });

  it("answers 0 with no login, so a second tap is a no-op", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId);

    const first = await agent.delete(`${PATH}?workouts=remove`);
    const second = await agent.delete(`${PATH}?workouts=remove`);
    const third = await agent.delete(`${PATH}?workouts=keep`);

    for (const response of [first, second, third]) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ removedWorkouts: 0 });
    }
  });

  it("remove: keeps the login, the rotated bundle and the ids when Garmin fails mid-batch, and a retry finishes (Garmin outage)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle("rotate_then_unavailable"));
    const { id: planId } = await createPlan(userId);
    const held = await createHeldSession(userId, planId, localDay(1));

    const failed = await agent.delete(`${PATH}?workouts=remove`);

    expectProblem(failed, 502, ErrorCode.garminUnavailable);
    const kept = await storedConnection(userId);
    expect(kept).toMatchObject({
      status: "ok",
      lastError: ErrorCode.garminUnavailable,
      workoutsPushError: ErrorCode.garminUnavailable,
    });
    expect(fixtureOf(decrypt(kept.tokenBundleEnc, userId))).toBe("rotated");
    await expectStillHeld(held);

    await setGarminBundle(userId, garminBundle());
    const retried = await agent.delete(`${PATH}?workouts=remove`);

    expect(retried.body).toEqual({ removedWorkouts: 1 });
    expectNothingOnGarmin(await storedSession(held.id));
    expect(await connections()).toEqual([]);
  });

  it("remove: keeps the login when Garmin's login fails, and during the 429's hour refuses without calling Garmin (Garmin outage, Garmin 429)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle("unavailable"));
    const { id: planId } = await createPlan(userId);
    const held = await createHeldSession(userId, planId, localDay(1));
    const sent = workoutSyncs();

    expectProblem(await agent.delete(`${PATH}?workouts=remove`), 502, ErrorCode.garminUnavailable);
    await setGarminBundle(userId, garminBundle("rate_limited"));
    const limited = await agent.delete(`${PATH}?workouts=remove`);
    const refused = await agent.delete(`${PATH}?workouts=remove`);

    expect(expectProblem(limited, 429, ErrorCode.garminRateLimited).retryAfterSeconds).toBe(3600);
    const problem = expectProblem(refused, 429, ErrorCode.garminRateLimited);
    expect(problem.retryAfterSeconds).toBeGreaterThan(3500);
    expect(sent()).toHaveLength(2);
    expect(await storedConnection(userId)).toMatchObject({
      status: "ok",
      lastError: ErrorCode.garminRateLimited,
    });
    await expectUnchanged(held);
  });

  it("waits for a running sync of the same user before forgetting the login (overlapping syncs)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle(), { lastSyncAt: new Date("2026-09-26T12:00:00Z") });
    const events: string[] = [];
    const sync = garminClient.sync.bind(garminClient);
    vi.spyOn(garminClient, "sync").mockImplementation(async (body, options) => {
      events.push("sync start");
      await sleep(50);
      const answer = await sync(body, options);
      events.push("sync end");
      return answer;
    });

    // syncGarmin joins the user's lock queue before its first await, so it is ahead of the request.
    const running = syncGarmin({ userId, now: new Date("2026-09-28T10:00:00Z") });
    const response = await agent.delete(`${PATH}?workouts=keep`);
    events.push("disconnected");

    expect(response.status).toBe(200);
    expect(await running).toMatchObject({ endDate: "2026-09-28" });
    expect(events).toEqual(["sync start", "sync end", "disconnected"]);
    expect(await connections()).toEqual([]);
  });

  it("lets a Sync now that a disconnect overtook answer 409 garmin_not_connected, not 500 (overlapping syncs)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle(), { lastSyncAt: new Date("2026-09-26T12:00:00Z") });
    const sync = garminClient.sync.bind(garminClient);
    let disconnected: Promise<request.Response> | undefined;
    vi.spyOn(garminClient, "sync").mockImplementation(async (body, options) => {
      const answer = await sync(body, options);
      // Queued on the lock while the sync holds it: it runs the moment the sync releases it, before Sync
      // now reads the cursor after the plan's and the coach's follow-ups.
      disconnected ??= Promise.resolve(agent.delete(`${PATH}?workouts=keep`));
      await sleep(50);
      return answer;
    });

    const synced = await agent.post("/api/sync");

    expect((await disconnected)?.status).toBe(200);
    expect(await connections()).toEqual([]);
    expectProblem(synced, 409, ErrorCode.garminNotConnected);
  });

  it("returns 400 validation without a valid workouts choice, and changes nothing", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId);

    for (const query of [
      "",
      "?workouts=delete",
      "?workouts=keep&workouts=remove",
      "?workouts=keep&userId=00000000-0000-4000-8000-000000000000",
    ]) {
      expectProblem(await agent.delete(`${PATH}${query}`), 400, ErrorCode.validation);
    }
    expect(await connections()).toHaveLength(1);
  });

  it("returns 401 without a session and changes nothing", async () => {
    const userId = await createUser();
    await connectGarmin(userId);

    const response = await request(app).delete(`${PATH}?workouts=keep`);

    expectProblem(response, 401, ErrorCode.unauthorized);
    expect(await connections()).toHaveLength(1);
  });
});

// "Today" is Thursday 2026-10-01 in Berlin (NOW), as in the push's tests.
describe("disconnectGarmin", () => {
  const NOW = new Date("2026-10-01T10:00:00Z");

  async function runner() {
    const userId = await createUser(`runner-${randomUUID()}@example.com`);
    await setSettings(userId, { timezone: "Europe/Berlin" });
    await connectGarmin(userId);
    const { id: planId } = await createPlan(userId);
    return { userId, planId };
  }

  it("removes what Garmin shows from the runner's local today on, of any status the push may change, and leaves history (remove)", async () => {
    const { userId, planId } = await runner();
    const today = await createHeldSession(userId, planId, "2026-10-01");
    const skipped = await createHeldSession(userId, planId, "2026-10-03", { status: "skipped" });
    const moved = await createHeldSession(userId, planId, "2026-10-06", { status: "moved" });
    // Uploaded, never scheduled: nothing to unschedule, the workout still goes.
    const unscheduled = await createHeldSession(userId, planId, "2026-10-05", { garminDate: null });
    const unscheduledRow = await db
      .update(planSession)
      .set({ garminScheduleId: null })
      .where(eq(planSession.id, unscheduled.id))
      .returning();
    const yesterday = await createHeldSession(userId, planId, "2026-09-30");
    const done = await createHeldSession(userId, planId, "2026-10-01", { status: "done" });
    // Moved to Friday after it went to Garmin on Wednesday: Garmin shows it in the past.
    const shownInThePast = await createHeldSession(userId, planId, "2026-10-02", {
      garminDate: "2026-09-30",
    });
    const sent = workoutSyncs();

    const result = await disconnectGarmin({ userId, workouts: "remove", now: NOW });

    expect(result).toEqual({ removedWorkouts: 4 });
    const [batch] = sent();
    expect(batch?.actions).toEqual(
      expect.arrayContaining([
        {
          action: "remove",
          ref: unscheduled.id,
          workoutId: Number(unscheduledRow[0]!.garminWorkoutId),
          scheduleId: null,
        },
      ]),
    );
    expect(removes(batch!.actions).toSorted()).toEqual(
      [today, skipped, moved, unscheduled].map((s) => ["remove", s.id]).toSorted(),
    );
    for (const session of [today, skipped, moved, unscheduled]) {
      expectNothingOnGarmin(await storedSession(session.id));
    }
    for (const session of [yesterday, done, shownInThePast]) await expectUnchanged(session);
  });

  it("reads today in the runner's zone: past midnight in Berlin, Thursday is already history (time zones)", async () => {
    const { userId, planId } = await runner();
    const thursday = await createHeldSession(userId, planId, "2026-10-01");
    const friday = await createHeldSession(userId, planId, "2026-10-02");

    // 00:30 on Friday in Berlin, still Thursday in UTC.
    const result = await disconnectGarmin({
      userId,
      workouts: "remove",
      now: new Date("2026-10-01T22:30:00Z"),
    });

    expect(result).toEqual({ removedWorkouts: 1 });
    await expectUnchanged(thursday);
    expectNothingOnGarmin(await storedSession(friday.id));
  });

  it("sends more than a batch in rounds, and past MAX_REMOVE_ROUNDS answers 502 with the login and the rest kept for a retry", async () => {
    const { userId, planId } = await runner();
    const sessions = [];
    for (let day = 0; day < 17; day += 1) {
      const date = new Date(Date.UTC(2026, 9, 2 + day)).toISOString().slice(0, 10);
      sessions.push(await createHeldSession(userId, planId, date));
    }
    const sent = workoutSyncs();

    await expect(disconnectGarmin({ userId, workouts: "remove", now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
      status: 502,
    });

    expect(sent().map((batch) => batch.actions.length)).toEqual([8, 8]);
    expect(MAX_REMOVE_ROUNDS).toBe(2);
    expect(await storedConnection(userId)).toMatchObject({
      status: "ok",
      workoutsPushError: ErrorCode.garminUnavailable,
    });
    const left = await db.select().from(planSession).where(eq(planSession.userId, userId));
    expect(left.filter((row) => row.garminWorkoutId !== null)).toHaveLength(1);

    expect(await disconnectGarmin({ userId, workouts: "remove", now: NOW })).toEqual({
      removedWorkouts: 1,
    });
    expect(await connections()).toEqual([]);
  });
});

describe("jobs queued before a disconnect", () => {
  function asRunning(found: { id: string; name: string; data: object }): Job<unknown> {
    return {
      id: found.id,
      name: found.name,
      data: found.data,
      signal: new AbortController().signal,
      expireInSeconds: 900,
      heartbeatSeconds: null,
      retryCount: 0,
    };
  }

  async function queued(name: string, userId: string): Promise<Job<unknown>> {
    const [found] = await getBoss().findJobs<object>(name, { key: userId, queued: true });
    if (!found) throw new Error(`no ${name} job queued`);
    return asRunning(found);
  }

  it("complete as garmin_not_connected without throwing or calling Garmin: sync, workout push and best efforts", async () => {
    const userId = await createUser();
    await connectGarmin(userId);
    const { id: planId } = await createPlan(userId);
    await createHeldSession(userId, planId, localDay(1));
    // A run whose best efforts are pending: the best-efforts job would fetch its series.
    await createRun(userId);
    await enqueueSyncGarmin({ userId, date: localDay(0) });
    await enqueuePushWorkouts({ userId });
    await enqueueBestEfforts({ userId });
    const garmin = vi.spyOn(globalThis, "fetch");

    await disconnectGarmin({ userId, workouts: "keep" });

    const boss = getBoss();
    expect(await syncJob.handle(boss, await queued(syncJob.name, userId))).toEqual({
      status: ErrorCode.garminNotConnected,
    });
    expect(await pushJob.handle(boss, await queued(pushJob.name, userId))).toEqual({
      status: ErrorCode.garminNotConnected,
    });
    expect(await bestEffortsJob.handle(boss, await queued(bestEffortsJob.name, userId))).toEqual({
      status: ErrorCode.garminNotConnected,
    });
    expect(garmin).not.toHaveBeenCalled();
  });
});
