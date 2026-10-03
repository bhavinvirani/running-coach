import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCode,
  type GarminWorkoutAction,
  type GarminWorkoutSyncRequest,
  type GarminWorkoutSyncResponse,
  type GoalInput,
} from "@running-coach/shared";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import pg from "pg";
import type { Job, JobWithMetadata } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { garminConnection, plan, planSession, type PlanSessionRow } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import { enqueuePushWorkouts, startJobs, stopJobs } from "../../src/jobs";
import * as bestEffortsJob from "../../src/jobs/best-efforts";
import { getBoss } from "../../src/jobs/boss";
import * as pushJob from "../../src/jobs/push-workouts";
import { config } from "../../src/lib/config";
import { decrypt } from "../../src/lib/crypto";
import { advisoryLockKey } from "../../src/lib/lock-key";
import { syncGarmin } from "../../src/services/garmin-sync";
import { saveGoal } from "../../src/services/plan";
import { pushWorkouts, readPushStatus } from "../../src/services/workout-push";
import { desiredWorkout } from "../../src/services/workout-push-plan";
import {
  bodiesSentTo,
  connectGarmin,
  createPlan,
  createSession,
  createUser,
  garminBundle,
  INTERVAL_STEPS,
  PACES,
  setGarminBundle,
  setSettings,
  storedSession,
  TEMPO_STEPS,
} from "../seed";

// The workout push and its job on the real Postgres, against the Garmin service in fixture mode. "Today"
// is Thursday 2026-10-01 in Berlin (NOW), so the window is 2026-10-01 to 2026-10-07. The fake Garmin
// answers new workout and schedule ids from counters, and serves its calendar fixture moved into the
// asked month, so every window holds third-party workouts; tests read those from the answer.

const NOW = new Date("2026-10-01T10:00:00Z");
const TODAY = "2026-10-01";
const LAST_DAY = "2026-10-07";
let jobClock = NOW;

interface Runner {
  userId: string;
  planId: string;
}

async function runner(
  bundle = garminBundle(),
  settings: Parameters<typeof setSettings>[1] = {},
): Promise<Runner> {
  const userId = await createUser(`runner-${randomUUID()}@example.com`);
  await setSettings(userId, { timezone: "Europe/Berlin", ...settings });
  await connectGarmin(userId, bundle);
  const { id: planId } = await createPlan(userId);
  return { userId, planId };
}

async function connection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection");
  return row;
}

/** Every request to POST /workouts/sync from now on, bundle replaced by its fixture name. */
function workoutSyncs() {
  return bodiesSentTo<GarminWorkoutSyncRequest>("/workouts/sync");
}

/** Lets every batch through to the fixture service and keeps its answers. */
function workoutAnswers(): GarminWorkoutSyncResponse[] {
  const original = garminClient.syncWorkouts.bind(garminClient);
  const answers: GarminWorkoutSyncResponse[] = [];
  vi.spyOn(garminClient, "syncWorkouts").mockImplementation(async (request, options) => {
    const answer = await original(request, options);
    answers.push(answer);
    return answer;
  });
  return answers;
}

const kinds = (actions: GarminWorkoutAction[]) => actions.map((a) => [a.action, a.ref]);

function isGarminId(value: string | null): boolean {
  return value !== null && /^[1-9]\d*$/.test(value);
}

/** The session as the push should leave it: on Garmin with its current workout on its own date. */
function expectOnGarmin(row: PlanSessionRow, units: "km" | "mi" = "km", paces = PACES) {
  expect(isGarminId(row.garminWorkoutId)).toBe(true);
  expect(isGarminId(row.garminScheduleId)).toBe(true);
  expect(row.garminDate).toBe(row.date);
  expect(row.garminHash).toBe(desiredWorkout(row, paces, units)!.hash);
}

function expectNothingOnGarmin(row: PlanSessionRow) {
  expect(row).toMatchObject({
    garminWorkoutId: null,
    garminScheduleId: null,
    garminDate: null,
    garminHash: null,
  });
}

async function findJob(id: string | null | undefined): Promise<JobWithMetadata | undefined> {
  if (!id) throw new Error("no job id");
  const [job] = await getBoss().findJobs<object>(pushJob.name, { id });
  return job;
}

async function waitForJob(id: string | null): Promise<JobWithMetadata> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await findJob(id);
    if (job && ["completed", "failed"].includes(job.state)) return job;
    await sleep(100);
  }
  throw new Error(`job ${id} did not finish`);
}

/** Waits until the user has no push queued or running. */
async function waitForPushes(userId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const jobs = await getBoss().findJobs(pushJob.name, { key: userId });
    if (jobs.length > 0 && jobs.every((job) => ["completed", "failed"].includes(job.state))) return;
    await sleep(100);
  }
  throw new Error(`the pushes of ${userId} did not finish`);
}

function runningJob(userId: string): Job<unknown> {
  return {
    id: randomUUID(),
    name: pushJob.name,
    data: { userId },
    signal: new AbortController().signal,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    retryCount: 0,
  };
}

function secondsUntil(date: Date | undefined): number {
  return ((date?.getTime() ?? 0) - Date.now()) / 1000;
}

beforeAll(async () => {
  await startJobs({ pollingIntervalSeconds: 0.5, clock: () => jobClock });
  // Pushes call no sync, but the goal tests' sessions would not need it either; keep the batches out.
  await getBoss().offWork(bestEffortsJob.name, { wait: true });
});

afterAll(async () => {
  await stopJobs();
});

afterEach(() => {
  vi.restoreAllMocks();
  jobClock = NOW;
});

describe("pushWorkouts", () => {
  it("creates the window's sessions in one batch, stores their ids, dates and hashes, and lists the third-party workouts", async () => {
    const { userId, planId } = await runner();
    const easy = await createSession(userId, planId, { date: "2026-10-02" });
    const tempo = await createSession(userId, planId, {
      date: "2026-10-04",
      type: "tempo",
      steps: TEMPO_STEPS,
    });
    const custom = await createSession(userId, null, {
      date: LAST_DAY,
      type: "intervals",
      title: "Hill reps",
      steps: INTERVAL_STEPS,
    });
    const strength = await createSession(userId, planId, { date: "2026-10-03", type: "strength" });
    const yesterday = await createSession(userId, planId, { date: "2026-09-30" });
    const nextWeek = await createSession(userId, planId, { date: "2026-10-08" });
    const sent = workoutSyncs();
    const answers = workoutAnswers();

    const result = await pushWorkouts({ userId, now: NOW });

    const [request, ...more] = sent();
    expect(more).toEqual([]);
    expect(request).toMatchObject({ calendarStart: TODAY, calendarEnd: LAST_DAY });
    expect(kinds(request!.actions)).toEqual([
      ["create", easy.id],
      ["create", tempo.id],
      ["create", custom.id],
    ]);
    expect(request!.actions.map((a) => a.action === "create" && a.workout.name)).toEqual([
      "Easy 8.0 km",
      "Tempo 8.8 km",
      "Hill reps 11.8 km",
    ]);
    for (const session of [easy, tempo, custom]) expectOnGarmin(await storedSession(session.id));
    for (const session of [strength, yesterday, nextWeek]) {
      expectNothingOnGarmin(await storedSession(session.id));
    }
    const calendar = answers[0]?.calendar ?? [];
    const others = calendar
      .filter((entry) => entry.date >= TODAY && entry.date <= LAST_DAY)
      .map(({ scheduleId, date, title }) => ({ scheduleId, date, title }));
    expect(others.length).toBeGreaterThan(0);
    const stored = await connection(userId);
    expect(stored).toMatchObject({ workoutsPushError: null, status: "ok", lastError: null });
    expect(stored.workoutsPushedAt).not.toBeNull();
    expect(stored.garminCalendar.toSorted((a, b) => a.scheduleId - b.scheduleId)).toEqual(
      others.toSorted((a, b) => a.scheduleId - b.scheduleId),
    );
    expect(result).toEqual({
      window: { start: TODAY, end: LAST_DAY },
      batches: 1,
      actions: 3,
      others: others.length,
    });
    expect(await readPushStatus(userId, NOW)).toMatchObject({
      connection: "ok",
      pushing: false,
      error: null,
      others: stored.garminCalendar,
    });
  });

  it("sends no actions for sessions Garmin already holds, only reads the calendar (re-push of unchanged sessions)", async () => {
    const { userId, planId } = await runner();
    const easy = await createSession(userId, planId, { date: "2026-10-02" });
    await pushWorkouts({ userId, now: NOW });
    const before = await storedSession(easy.id);
    const sent = workoutSyncs();

    const result = await pushWorkouts({ userId, now: NOW });

    expect(sent()).toMatchObject([{ actions: [], calendarStart: TODAY, calendarEnd: LAST_DAY }]);
    expect(result).toMatchObject({ batches: 1, actions: 0 });
    expect(await storedSession(easy.id)).toEqual(before);
  });

  it("sends one move for a session moved to another day and stores its new date (moved session)", async () => {
    const { userId, planId } = await runner();
    const easy = await createSession(userId, planId, { date: "2026-10-02" });
    await pushWorkouts({ userId, now: NOW });
    const pushed = await storedSession(easy.id);
    await db
      .update(planSession)
      .set({ date: "2026-10-03", status: "moved" })
      .where(eq(planSession.id, easy.id));
    const sent = workoutSyncs();

    await pushWorkouts({ userId, now: NOW });

    expect(sent().map((request) => request.actions)).toEqual([
      [
        {
          action: "move",
          ref: easy.id,
          workoutId: Number(pushed.garminWorkoutId),
          scheduleId: Number(pushed.garminScheduleId),
          date: "2026-10-03",
        },
      ],
    ]);
    const moved = await storedSession(easy.id);
    expectOnGarmin(moved);
    expect(moved.garminWorkoutId).toBe(pushed.garminWorkoutId);
    expect(moved.garminScheduleId).not.toBe(pushed.garminScheduleId);
  });

  it("removes only the app's workouts of a skipped session and a deleted custom one, never a third-party workout (skip and delete)", async () => {
    const { userId, planId } = await runner();
    const skipped = await createSession(userId, planId, { date: "2026-10-02" });
    const custom = await createSession(userId, null, { date: "2026-10-03", title: "Strides" });
    const kept = await createSession(userId, planId, { date: "2026-10-04" });
    await pushWorkouts({ userId, now: NOW });
    const othersBefore = (await connection(userId)).garminCalendar;
    const ids = {
      skipped: await storedSession(skipped.id),
      custom: await storedSession(custom.id),
    };
    await db
      .update(planSession)
      .set({ status: "skipped" })
      .where(and(eq(planSession.userId, userId), isNotNull(planSession.garminWorkoutId)))
      .returning();
    await db.update(planSession).set({ status: "planned" }).where(eq(planSession.id, kept.id));
    const sent = workoutSyncs();

    await pushWorkouts({ userId, now: NOW });

    expect(sent().map((request) => request.actions)).toEqual([
      [
        {
          action: "remove",
          ref: skipped.id,
          workoutId: Number(ids.skipped.garminWorkoutId),
          scheduleId: Number(ids.skipped.garminScheduleId),
        },
        {
          action: "remove",
          ref: custom.id,
          workoutId: Number(ids.custom.garminWorkoutId),
          scheduleId: Number(ids.custom.garminScheduleId),
        },
      ],
    ]);
    expectNothingOnGarmin(await storedSession(skipped.id));
    expectNothingOnGarmin(await storedSession(custom.id));
    expectOnGarmin(await storedSession(kept.id));
    expect((await connection(userId)).garminCalendar).toEqual(othersBefore);
  });

  it("keeps the first session's ids when Garmin fails mid-batch, stores the error, and the retry creates only the second (Garmin outage, partial push)", async () => {
    const { userId, planId } = await runner(garminBundle("workout_outage"));
    const first = await createSession(userId, planId, { date: "2026-10-02" });
    const second = await createSession(userId, planId, { date: "2026-10-03" });

    await expect(pushWorkouts({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    expectOnGarmin(await storedSession(first.id));
    expectNothingOnGarmin(await storedSession(second.id));
    expect(await connection(userId)).toMatchObject({
      workoutsPushError: ErrorCode.garminUnavailable,
      lastError: ErrorCode.garminUnavailable,
      workoutsPushedAt: null,
    });
    await setGarminBundle(userId, garminBundle());
    const sent = workoutSyncs();

    await pushWorkouts({ userId, now: NOW });

    expect(sent().map((request) => kinds(request.actions))).toEqual([[["create", second.id]]]);
    expectOnGarmin(await storedSession(second.id));
    expect(await connection(userId)).toMatchObject({ workoutsPushError: null, lastError: null });
  });

  it("stores the workout of a create whose scheduling failed, and the retry only schedules it (Garmin outage, partial push)", async () => {
    const { userId, planId } = await runner(garminBundle("workout_schedule_outage"));
    const easy = await createSession(userId, planId, { date: "2026-10-02" });

    await expect(pushWorkouts({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    const uploaded = await storedSession(easy.id);
    expect(isGarminId(uploaded.garminWorkoutId)).toBe(true);
    expect(uploaded).toMatchObject({
      garminScheduleId: null,
      garminDate: null,
      garminHash: desiredWorkout(easy, PACES, "km")!.hash,
    });
    await setGarminBundle(userId, garminBundle());
    const sent = workoutSyncs();

    await pushWorkouts({ userId, now: NOW });

    expect(sent().map((request) => request.actions)).toEqual([
      [
        {
          action: "move",
          ref: easy.id,
          workoutId: Number(uploaded.garminWorkoutId),
          scheduleId: null,
          date: "2026-10-02",
        },
      ],
    ]);
    expectOnGarmin(await storedSession(easy.id));
  });

  it("stores the ids made before a 429 and then refuses for the hour without calling Garmin (Garmin 429)", async () => {
    const { userId, planId } = await runner(garminBundle("workout_rate_limited"));
    const first = await createSession(userId, planId, { date: "2026-10-02" });
    const second = await createSession(userId, planId, { date: "2026-10-03" });

    await expect(pushWorkouts({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminRateLimited,
      retryAfterSeconds: expect.any(Number) as number,
    });

    expectOnGarmin(await storedSession(first.id));
    expectNothingOnGarmin(await storedSession(second.id));
    expect(await connection(userId)).toMatchObject({
      lastError: ErrorCode.garminRateLimited,
      workoutsPushError: ErrorCode.garminRateLimited,
    });
    await setGarminBundle(userId, garminBundle(), new Date());
    const sent = workoutSyncs();
    await expect(pushWorkouts({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminRateLimited,
    });
    expect(sent()).toEqual([]);
  });

  it("creates again a workout Garmin no longer has (gone workout)", async () => {
    const { userId, planId } = await runner();
    const easy = await createSession(userId, planId, { date: "2026-10-02" });
    // Pushed once, then deleted in Garmin Connect: the fake answers 404 when it is scheduled.
    await db
      .update(planSession)
      .set({
        garminWorkoutId: "404404",
        garminHash: desiredWorkout(easy, PACES, "km")!.hash,
      })
      .where(eq(planSession.id, easy.id));
    const sent = workoutSyncs();

    const result = await pushWorkouts({ userId, now: NOW });

    expect(sent().map((request) => kinds(request.actions))).toEqual([
      [["move", easy.id]],
      [["create", easy.id]],
    ]);
    const created = await storedSession(easy.id);
    expectOnGarmin(created);
    expect(created.garminWorkoutId).not.toBe("404404");
    expect(result).toMatchObject({ batches: 2, actions: 2 });
  });

  it("names workouts in miles for a runner in miles (unit conversion)", async () => {
    const { userId, planId } = await runner(garminBundle(), { units: "mi" });
    const easy = await createSession(userId, planId, { date: "2026-10-02" });
    const sent = workoutSyncs();

    await pushWorkouts({ userId, now: NOW });

    const [create] = sent()[0]?.actions ?? [];
    expect(create).toMatchObject({ action: "create", workout: { name: "Easy 5.0 mi" } });
    expectOnGarmin(await storedSession(easy.id), "mi");
  });

  it.each([
    // 00:30 PDT on 2026-11-01, the day the clocks go back; still 07:30 UTC.
    {
      case: "America/Los_Angeles just after midnight on the fall-back day (DST)",
      timezone: "America/Los_Angeles",
      now: "2026-11-01T07:30:00Z",
      start: "2026-11-01",
      end: "2026-11-07",
    },
    // 23:30 PDT on 2026-10-31, already 2026-11-01 in UTC.
    {
      case: "America/Los_Angeles just before midnight, the UTC date ahead",
      timezone: "America/Los_Angeles",
      now: "2026-11-01T06:30:00Z",
      start: "2026-10-31",
      end: "2026-11-06",
    },
    // 00:30 NZDT on 2026-10-04, still 2026-10-03 in UTC.
    {
      case: "Pacific/Auckland near midnight UTC",
      timezone: "Pacific/Auckland",
      now: "2026-10-03T11:30:00Z",
      start: "2026-10-04",
      end: "2026-10-10",
    },
  ])(
    "keeps the runner's local today and the next six days: $case (time zones)",
    async ({ timezone, now, start, end }) => {
      const { userId, planId } = await runner(garminBundle(), { timezone });
      const dates = ["2026-10-03", "2026-10-04", "2026-10-10", "2026-10-11"];
      for (const date of [
        "2026-10-30",
        "2026-10-31",
        "2026-11-01",
        "2026-11-06",
        "2026-11-07",
        "2026-11-08",
        ...dates,
      ]) {
        await createSession(userId, planId, { date });
      }
      const sent = workoutSyncs();

      await pushWorkouts({ userId, now: new Date(now) });

      const [request] = sent();
      expect(request).toMatchObject({ calendarStart: start, calendarEnd: end });
      const created = await db
        .select({ date: planSession.date })
        .from(planSession)
        .where(and(eq(planSession.userId, userId), isNotNull(planSession.garminWorkoutId)))
        .orderBy(asc(planSession.date));
      const all = [
        "2026-10-03",
        "2026-10-04",
        "2026-10-10",
        "2026-10-11",
        "2026-10-30",
        "2026-10-31",
        "2026-11-01",
        "2026-11-06",
        "2026-11-07",
        "2026-11-08",
      ];
      expect(created.map((row) => row.date)).toEqual(all.filter((d) => d >= start && d <= end));
    },
  );

  it("removes the old plan's workouts from today on, leaves past ones, and creates the new plan's (race date change)", async () => {
    const userId = await createUser();
    await setSettings(userId, { timezone: "Europe/Berlin" });
    await connectGarmin(userId);
    const tenK: GoalInput = {
      kind: "race",
      distanceKey: "10k",
      raceDate: "2027-01-24",
      targetTimeS: null,
      daysPerWeek: 4,
      longRunDay: "sun",
      recentTime: { distanceKey: "5k", timeS: 1500 },
    };
    // Monday 2026-10-05: the plan starts today and its first week is the window. Saving queues a push.
    const monday = new Date("2026-10-05T08:00:00Z");
    jobClock = monday;
    const first = await saveGoal(userId, tenK, monday);
    if (!first.ok) throw new Error(first.conflict.code);
    await waitForPushes(userId);
    const firstWeek = await db
      .select()
      .from(planSession)
      .where(eq(planSession.planId, first.plan.id))
      .orderBy(asc(planSession.date));
    const pushedFirst = firstWeek.filter((s) => s.date <= "2026-10-11");
    expect(pushedFirst.length).toBeGreaterThan(1);
    for (const session of pushedFirst) expectOnGarmin(session, "km", first.plan.paces);

    // Thursday: the new race date makes plan 2, from next Monday 2026-10-12.
    const thursday = new Date("2026-10-08T08:00:00Z");
    jobClock = thursday;
    const sent = workoutSyncs();
    const second = await saveGoal(userId, { ...tenK, raceDate: "2027-01-31" }, thursday);
    if (!second.ok) throw new Error(second.conflict.code);
    await waitForPushes(userId);

    const [old] = await db.select().from(plan).where(eq(plan.id, first.plan.id));
    expect(old?.status).toBe("superseded");
    for (const session of pushedFirst) {
      const stored = await storedSession(session.id);
      if (session.date < "2026-10-08") expect(stored).toEqual(session);
      else expectNothingOnGarmin(stored);
    }
    expect(pushedFirst.some((s) => s.date < "2026-10-08")).toBe(true);
    expect(pushedFirst.some((s) => s.date >= "2026-10-08")).toBe(true);
    const newWindow = (
      await db.select().from(planSession).where(eq(planSession.planId, second.plan.id))
    ).filter((s) => s.date <= "2026-10-14");
    expect(newWindow.length).toBeGreaterThan(0);
    for (const session of newWindow) expectOnGarmin(session, "km", second.plan.paces);
    const actions = sent().flatMap((request) => request.actions);
    expect(actions.filter((a) => a.action === "remove")).toHaveLength(
      pushedFirst.filter((s) => s.date >= "2026-10-08").length,
    );
    expect(actions.filter((a) => a.action === "create")).toHaveLength(newWindow.length);
  });

  it("writes back a bundle Garmin rotated during the push (rotated token)", async () => {
    const { userId, planId } = await runner(garminBundle("rotate"));
    await createSession(userId, planId, { date: "2026-10-02" });

    await pushWorkouts({ userId, now: NOW });

    const stored = await connection(userId);
    expect(JSON.parse(decrypt(stored.tokenBundleEnc, userId))).toMatchObject({
      fixture: "rotated",
    });
  });

  it("sends what is left in the next batch when the service ran out of time before trying it", async () => {
    const { userId, planId } = await runner();
    const easy = await createSession(userId, planId, { date: "2026-10-02" });
    const original = garminClient.syncWorkouts.bind(garminClient);
    vi.spyOn(garminClient, "syncWorkouts")
      .mockImplementationOnce((request) =>
        Promise.resolve({
          tokenBundle: request.tokenBundle,
          results: request.actions.map((action) => ({
            ref: action.ref,
            action: action.action,
            outcome: "skipped" as const,
            workoutId: null,
            scheduleId: null,
          })),
          stopped: null,
          calendar: null,
        }),
      )
      .mockImplementation(original);
    const sent = workoutSyncs();

    const result = await pushWorkouts({ userId, now: NOW });

    expect(sent().map((request) => kinds(request.actions))).toEqual([[["create", easy.id]]]);
    expect(result).toMatchObject({ batches: 2, actions: 2 });
    expectOnGarmin(await storedSession(easy.id));
  });

  it("finishes when the calendar cannot be read and keeps the last list of other workouts", async () => {
    const { userId, planId } = await runner();
    await createSession(userId, planId, { date: "2026-10-02" });
    await pushWorkouts({ userId, now: NOW });
    const others = (await connection(userId)).garminCalendar;
    vi.spyOn(garminClient, "syncWorkouts").mockImplementation((request) =>
      Promise.resolve({
        tokenBundle: request.tokenBundle,
        results: [],
        stopped: null,
        calendar: null,
      }),
    );
    await db
      .update(garminConnection)
      .set({ workoutsPushedAt: null })
      .where(eq(garminConnection.userId, userId));

    const result = await pushWorkouts({ userId, now: NOW });

    expect(result).toMatchObject({ batches: 1, actions: 0, others: 0 });
    const stored = await connection(userId);
    expect(stored.workoutsPushedAt).not.toBeNull();
    expect(stored.garminCalendar).toEqual(others);
  });

  it("records internal and throws when the service stops on a bug of its own, keeping what it made", async () => {
    const { userId, planId } = await runner();
    const easy = await createSession(userId, planId, { date: "2026-10-02" });
    vi.spyOn(garminClient, "syncWorkouts").mockImplementation((request) =>
      Promise.resolve({
        tokenBundle: request.tokenBundle,
        results: request.actions.map((action) => ({
          ref: action.ref,
          action: action.action,
          outcome: "failed" as const,
          workoutId: 900_000_999,
          scheduleId: null,
        })),
        stopped: { code: ErrorCode.internal },
        calendar: null,
      }),
    );

    await expect(pushWorkouts({ userId, now: NOW })).rejects.toThrow(/internal/);

    expect(await storedSession(easy.id)).toMatchObject({
      garminWorkoutId: "900000999",
    });
    expect((await connection(userId)).workoutsPushError).toBe(ErrorCode.internal);
  });

  it("throws garmin_not_connected for a runner without Garmin", async () => {
    const userId = await createUser();

    await expect(pushWorkouts({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminNotConnected,
    });
  });

  it("runs one after the other with a sync of the same user, never both at once (overlapping syncs)", async () => {
    const { userId, planId } = await runner();
    await createSession(userId, planId, { date: "2026-10-02" });
    const original = globalThis.fetch;
    let active = 0;
    let most = 0;
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const garmin = url.endsWith("/sync");
      if (garmin) {
        active += 1;
        most = Math.max(most, active);
        paths.push(new URL(url).pathname);
      }
      try {
        return await original(input, init);
      } finally {
        if (garmin) active -= 1;
      }
    });

    await Promise.all([pushWorkouts({ userId, now: NOW }), syncGarmin({ userId, now: NOW })]);

    expect(most).toBe(1);
    expect(paths).toContain("/workouts/sync");
    expect(paths).toContain("/sync");
  });

  it("waits while another process holds the user's lock (overlapping syncs across processes)", async () => {
    const { userId, planId } = await runner();
    await createSession(userId, planId, { date: "2026-10-02" });
    const sent = workoutSyncs();
    const otherProcess = new pg.Client({ connectionString: config.DATABASE_URL });
    await otherProcess.connect();
    try {
      await otherProcess.query("begin");
      await otherProcess.query("select pg_advisory_xact_lock($1::bigint)", [
        advisoryLockKey("user", userId),
      ]);

      const push = pushWorkouts({ userId, now: NOW });
      await sleep(150);
      expect(sent()).toEqual([]);
      await otherProcess.query("commit");
      await push;

      expect(sent()).toHaveLength(1);
    } finally {
      await otherProcess.end();
    }
  });
});

describe("push-workouts job", () => {
  it("pushes the runner's window when queued, and folds a second send into the waiting one", async () => {
    const { userId, planId } = await runner();
    const easy = await createSession(userId, planId, { date: "2026-10-02" });

    const [first, second] = await Promise.all([
      enqueuePushWorkouts({ userId }),
      enqueuePushWorkouts({ userId }),
    ]);

    expect([first, second].filter((id) => id !== null)).toHaveLength(1);
    const job = await waitForJob(first ?? second);
    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toMatchObject({ status: "ok", actions: 1 });
    expectOnGarmin(await storedSession(easy.id));
  });

  it("reschedules itself an hour later on a 429 without counting a failed attempt, the ids made before it stored (Garmin 429)", async () => {
    const { userId, planId } = await runner(garminBundle("workout_rate_limited"));
    const first = await createSession(userId, planId, { date: "2026-10-02" });
    await createSession(userId, planId, { date: "2026-10-03" });

    const job = await waitForJob(await enqueuePushWorkouts({ userId }));

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toMatchObject({ status: "rate_limited" });
    const [nextId] = (job.output as { rescheduledJobIds: string[] }).rescheduledJobIds;
    const next = await findJob(nextId);
    expect(next?.state).toBe("created");
    expect(next?.data).toEqual({ userId });
    expect(secondsUntil(next?.startAfter)).toBeGreaterThan(60);
    expectOnGarmin(await storedSession(first.id));
    // The push is held back for the hour: the web app shows the error, not "Sending".
    expect(await readPushStatus(userId, NOW)).toMatchObject({
      pushing: false,
      error: ErrorCode.garminRateLimited,
    });
  });

  it("pushes back a waiting push on a 429 instead of queueing a second one (Garmin 429)", async () => {
    const { userId } = await runner(garminBundle("rate_limited"));
    const waiting = await getBoss().send(
      pushJob.name,
      { userId },
      { ...pushJob.sendOptions({ userId }), startAfter: 60 },
    );

    const output = await pushJob.handle(getBoss(), runningJob(userId), () => NOW);

    expect(output).toEqual({
      status: "rate_limited",
      retryAfterSeconds: 3600,
      rescheduledJobIds: [waiting],
    });
    expect(secondsUntil((await findJob(waiting))?.startAfter)).toBeGreaterThan(3500);
  });

  it("completes without retrying when Garmin rejects the login, and records garmin_auth_expired (token expiry)", async () => {
    const { userId, planId } = await runner(garminBundle("expired"));
    await createSession(userId, planId, { date: "2026-10-02" });

    const job = await waitForJob(await enqueuePushWorkouts({ userId }));

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toEqual({ status: ErrorCode.garminAuthExpired });
    expect(await connection(userId)).toMatchObject({
      lastError: ErrorCode.garminAuthExpired,
      workoutsPushError: ErrorCode.garminAuthExpired,
    });
  });

  it("pushes from the runner's local date when it runs, not when it was queued (a job delayed past midnight)", async () => {
    const { userId, planId } = await runner();
    const friday = await createSession(userId, planId, { date: "2026-10-02" });
    const thursday = await createSession(userId, planId, { date: TODAY });
    // 00:30 on Friday in Berlin, still Thursday in UTC.
    jobClock = new Date("2026-10-01T22:30:00Z");

    const job = await waitForJob(await enqueuePushWorkouts({ userId }));

    expect(job.output).toMatchObject({ window: { start: "2026-10-02", end: "2026-10-08" } });
    expectOnGarmin(await storedSession(friday.id));
    expectNothingOnGarmin(await storedSession(thursday.id));
  });
});
