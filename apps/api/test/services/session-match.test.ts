import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, plan, planSession } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as bestEffortsQueue from "../../src/jobs/best-efforts-queue";
import { startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { syncGarmin } from "../../src/services/garmin-sync";
import { matchPlanSessions } from "../../src/services/session-match";
import {
  connectGarmin,
  createPause,
  createPlan,
  createRunAt,
  createRunOn,
  createSession,
  createUser,
  garminBundle,
  setGarminBundle,
  setSettings,
  storedSession,
} from "../seed";

// Run matching on the real Postgres (SPEC: Plan engine, slice 9): the service directly with a pinned
// instant, and through a sync against the Garmin service in fixture mode, whose seven runs lie between
// 2026-08-31 and 2026-09-27 (an indoor one on 09-24, a manual one on 09-12, one at 00:40 on 08-31 in
// Berlin, the evening of 08-30 in UTC). pg-boss runs without workers, so what a sync queues stays queued.

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
  await boss.createQueue(bestEffortsQueue.name, bestEffortsQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Wednesday midday in Berlin. */
const NOW = new Date("2026-10-14T10:00:00Z");
const TODAY = "2026-10-14";

async function runner(timezone = "Europe/Berlin") {
  const userId = await createUser();
  await setSettings(userId, { timezone });
  const active = await createPlan(userId, { startDate: "2026-08-24", endDate: "2026-12-20" });
  return { userId, planId: active.id };
}

describe("matchPlanSessions", () => {
  it("marks a session done with the run on its local date, custom workouts too", async () => {
    const { userId, planId } = await runner();
    const session = await createSession(userId, planId, { date: "2026-10-12" });
    const custom = await createSession(userId, null, { date: "2026-10-13", title: "Strides" });
    const run = await createRunOn(userId, "2026-10-12");
    const strides = await createRunOn(userId, "2026-10-13", { distanceM: 5000 });

    expect(await matchPlanSessions(userId, NOW)).toBe(2);

    expect(await storedSession(session.id)).toMatchObject({ status: "done", activityId: run.id });
    expect(await storedSession(custom.id)).toMatchObject({
      status: "done",
      activityId: strides.id,
    });
  });

  it("marks a past session without a run missed and keeps its date: missed runs are never rescheduled (missed sessions)", async () => {
    const { userId, planId } = await runner();
    const missed = await createSession(userId, planId, { date: "2026-10-13" });
    const today = await createSession(userId, planId, { date: TODAY });
    const later = await createSession(userId, planId, { date: "2026-10-16" });

    await matchPlanSessions(userId, NOW);

    expect(await storedSession(missed.id)).toMatchObject({
      date: "2026-10-13",
      status: "missed",
      activityId: null,
    });
    expect((await storedSession(today.id)).status).toBe("planned");
    expect((await storedSession(later.id)).status).toBe("planned");
  });

  it("marks today's session done once its run is in, and later days not at all", async () => {
    const { userId, planId } = await runner();
    const today = await createSession(userId, planId, { date: TODAY });
    const tomorrow = await createSession(userId, planId, { date: "2026-10-15" });
    const run = await createRunOn(userId, TODAY);
    await createRunOn(userId, "2026-10-15");

    await matchPlanSessions(userId, NOW);

    expect(await storedSession(today.id)).toMatchObject({ status: "done", activityId: run.id });
    expect(await storedSession(tomorrow.id)).toMatchObject({ status: "planned", activityId: null });
  });

  it("pairs the longest run with the longest session on a day with two runs (duplicate activities)", async () => {
    const { userId, planId } = await runner();
    const long = await createSession(userId, planId, {
      date: "2026-10-11",
      type: "long",
      steps: [{ kind: "run", zone: "easy", distanceM: 16_000, durationS: null }],
    });
    const short = await createSession(userId, null, {
      date: "2026-10-11",
      steps: [{ kind: "run", zone: "easy", distanceM: 4000, durationS: null }],
    });
    const shakeout = await createRunOn(userId, "2026-10-11", { distanceM: 4200 });
    const longRun = await createRunOn(userId, "2026-10-11", { distanceM: 15_800 });

    await matchPlanSessions(userId, NOW);

    expect((await storedSession(long.id)).activityId).toBe(longRun.id);
    expect((await storedSession(short.id)).activityId).toBe(shakeout.id);
  });

  it("re-pairs a day's sessions when a run's distance is edited on Garmin (edited activity)", async () => {
    const { userId, planId } = await runner();
    const long = await createSession(userId, planId, {
      date: "2026-10-11",
      type: "long",
      steps: [{ kind: "run", zone: "easy", distanceM: 16_000, durationS: null }],
    });
    const short = await createSession(userId, planId, { date: "2026-10-11" });
    const first = await createRunOn(userId, "2026-10-11", { distanceM: 16_000 });
    const second = await createRunOn(userId, "2026-10-11", { distanceM: 8000 });
    await matchPlanSessions(userId, NOW);
    expect((await storedSession(long.id)).activityId).toBe(first.id);

    // The runner cropped the first run on Garmin to 5 km; the sync rewrote its distance.
    await db.update(activity).set({ distanceM: 5000 }).where(eq(activity.id, first.id));
    expect(await matchPlanSessions(userId, NOW)).toBe(2);

    expect(await storedSession(long.id)).toMatchObject({ status: "done", activityId: second.id });
    expect(await storedSession(short.id)).toMatchObject({ status: "done", activityId: first.id });
  });

  it("matches by the run's local date, not its UTC date, for runs ahead of and behind UTC and on the fall-back day (time zones and DST)", async () => {
    const { userId, planId } = await runner();
    const now = new Date("2026-10-27T10:00:00Z");
    const sessions = await Promise.all(
      ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-24", "2026-10-25"].map((date) =>
        createSession(userId, planId, { date }),
      ),
    );
    const [fri, sat, sun, octSat, octSun] = sessions.map((s) => s.id);
    // Tokyo at 07:00 on Saturday is Friday evening in UTC.
    const tokyo = await createRunAt(userId, "2026-10-10 07:00:00", "2026-10-09T22:00:00Z");
    // New York at 21:00 on Saturday is Sunday in UTC.
    const newYork = await createRunAt(userId, "2026-10-10 21:00:00", "2026-10-11T01:00:00Z", {
      distanceM: 4000,
    });
    // 00:30 on the Sunday Berlin falls back (still CEST) is Saturday in UTC.
    const fallBack = await createRunAt(userId, "2026-10-25 00:30:00", "2026-10-24T22:30:00Z");

    await matchPlanSessions(userId, now);

    expect((await storedSession(sat!)).activityId).toBe(tokyo.id);
    expect((await storedSession(octSun!)).activityId).toBe(fallBack.id);
    for (const id of [fri!, sun!, octSat!]) {
      expect(await storedSession(id)).toMatchObject({ status: "missed", activityId: null });
    }
    // The day's second run has no session left to pair with.
    expect(
      (await db.select().from(planSession).where(eq(planSession.activityId, newYork.id))).length,
    ).toBe(0);
  });

  it("keeps skipped sessions skipped though a run is on their date (skipped session)", async () => {
    const { userId, planId } = await runner();
    const skipped = await createSession(userId, planId, { date: "2026-10-12", status: "skipped" });
    const pastSkipped = await createSession(userId, planId, {
      date: "2026-10-05",
      status: "skipped",
    });
    await createRunOn(userId, "2026-10-12");

    expect(await matchPlanSessions(userId, NOW)).toBe(0);

    expect(await storedSession(skipped.id)).toMatchObject({ status: "skipped", activityId: null });
    expect((await storedSession(pastSkipped.id)).status).toBe("skipped");
  });

  it("keeps the past sessions of an open pause planned, and misses the ones before it (illness or injury pause)", async () => {
    const { userId, planId } = await runner();
    const before = await createSession(userId, planId, { date: "2026-10-11" });
    const first = await createSession(userId, planId, { date: "2026-10-12" });
    const second = await createSession(userId, planId, { date: "2026-10-13" });
    await createPause(userId, { startedOn: "2026-10-12" });

    await matchPlanSessions(userId, NOW);

    expect((await storedSession(before.id)).status).toBe("missed");
    expect((await storedSession(first.id)).status).toBe("planned");
    expect((await storedSession(second.id)).status).toBe("planned");
  });

  it("leaves a superseded plan's sessions as they were", async () => {
    const { userId, planId } = await runner();
    const old = await createSession(userId, planId, { date: "2026-10-12" });
    await db.update(plan).set({ status: "superseded" }).where(eq(plan.id, planId));
    await createPlan(userId, { version: 2, startDate: "2026-10-19" });
    await createRunOn(userId, "2026-10-12");

    expect(await matchPlanSessions(userId, NOW)).toBe(0);

    expect(await storedSession(old.id)).toMatchObject({ status: "planned", activityId: null });
  });

  it("matches nothing for a runner without sessions", async () => {
    const userId = await createUser();
    await createRunOn(userId, "2026-10-12");

    expect(await matchPlanSessions(userId, NOW)).toBe(0);
  });
});

describe("matching after a sync", () => {
  // The fixture runs are synced up to 2026-09-28, the day after the newest one.
  const SYNC_NOW = new Date("2026-09-28T10:00:00Z");

  async function syncedRunner() {
    const { userId, planId } = await runner();
    await connectGarmin(userId, garminBundle());
    return { userId, planId };
  }

  async function sessionsOf(userId: string) {
    return db
      .select({
        date: planSession.date,
        status: planSession.status,
        activityId: planSession.activityId,
        updatedAt: planSession.updatedAt,
      })
      .from(planSession)
      .where(eq(planSession.userId, userId))
      .orderBy(asc(planSession.date));
  }

  async function runId(garminActivityId: number) {
    const [row] = await db
      .select({ id: activity.id })
      .from(activity)
      .where(eq(activity.garminActivityId, garminActivityId));
    if (!row) throw new Error(`no run ${garminActivityId}`);
    return row.id;
  }

  it("marks the sessions of the synced runs done, an indoor and a manual run included, and misses the rest (indoor runs)", async () => {
    const { userId, planId } = await syncedRunner();
    const treadmill = await createSession(userId, planId, { date: "2026-09-24" });
    const manual = await createSession(userId, planId, { date: "2026-09-12" });
    const noRun = await createSession(userId, planId, { date: "2026-09-25" });

    await syncGarmin({ userId, now: SYNC_NOW });

    expect(await storedSession(treadmill.id)).toMatchObject({
      status: "done",
      activityId: await runId(10_000_000_006),
    });
    expect(await storedSession(manual.id)).toMatchObject({
      status: "done",
      activityId: await runId(10_000_000_003),
    });
    expect((await storedSession(noRun.id)).status).toBe("missed");
  });

  it("matches the run at 00:40 in Berlin on its own date, which is the day before in UTC (time zones and DST)", async () => {
    const { userId, planId } = await syncedRunner();
    const dayBefore = await createSession(userId, planId, { date: "2026-08-30" });
    const ownDay = await createSession(userId, planId, { date: "2026-08-31" });

    await syncGarmin({ userId, now: SYNC_NOW });

    expect((await storedSession(ownDay.id)).activityId).toBe(await runId(10_000_000_001));
    expect(await storedSession(dayBefore.id)).toMatchObject({ status: "missed", activityId: null });
  });

  it("turns a done session back into missed when its run is deleted on Garmin, keeping its date (deleted activity)", async () => {
    const { userId, planId } = await syncedRunner();
    const longRun = await createSession(userId, planId, { date: "2026-09-27", type: "long" });
    await syncGarmin({ userId, now: SYNC_NOW });
    expect((await storedSession(longRun.id)).status).toBe("done");

    await setGarminBundle(userId, garminBundle("deleted_run"));
    await syncGarmin({ userId, now: SYNC_NOW });

    expect(await storedSession(longRun.id)).toMatchObject({
      date: "2026-09-27",
      status: "missed",
      activityId: null,
    });
  });

  it("changes nothing on a second sync (double sync)", async () => {
    const { userId, planId } = await syncedRunner();
    for (const date of ["2026-09-20", "2026-09-21", "2026-09-24", "2026-09-28"]) {
      await createSession(userId, planId, { date });
    }
    await syncGarmin({ userId, now: SYNC_NOW });
    const first = await sessionsOf(userId);

    await syncGarmin({ userId, now: SYNC_NOW });

    expect(await sessionsOf(userId)).toEqual(first);
    expect(first.map((s) => s.status)).toEqual(["done", "missed", "done", "planned"]);
  });

  it("matches the runs a sync stored before a later chunk failed (partial sync)", async () => {
    const { userId, planId } = await syncedRunner();
    const early = await createSession(userId, planId, { date: "2026-09-06" });
    const sync = garminClient.sync.bind(garminClient);
    vi.spyOn(garminClient, "sync").mockImplementation(async (body, options) => {
      if (body.startDate >= "2026-09-12") throw new Error("the Garmin service went away");
      return sync(body, options);
    });

    await expect(syncGarmin({ userId, now: SYNC_NOW })).rejects.toThrow();

    expect(await storedSession(early.id)).toMatchObject({
      status: "done",
      activityId: await runId(10_000_000_002),
    });
  });
});
