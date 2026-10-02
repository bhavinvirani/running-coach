import { BEST_EFFORTS_VERSION, bestEfforts } from "@running-coach/engine";
import {
  ErrorCode,
  GARMIN_SERIES_BATCH_MAX,
  type GarminActivitySummary,
  type GarminSeriesRequest,
} from "@running-coach/shared";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, bestEffort, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as bestEffortsQueue from "../../src/jobs/best-efforts-queue";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import { decrypt } from "../../src/lib/crypto";
import { computeBestEffortsBatch, queueBestEfforts } from "../../src/services/best-efforts";
import { syncGarmin, upsertActivities } from "../../src/services/garmin-sync";
import { importHistoryPage } from "../../src/services/history-import";
import { connectGarmin, createRun, createUser, garminBundle, seedImport } from "../seed";

// The best-efforts service on the real Postgres, against the Garmin service in fixture mode, which serves
// its one detail fixture (16.67 km in 6532 timer seconds) for any run of the fixture account and a 404 for
// any other id. pg-boss runs with the best-efforts queue but no worker, so a queued batch stays visible.

// Runs of the fixture account, newest first in the rows below.
const LONG_RUN = 10_000_000_007;
const RACE = 10_000_000_002;
const TREADMILL = 10_000_000_006;
const MANUAL = 10_000_000_003;
const VIRTUAL = 9_000_000_023;
const SHORT = 9_000_000_041;
// Twelve outdoor runs of the fixture account's history, for more than one batch.
const HISTORY_RUNS = [
  9_000_000_042, 9_000_000_039, 9_000_000_037, 9_000_000_035, 9_000_000_034, 9_000_000_033,
  9_000_000_032, 9_000_000_030, 9_000_000_029, 9_000_000_028, 9_000_000_026, 9_000_000_024,
];
// The distances the fixture's 16.67 km reach, shortest first.
const FIXTURE_DISTANCES = ["1k", "1mi", "2mi", "5k", "5mi", "10k", "15k", "10mi"];
const NOW = new Date("2026-09-28T10:00:00Z");

async function connectedUser(bundle = garminBundle()): Promise<string> {
  const userId = await createUser();
  await connectGarmin(userId, bundle);
  return userId;
}

/** One outdoor run per id, a day apart, the first newest. */
async function createRuns(userId: string, ids: readonly number[]) {
  const runs = [];
  for (const [index, garminActivityId] of ids.entries()) {
    runs.push(
      await createRun(userId, {
        garminActivityId,
        startUtc: new Date(Date.UTC(2026, 8, 27 - index, 6)),
        startLocal: `2026-09-${String(27 - index).padStart(2, "0")} 08:00:00`,
      }),
    );
  }
  return runs;
}

/** Lets every series call through to the fixture service and records what was asked. */
function recordSeriesCalls(): Omit<GarminSeriesRequest, "tokenBundle">[] {
  const original = garminClient.series.bind(garminClient);
  const calls: Omit<GarminSeriesRequest, "tokenBundle">[] = [];
  vi.spyOn(garminClient, "series").mockImplementation(async (request, options) => {
    calls.push({
      garminActivityIds: request.garminActivityIds,
      includeRecords: request.includeRecords,
    });
    return original(request, options);
  });
  return calls;
}

async function effortsOf(activityIds: string[]) {
  return db
    .select({
      activityId: bestEffort.activityId,
      distanceKey: bestEffort.distanceKey,
      timeS: bestEffort.timeS,
      startS: bestEffort.startS,
    })
    .from(bestEffort)
    .where(inArray(bestEffort.activityId, activityIds))
    .orderBy(asc(bestEffort.activityId), asc(bestEffort.timeS));
}

async function versionOf(activityId: string): Promise<number | null> {
  const [row] = await db
    .select({ version: activity.bestEffortsVersion })
    .from(activity)
    .where(eq(activity.id, activityId));
  if (!row) throw new Error("no such run");
  return row.version;
}

async function connection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection");
  return row;
}

/** The fixture series as the service answers it, and the efforts the engine finds in it. */
async function fixtureEfforts() {
  const response = await garminClient.series(
    { tokenBundle: garminBundle(), garminActivityIds: [LONG_RUN], includeRecords: false },
    { onTokenBundle: () => Promise.resolve() },
  );
  const [series] = response.series;
  if (!series) throw new Error("no series");
  return bestEfforts(series);
}

async function queuedBatches(userId: string): Promise<string[]> {
  const jobs = await getBoss().findJobs(bestEffortsQueue.name, { key: userId, queued: true });
  return jobs.map((job) => job.id);
}

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

describe("computeBestEffortsBatch", () => {
  it("stores the engine's efforts for outdoor runs and marks them, never sending treadmill, indoor, manual or sub-1 km runs", async () => {
    const userId = await connectedUser();
    const [longRun, race] = await createRuns(userId, [LONG_RUN, RACE]);
    const skipped = [
      await createRun(userId, {
        garminActivityId: TREADMILL,
        type: "treadmill_running",
        isIndoor: true,
      }),
      await createRun(userId, { garminActivityId: VIRTUAL, type: "virtual_run", isIndoor: true }),
      await createRun(userId, { garminActivityId: MANUAL, isManual: true }),
      await createRun(userId, { garminActivityId: SHORT, distanceM: 999.9, durationS: 330 }),
    ];
    if (!longRun || !race) throw new Error("runs missing");
    const calls = recordSeriesCalls();

    const result = await computeBestEffortsBatch(userId);

    expect(result).toEqual({ processed: 2, remaining: 0 });
    expect(calls).toEqual([{ garminActivityIds: [LONG_RUN, RACE], includeRecords: true }]);
    const expected = await fixtureEfforts();
    expect(expected.map((effort) => effort.distanceKey)).toEqual(FIXTURE_DISTANCES);
    for (const run of [longRun, race]) {
      expect(await versionOf(run.id)).toBe(BEST_EFFORTS_VERSION);
      const stored = await effortsOf([run.id]);
      expect(stored).toEqual(
        expected
          .map((effort) => ({ activityId: run.id, ...effort }))
          .sort((a, b) => a.timeS - b.timeS),
      );
    }
    for (const run of skipped) {
      expect(await versionOf(run.id)).toBeNull();
    }
    expect(await effortsOf(skipped.map((run) => run.id))).toEqual([]);
  });

  it("writes nothing and calls no one on a second run (a job firing twice)", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, [LONG_RUN, RACE]);
    await computeBestEffortsBatch(userId);
    const ids = runs.map((run) => run.id);
    const before = await db.select().from(bestEffort).where(inArray(bestEffort.activityId, ids));
    const calls = recordSeriesCalls();

    const result = await computeBestEffortsBatch(userId);

    expect(result).toEqual({ processed: 0, remaining: 0 });
    expect(calls).toEqual([]);
    expect(await db.select().from(bestEffort).where(inArray(bestEffort.activityId, ids))).toEqual(
      before,
    );
  });

  it("writes the same efforts again when a run is recomputed (idempotent recompute)", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, [LONG_RUN, RACE]);
    const ids = runs.map((run) => run.id);
    await computeBestEffortsBatch(userId);
    const before = await effortsOf(ids);
    // An older rule version: every run is pending again.
    await db
      .update(activity)
      .set({ bestEffortsVersion: BEST_EFFORTS_VERSION - 1 })
      .where(eq(activity.userId, userId));

    const result = await computeBestEffortsBatch(userId);

    expect(result).toEqual({ processed: 2, remaining: 0 });
    expect(await effortsOf(ids)).toEqual(before);
    expect(before).toHaveLength(2 * FIXTURE_DISTANCES.length);
  });

  it("marks a run Garmin no longer has done with no efforts (deleted run)", async () => {
    const userId = await connectedUser();
    const [gone, kept] = await createRuns(userId, [12_345, LONG_RUN]);
    if (!gone || !kept) throw new Error("runs missing");

    const result = await computeBestEffortsBatch(userId);

    expect(result).toEqual({ processed: 2, remaining: 0 });
    expect(await versionOf(gone.id)).toBe(BEST_EFFORTS_VERSION);
    expect(await effortsOf([gone.id])).toEqual([]);
    expect(await effortsOf([kept.id])).toHaveLength(FIXTURE_DISTANCES.length);
  });

  it("takes the newest pending runs first and fetches Garmin's records only with the batch that empties the list", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, HISTORY_RUNS);
    const calls = recordSeriesCalls();

    const first = await computeBestEffortsBatch(userId);

    expect(first).toEqual({ processed: GARMIN_SERIES_BATCH_MAX, remaining: 2 });
    expect(calls[0]).toEqual({
      garminActivityIds: HISTORY_RUNS.slice(0, GARMIN_SERIES_BATCH_MAX),
      includeRecords: false,
    });
    expect(await connection(userId)).toMatchObject({ garminRecords: null, garminRecordsAt: null });

    const second = await computeBestEffortsBatch(userId);

    expect(second).toEqual({ processed: 2, remaining: 0 });
    expect(calls[1]).toEqual({
      garminActivityIds: HISTORY_RUNS.slice(GARMIN_SERIES_BATCH_MAX),
      includeRecords: true,
    });
    const stored = await connection(userId);
    expect(stored.garminRecords?.map((record) => record.distanceKey)).toEqual([
      "1k",
      "1mi",
      "5k",
      "10k",
      "half",
    ]);
    expect(stored.garminRecords?.[0]).toEqual({
      distanceKey: "1k",
      timeS: 288.41,
      achievedAt: "2026-09-20T06:30:00Z",
    });
    expect(Date.now() - (stored.garminRecordsAt?.getTime() ?? 0)).toBeLessThan(60_000);
    for (const run of runs) expect(await versionOf(run.id)).toBe(BEST_EFFORTS_VERSION);
  });

  it("processes each pending run once when two batches overlap (overlapping jobs)", async () => {
    const userId = await connectedUser();
    await createRuns(userId, [LONG_RUN, RACE, 10_000_000_005]);
    const calls = recordSeriesCalls();

    const results = await Promise.all([
      computeBestEffortsBatch(userId),
      computeBestEffortsBatch(userId),
    ]);

    expect(results.map((result) => result.processed).sort()).toEqual([0, 3]);
    expect(calls).toHaveLength(1);
    expect(await db.select().from(bestEffort)).toHaveLength(3 * FIXTURE_DISTANCES.length);
  });

  it("writes back a bundle Garmin rotated (rotated token)", async () => {
    const userId = await connectedUser(garminBundle("rotate"));
    await createRuns(userId, [LONG_RUN]);

    await computeBestEffortsBatch(userId);

    const stored = await connection(userId);
    expect(JSON.parse(decrypt(stored.tokenBundleEnc, userId))).toMatchObject({
      fixture: "rotated",
    });
  });

  it("keeps the runs pending and records the failure when Garmin answers 429 (Garmin 429)", async () => {
    const userId = await connectedUser(garminBundle("rate_limited"));
    const [run] = await createRuns(userId, [LONG_RUN]);
    if (!run) throw new Error("run missing");

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminRateLimited,
      retryAfterSeconds: 3600,
    });

    expect(await versionOf(run.id)).toBeNull();
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminRateLimited);
  });

  it("refuses without calling Garmin in the hour after a 429 (Garmin 429)", async () => {
    const userId = await connectedUser();
    await createRuns(userId, [LONG_RUN]);
    await db
      .update(garminConnection)
      .set({ lastError: ErrorCode.garminRateLimited })
      .where(eq(garminConnection.userId, userId));
    const calls = recordSeriesCalls();

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminRateLimited,
    });
    expect(calls).toEqual([]);
  });

  it("throws garmin_auth_expired and stores nothing when Garmin rejects the login (token expiry)", async () => {
    const userId = await connectedUser(garminBundle("expired"));
    const [run] = await createRuns(userId, [LONG_RUN]);
    if (!run) throw new Error("run missing");

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminAuthExpired,
    });

    expect(await versionOf(run.id)).toBeNull();
    expect(await db.select().from(bestEffort)).toEqual([]);
  });

  it("returns at once without a Garmin connection when nothing is pending", async () => {
    const userId = await createUser();

    expect(await computeBestEffortsBatch(userId)).toEqual({ processed: 0, remaining: 0 });
  });
});

describe("upsertActivities and best_efforts_version", () => {
  function summary(values: Partial<GarminActivitySummary> = {}): GarminActivitySummary {
    return {
      garminActivityId: LONG_RUN,
      type: "running",
      startUtc: "2026-09-27T06:00:00Z",
      startLocal: "2026-09-27T08:00:00",
      tz: null,
      distanceM: 18_000,
      durationS: 6120,
      avgHr: 148,
      maxHr: 166,
      cadence: 168,
      calories: 1150,
      elevationGainM: 142,
      isIndoor: false,
      isManual: false,
      eventType: "uncategorized",
      ...values,
    };
  }

  async function computedRun(userId: string) {
    await upsertActivities(userId, [summary()]);
    await db
      .update(activity)
      .set({ bestEffortsVersion: BEST_EFFORTS_VERSION })
      .where(eq(activity.userId, userId));
    const [row] = await db.select().from(activity).where(eq(activity.userId, userId));
    if (!row) throw new Error("no run");
    return row;
  }

  it.each([
    ["distance", { distanceM: 17_400 }],
    ["timer time", { durationS: 5900 }],
  ])(
    "clears the version when Garmin changes the run's %s, so its efforts are hidden and recomputed (edited activity)",
    async (_, change) => {
      const userId = await createUser();
      const run = await computedRun(userId);

      expect(await upsertActivities(userId, [summary(change)])).toBe(1);

      expect(await versionOf(run.id)).toBeNull();
    },
  );

  it("keeps the version when another field changes (edited activity)", async () => {
    const userId = await createUser();
    const run = await computedRun(userId);

    expect(await upsertActivities(userId, [summary({ eventType: "race", avgHr: 150 })])).toBe(1);

    expect(await versionOf(run.id)).toBe(BEST_EFFORTS_VERSION);
  });

  it("keeps the version when the run arrives unchanged (duplicate activities)", async () => {
    const userId = await createUser();
    const run = await computedRun(userId);

    expect(await upsertActivities(userId, [summary()])).toBe(0);

    expect(await versionOf(run.id)).toBe(BEST_EFFORTS_VERSION);
  });
});

describe("queueing best efforts", () => {
  it("queues one batch after a sync stores runs that are pending", async () => {
    const userId = await connectedUser();

    const result = await syncGarmin({ userId, now: NOW });

    expect(result.activitiesWritten).toBe(7);
    expect(await queuedBatches(userId)).toHaveLength(1);
    // A second sync folds into the waiting batch.
    await syncGarmin({ userId, now: NOW });
    expect(await queuedBatches(userId)).toHaveLength(1);
  });

  it("queues one batch after an import page stores runs that are pending", async () => {
    const userId = await connectedUser();
    await seedImport(userId);

    const page = await importHistoryPage({ userId, pageSize: 10 });

    expect(page.status).toBe("continued");
    expect(await queuedBatches(userId)).toHaveLength(1);
  });

  it("queues nothing when no run is pending", async () => {
    const userId = await connectedUser();
    await createRun(userId, { garminActivityId: TREADMILL, isIndoor: true });
    await createRun(userId, {
      garminActivityId: LONG_RUN,
      bestEffortsVersion: BEST_EFFORTS_VERSION,
    });

    expect(await queueBestEfforts(userId)).toBeNull();
    expect(await queuedBatches(userId)).toEqual([]);
  });

  it("finishes the sync when the batch cannot be queued, and the next sync queues it", async () => {
    const userId = await connectedUser();
    vi.spyOn(getBoss(), "send").mockRejectedValueOnce(new Error("pg-boss is down"));

    const result = await syncGarmin({ userId, now: NOW });

    expect(result.activitiesWritten).toBe(7);
    expect(await queuedBatches(userId)).toEqual([]);
    await syncGarmin({ userId, now: NOW });
    expect(await queuedBatches(userId)).toHaveLength(1);
  });

  it("queues nothing after a failed sync", async () => {
    const userId = await connectedUser(garminBundle("expired"));
    await createRuns(userId, [LONG_RUN]);

    await expect(syncGarmin({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminAuthExpired,
    });

    expect(await queuedBatches(userId)).toEqual([]);
  });
});
