import { BEST_EFFORTS_VERSION } from "@running-coach/engine";
import {
  type DistanceKey,
  ErrorCode,
  type GarminRecord,
  personalBestsResponseSchema,
} from "@running-coach/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, bestEffort, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as bestEffortsQueue from "../../src/jobs/best-efforts-queue";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import { BEST_EFFORTS_MAX_ATTEMPTS } from "../../src/services/best-efforts";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { connectGarmin, createRun, createUser, garminBundle } from "../seed";

// GET /api/personal-bests on the real Postgres. pg-boss runs with the best-efforts queue but no worker, so
// a queued batch waits until a test fetches and completes it.

const app = createTestApp();

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(bestEffortsQueue.name, bestEffortsQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.restoreAllMocks();
});

let nextGarminId = 1;

/** A run whose best efforts are stored: one row per distance with the times given. */
async function computedRun(
  userId: string,
  efforts: Partial<Record<DistanceKey, number>>,
  values: Parameters<typeof createRun>[1] = {},
) {
  const run = await createRun(userId, {
    garminActivityId: nextGarminId++,
    bestEffortsVersion: BEST_EFFORTS_VERSION,
    ...values,
  });
  const rows = Object.entries(efforts).map(([distanceKey, timeS]) => ({
    userId,
    activityId: run.id,
    distanceKey: distanceKey as DistanceKey,
    timeS,
    startS: 12.5,
  }));
  if (rows.length > 0) await db.insert(bestEffort).values(rows);
  return run;
}

async function personalBests(agent: Awaited<ReturnType<typeof signedInAgent>>) {
  const response = await agent.get("/api/personal-bests");
  expect(response.status).toBe(200);
  return personalBestsResponseSchema.parse(response.body);
}

describe("GET /api/personal-bests", () => {
  it("returns the fastest effort per distance, shortest first, with the run it came from", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const older = await computedRun(
      userId,
      { "10k": 3290.5, "5k": 1625.25, "1k": 301 },
      { startUtc: new Date("2026-08-02T05:00:00Z"), startLocal: "2026-08-02 07:00:00" },
    );
    const newer = await computedRun(
      userId,
      { "5k": 1601.75, "1k": 305, half: 7012.125 },
      { startUtc: new Date("2026-09-20T22:30:00Z"), startLocal: "2026-09-21 00:30:00" },
    );

    const body = await personalBests(agent);

    expect(body.bests).toEqual([
      {
        distanceKey: "1k",
        timeS: 301,
        activityId: older.id,
        startUtc: "2026-08-02T05:00:00.000Z",
        startLocal: "2026-08-02T07:00:00",
      },
      {
        distanceKey: "5k",
        timeS: 1601.75,
        activityId: newer.id,
        startUtc: "2026-09-20T22:30:00.000Z",
        // The runner's own date, just after local midnight, whatever the UTC date (time zones).
        startLocal: "2026-09-21T00:30:00",
      },
      {
        distanceKey: "10k",
        timeS: 3290.5,
        activityId: older.id,
        startUtc: "2026-08-02T05:00:00.000Z",
        startLocal: "2026-08-02T07:00:00",
      },
      {
        distanceKey: "half",
        timeS: 7012.125,
        activityId: newer.id,
        startUtc: "2026-09-20T22:30:00.000Z",
        startLocal: "2026-09-21T00:30:00",
      },
    ]);
  });

  it("gives an exact tie to the earlier run (duplicate activities)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await computedRun(
      userId,
      { "5k": 1600 },
      { startUtc: new Date("2026-09-20T06:00:00Z"), startLocal: "2026-09-20 08:00:00" },
    );
    const earlier = await computedRun(
      userId,
      { "5k": 1600 },
      { startUtc: new Date("2026-09-10T06:00:00Z"), startLocal: "2026-09-10 08:00:00" },
    );

    const body = await personalBests(agent);

    expect(body.bests).toHaveLength(1);
    expect(body.bests[0]?.activityId).toBe(earlier.id);
  });

  it("leaves out treadmill, indoor and manual runs, even with stored efforts (treadmill and manual runs)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const outdoor = await computedRun(userId, { "5k": 1700 });
    await computedRun(userId, { "5k": 1500 }, { type: "treadmill_running", isIndoor: true });
    await computedRun(userId, { "5k": 1510 }, { type: "virtual_run", isIndoor: true });
    await computedRun(userId, { "5k": 1520 }, { isManual: true });

    const body = await personalBests(agent);

    expect(body.bests.map((best) => [best.distanceKey, best.timeS, best.activityId])).toEqual([
      ["5k", 1700, outdoor.id],
    ]);
  });

  it("hides a run edited since its efforts were computed and counts it as pending (edited activity)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const kept = await computedRun(userId, { "5k": 1700 });
    const edited = await computedRun(userId, { "5k": 1500 });
    // What the sync's upsert does when Garmin changes the run's distance or time.
    await db.update(activity).set({ bestEffortsVersion: null }).where(eq(activity.id, edited.id));

    const body = await personalBests(agent);

    expect(body.bests.map((best) => best.activityId)).toEqual([kept.id]);
    expect(body.pendingRuns).toBe(1);
  });

  it("keeps showing efforts from an older rule version while they wait to be recomputed", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const run = await computedRun(
      userId,
      { "1k": 290 },
      { bestEffortsVersion: BEST_EFFORTS_VERSION - 1 },
    );

    const body = await personalBests(agent);

    expect(body.bests.map((best) => best.activityId)).toEqual([run.id]);
    expect(body.pendingRuns).toBe(1);
  });

  it("counts only outdoor runs of 1 km or more still waiting as pending (partial backfill)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await computedRun(userId, { "1k": 300 });
    await createRun(userId, { garminActivityId: nextGarminId++ });
    await createRun(userId, { garminActivityId: nextGarminId++ });
    await createRun(userId, { garminActivityId: nextGarminId++, isIndoor: true });
    await createRun(userId, { garminActivityId: nextGarminId++, isManual: true });
    await createRun(userId, { garminActivityId: nextGarminId++, distanceM: 900 });

    const body = await personalBests(agent);

    expect(body.pendingRuns).toBe(2);
    expect(body.bests).toHaveLength(1);
  });

  it("returns no bests and Garmin as null for a runner before any effort or record", async () => {
    const agent = await signedInAgent(app);
    await connectGarmin(await ownerId());

    expect(await personalBests(agent)).toEqual({
      bests: [],
      garmin: null,
      pendingRuns: 0,
      checking: false,
      errorCode: null,
    });
  });

  it("returns Garmin's records as last stored, without calling Garmin", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId);
    const records: GarminRecord[] = [
      { distanceKey: "5k", timeS: 1625, achievedAt: "2026-09-13T06:00:00Z" },
    ];
    const fetchedAt = new Date("2026-10-01T12:00:00Z");
    await db
      .update(garminConnection)
      .set({ garminRecords: records, garminRecordsAt: fetchedAt })
      .where(eq(garminConnection.userId, userId));
    const series = vi.spyOn(garminClient, "series");

    const body = await personalBests(agent);

    expect(body.garmin).toEqual({ records, fetchedAt: fetchedAt.toISOString() });
    expect(series).not.toHaveBeenCalled();
  });

  it("counts a run Garmin failed to read 3 times as given up, not pending (one run failing)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId);
    await createRun(userId, {
      garminActivityId: nextGarminId++,
      bestEffortsAttempts: BEST_EFFORTS_MAX_ATTEMPTS,
    });
    await createRun(userId, {
      garminActivityId: nextGarminId++,
      bestEffortsAttempts: BEST_EFFORTS_MAX_ATTEMPTS - 1,
    });

    expect((await personalBests(agent)).pendingRuns).toBe(1);
  });

  it("never shows another runner's efforts", async () => {
    const agent = await signedInAgent(app);
    const other = await createUser("other@example.com");
    await computedRun(other, { "5k": 1400 });

    expect((await personalBests(agent)).bests).toEqual([]);
  });

  it("returns 401 problem+json without a session", async () => {
    const response = await request(app).get("/api/personal-bests");

    expectProblem(response, 401, "unauthorized");
  });
});

describe("GET /api/personal-bests checking and errorCode", () => {
  async function ownerWithPendingRun(
    connection: Parameters<typeof connectGarmin>[2] | "none" = {},
  ) {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    if (connection !== "none") await connectGarmin(userId, garminBundle(), connection);
    await createRun(userId, { garminActivityId: nextGarminId++ });
    return { agent, userId };
  }

  it("answers checking while a batch waits or runs, and no error, then not once it finished (backfill)", async () => {
    const { agent, userId } = await ownerWithPendingRun({ lastError: ErrorCode.garminUnavailable });
    const boss = getBoss();
    const queued = await boss.send(
      bestEffortsQueue.name,
      { userId },
      bestEffortsQueue.sendOptions({ userId }),
    );
    if (!queued) throw new Error("batch not queued");

    expect(await personalBests(agent)).toMatchObject({
      pendingRuns: 1,
      checking: true,
      errorCode: null,
    });

    const [active] = await boss.fetch(bestEffortsQueue.name);
    expect(active?.id).toBe(queued);
    expect(await personalBests(agent)).toMatchObject({ checking: true, errorCode: null });

    await boss.complete(bestEffortsQueue.name, queued);
    expect(await personalBests(agent)).toMatchObject({
      pendingRuns: 1,
      checking: false,
      errorCode: ErrorCode.garminUnavailable,
    });
  });

  it("answers checking with the error that holds a batch waiting for its retry (Garmin outage)", async () => {
    const { agent, userId } = await ownerWithPendingRun({ lastError: ErrorCode.garminUnavailable });
    const boss = getBoss();
    const queued = await boss.send(
      bestEffortsQueue.name,
      { userId },
      bestEffortsQueue.sendOptions({ userId }),
    );
    if (!queued) throw new Error("batch not queued");
    await boss.fetch(bestEffortsQueue.name);
    await boss.fail(bestEffortsQueue.name, queued);

    const [job] = await boss.findJobs(bestEffortsQueue.name, { id: queued });
    expect(job?.state).toBe("retry");
    expect(await personalBests(agent)).toMatchObject({
      pendingRuns: 1,
      checking: true,
      errorCode: ErrorCode.garminUnavailable,
    });
  });

  it("answers checking with garmin_rate_limited while a batch is deferred past a 429's hour (Garmin 429)", async () => {
    const { agent, userId } = await ownerWithPendingRun({ lastError: ErrorCode.garminRateLimited });
    // As the job defers itself on a 429.
    await getBoss().send(
      bestEffortsQueue.name,
      { userId },
      { ...bestEffortsQueue.sendOptions({ userId }), startAfter: 3600 },
    );

    expect(await personalBests(agent)).toMatchObject({
      pendingRuns: 1,
      checking: true,
      errorCode: ErrorCode.garminRateLimited,
    });
  });

  it("answers checking without an error while a chained batch waits its 30 s turn, whatever the last error (backfill)", async () => {
    const { agent, userId } = await ownerWithPendingRun({ lastError: ErrorCode.garminUnavailable });
    await getBoss().send(
      bestEffortsQueue.name,
      { userId },
      { ...bestEffortsQueue.sendOptions({ userId }), startAfter: 30 },
    );

    expect(await personalBests(agent)).toMatchObject({
      pendingRuns: 1,
      checking: true,
      errorCode: null,
    });
  });

  it("counts a run waiting out its 6 h after a failed try as pending, with no batch and no error (one run failing)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId);
    await createRun(userId, {
      garminActivityId: nextGarminId++,
      bestEffortsAttempts: 1,
      bestEffortsFailedAt: new Date(),
    });

    expect(await personalBests(agent)).toMatchObject({
      pendingRuns: 1,
      checking: false,
      errorCode: null,
    });
  });

  it("reads the runs after asking pg-boss, so a batch that finished in between leaves nothing pending without a batch (read order)", async () => {
    const { agent, userId } = await ownerWithPendingRun({ lastError: ErrorCode.garminUnavailable });
    const boss = getBoss();
    const findJobs = boss.findJobs.bind(boss);
    // The batch finishes while pg-boss is asked: its job is gone and its run computed.
    vi.spyOn(boss, "findJobs").mockImplementation(async (name, options) => {
      const jobs = await findJobs(name, options);
      await db
        .update(activity)
        .set({ bestEffortsVersion: BEST_EFFORTS_VERSION })
        .where(eq(activity.userId, userId));
      return jobs;
    });

    expect(await personalBests(agent)).toMatchObject({
      pendingRuns: 0,
      checking: false,
      errorCode: null,
    });
  });

  it.each([
    ["no Garmin connection", "none", ErrorCode.garminNotConnected],
    ["an expired login (token expiry)", { status: "expired" }, ErrorCode.garminAuthExpired],
    [
      "an expired login whatever the last error",
      { status: "expired", lastError: ErrorCode.garminUnavailable },
      ErrorCode.garminAuthExpired,
    ],
    [
      "the last error (Garmin outage)",
      { lastError: ErrorCode.garminUnavailable },
      ErrorCode.garminUnavailable,
    ],
    ["a 429 (Garmin 429)", { lastError: ErrorCode.garminRateLimited }, ErrorCode.garminRateLimited],
    ["a last error that is no code of the app's", { lastError: "something_else" }, null],
    ["a working login with no error", {}, null],
  ] as const)("answers why pending runs have no batch: %s", async (_, connection, errorCode) => {
    const { agent } = await ownerWithPendingRun(connection);

    expect(await personalBests(agent)).toMatchObject({
      pendingRuns: 1,
      checking: false,
      errorCode,
    });
  });

  it("answers no error when nothing is pending, whatever the connection says", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle(), { status: "expired" });
    await createRun(userId, {
      garminActivityId: nextGarminId++,
      bestEffortsVersion: BEST_EFFORTS_VERSION,
    });

    expect(await personalBests(agent)).toMatchObject({
      pendingRuns: 0,
      checking: false,
      errorCode: null,
    });
  });

  it("never answers checking for another runner's batch", async () => {
    const { agent } = await ownerWithPendingRun();
    const other = await createUser("other@example.com");
    await getBoss().send(
      bestEffortsQueue.name,
      { userId: other },
      bestEffortsQueue.sendOptions({ userId: other }),
    );

    expect(await personalBests(agent)).toMatchObject({ checking: false, errorCode: null });
  });
});
