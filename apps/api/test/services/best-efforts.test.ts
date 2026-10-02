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
import {
  BEST_EFFORTS_MAX_ATTEMPTS,
  computeBestEffortsBatch,
  queueBestEfforts,
  queuePendingBestEfforts,
} from "../../src/services/best-efforts";
import { syncGarmin, upsertActivities } from "../../src/services/garmin-sync";
import { importHistoryPage } from "../../src/services/history-import";
import {
  connectGarmin,
  createRun,
  createUser,
  garminBundle,
  seedImport,
  setGarminBundle,
} from "../seed";

// The best-efforts service on the real Postgres, against the Garmin service in fixture mode, which serves
// its one detail fixture (16.67 km in 6532 timer seconds) for any run of the fixture account, no samples
// for its manual entries, a 404 ("gone") for any other id, and fails every read of UNREADABLE and
// UNREADABLE_TOO as a 503 after the library's retries ("failed"); after two failures in a row it asks about
// no further run ("skipped"). pg-boss runs with the best-efforts queue but no worker, so a queued batch
// stays visible.

// Runs of the fixture account, newest first in the rows below.
const LONG_RUN = 10_000_000_007;
const RACE = 10_000_000_002;
const TREADMILL = 10_000_000_006;
const MANUAL = 10_000_000_003;
const VIRTUAL = 9_000_000_023;
const SHORT = 9_000_000_041;
// FAKE_UNAVAILABLE_ACTIVITY_IDS in services/garmin fake_client.py: Garmin down for these runs alone.
const UNREADABLE = 9_000_000_503;
const UNREADABLE_TOO = 9_000_000_504;
// The fixture account's manual entries: stored here as device runs, Garmin answers them without samples.
const MANUAL_ENTRIES = [10_000_000_003, 9_000_000_027];
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

/**
 * Lets every series call through to the fixture service, then answers the runs from `index` on as skipped,
 * as the service does once its time budget has passed.
 */
function skipRunsFrom(index: number): void {
  const original = garminClient.series.bind(garminClient);
  vi.spyOn(garminClient, "series").mockImplementation(async (request, options) => {
    const response = await original(request, options);
    return {
      ...response,
      series: response.series.map((series, position) =>
        position < index
          ? series
          : { ...series, outcome: "skipped" as const, elapsedS: [], distanceM: [] },
      ),
      records: null,
    };
  });
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

async function stateOf(activityId: string) {
  const [row] = await db
    .select({ version: activity.bestEffortsVersion, attempts: activity.bestEffortsAttempts })
    .from(activity)
    .where(eq(activity.id, activityId));
  if (!row) throw new Error("no such run");
  return row;
}

/** An outdoor run of August, older than every run createRuns makes. */
async function createOlderRun(userId: string, garminActivityId: number, day: number) {
  return createRun(userId, {
    garminActivityId,
    startUtc: new Date(Date.UTC(2026, 7, day, 6)),
    startLocal: `2026-08-${String(day).padStart(2, "0")} 08:00:00`,
  });
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

    expect(result).toEqual({ processed: 2, failed: 0, skipped: 0, remaining: 0 });
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

    expect(result).toEqual({ processed: 0, failed: 0, skipped: 0, remaining: 0 });
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

    expect(result).toEqual({ processed: 2, failed: 0, skipped: 0, remaining: 0 });
    expect(await effortsOf(ids)).toEqual(before);
    expect(before).toHaveLength(2 * FIXTURE_DISTANCES.length);
  });

  it("marks a run Garmin no longer has done with no efforts and clears its failed attempts (deleted run)", async () => {
    const userId = await connectedUser();
    const [gone, kept] = await createRuns(userId, [12_345, LONG_RUN]);
    if (!gone || !kept) throw new Error("runs missing");
    await db.update(activity).set({ bestEffortsAttempts: 2 }).where(eq(activity.id, gone.id));

    const result = await computeBestEffortsBatch(userId);

    expect(result).toEqual({ processed: 2, failed: 0, skipped: 0, remaining: 0 });
    expect(await stateOf(gone.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    expect(await effortsOf([gone.id])).toEqual([]);
    expect(await effortsOf([kept.id])).toHaveLength(FIXTURE_DISTANCES.length);
  });

  it("marks the runs Garmin read and counts an attempt for the one it could not, which goes last and is given up after 3 (one run failing)", async () => {
    const userId = await connectedUser();
    const [unreadable, longRun, race] = await createRuns(userId, [UNREADABLE, LONG_RUN, RACE]);
    if (!unreadable || !longRun || !race) throw new Error("runs missing");
    const calls = recordSeriesCalls();

    expect(await computeBestEffortsBatch(userId)).toEqual({
      processed: 2,
      failed: 1,
      skipped: 0,
      remaining: 1,
    });

    expect(await stateOf(unreadable.id)).toEqual({ version: null, attempts: 1 });
    for (const run of [longRun, race]) {
      expect(await stateOf(run.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
      expect(await effortsOf([run.id])).toHaveLength(FIXTURE_DISTANCES.length);
    }
    expect(await effortsOf([unreadable.id])).toEqual([]);
    // Garmin answered for the others, so the login is working.
    expect((await connection(userId)).lastError).toBeNull();

    // Older runs keep arriving (an import page each time): each goes before the run that failed.
    for (const [round, garminActivityId] of HISTORY_RUNS.slice(0, 2).entries()) {
      await createOlderRun(userId, garminActivityId, 10 - round);
      expect(await computeBestEffortsBatch(userId)).toEqual({
        processed: 1,
        failed: 1,
        skipped: 0,
        remaining: round === 0 ? 1 : 0,
      });
    }

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [UNREADABLE, LONG_RUN, RACE],
      [HISTORY_RUNS[0], UNREADABLE],
      [HISTORY_RUNS[1], UNREADABLE],
    ]);
    expect(await stateOf(unreadable.id)).toEqual({
      version: null,
      attempts: BEST_EFFORTS_MAX_ATTEMPTS,
    });
    // Given up: no longer pending, fetched or queued.
    expect(await computeBestEffortsBatch(userId)).toEqual({
      processed: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
    });
    expect(calls).toHaveLength(3);
    expect(await queueBestEfforts(userId)).toBeNull();
  });

  it("rejects with garmin_unavailable, writes nothing and records the error when Garmin is down, and a later batch computes the runs (Garmin outage)", async () => {
    const userId = await connectedUser(garminBundle("unavailable"));
    const runs = await createRuns(userId, [LONG_RUN, RACE]);
    const ids = runs.map((run) => run.id);

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    for (const id of ids) expect(await stateOf(id)).toEqual({ version: null, attempts: 0 });
    expect(await effortsOf(ids)).toEqual([]);
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminUnavailable);

    await setGarminBundle(userId, garminBundle());

    expect(await computeBestEffortsBatch(userId)).toEqual({
      processed: 2,
      failed: 0,
      skipped: 0,
      remaining: 0,
    });
    for (const id of ids) {
      expect(await stateOf(id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    }
    expect(await effortsOf(ids)).toHaveLength(2 * FIXTURE_DISTANCES.length);
    expect((await connection(userId)).lastError).toBeNull();
  });

  it("rejects with garmin_unavailable and changes no attempt when every run in the batch fails, keeping a rotated bundle (whole batch failed)", async () => {
    const userId = await connectedUser(garminBundle("rotate"));
    const [run] = await createRuns(userId, [UNREADABLE]);
    if (!run) throw new Error("run missing");

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
    const stored = await connection(userId);
    expect(stored.lastError).toBe(ErrorCode.garminUnavailable);
    expect(JSON.parse(decrypt(stored.tokenBundleEnc, userId))).toMatchObject({
      fixture: "rotated",
    });
  });

  it("counts an attempt for the runs Garmin failed on and leaves the runs the service skipped after them untouched, which a later batch computes (partial batch)", async () => {
    const userId = await connectedUser();
    const [longRun, unreadable, unreadableToo, race] = await createRuns(userId, [
      LONG_RUN,
      UNREADABLE,
      UNREADABLE_TOO,
      RACE,
    ]);
    if (!longRun || !unreadable || !unreadableToo || !race) throw new Error("runs missing");
    const calls = recordSeriesCalls();

    expect(await computeBestEffortsBatch(userId)).toEqual({
      processed: 1,
      failed: 2,
      skipped: 1,
      remaining: 3,
    });

    expect(await stateOf(longRun.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    expect(await effortsOf([longRun.id])).toHaveLength(FIXTURE_DISTANCES.length);
    for (const run of [unreadable, unreadableToo]) {
      expect(await stateOf(run.id)).toEqual({ version: null, attempts: 1 });
    }
    // Never asked about: still pending, no attempt counted, nothing written.
    expect(await stateOf(race.id)).toEqual({ version: null, attempts: 0 });
    expect(await effortsOf([race.id, unreadable.id, unreadableToo.id])).toEqual([]);
    // The service stopped before the records call, so none are stored.
    expect(await connection(userId)).toMatchObject({
      lastError: null,
      garminRecords: null,
      garminRecordsAt: null,
    });

    // The skipped run has no failed attempt, so it goes before the runs that failed.
    expect(await computeBestEffortsBatch(userId)).toEqual({
      processed: 1,
      failed: 2,
      skipped: 0,
      remaining: 2,
    });

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [LONG_RUN, UNREADABLE, UNREADABLE_TOO, RACE],
      [RACE, UNREADABLE, UNREADABLE_TOO],
    ]);
    expect(await stateOf(race.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    expect(await effortsOf([race.id])).toHaveLength(FIXTURE_DISTANCES.length);
    for (const run of [unreadable, unreadableToo]) {
      expect(await stateOf(run.id)).toEqual({ version: null, attempts: 2 });
    }
  });

  it("rejects with garmin_unavailable and changes no attempt when the only answers are failed and skipped runs (Garmin outage)", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, [UNREADABLE, UNREADABLE_TOO, LONG_RUN, RACE]);
    const ids = runs.map((run) => run.id);
    const calls = recordSeriesCalls();

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [UNREADABLE, UNREADABLE_TOO, LONG_RUN, RACE],
    ]);
    for (const id of ids) expect(await stateOf(id)).toEqual({ version: null, attempts: 0 });
    expect(await effortsOf(ids)).toEqual([]);
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminUnavailable);
  });

  it("counts a lone run that failed before as failing again rather than an outage, so the last pending run is given up (one run failing)", async () => {
    const userId = await connectedUser();
    const [run] = await createRuns(userId, [UNREADABLE]);
    if (!run) throw new Error("run missing");
    await db.update(activity).set({ bestEffortsAttempts: 1 }).where(eq(activity.id, run.id));

    expect(await computeBestEffortsBatch(userId)).toEqual({
      processed: 0,
      failed: 1,
      skipped: 0,
      remaining: 1,
    });
    expect(await computeBestEffortsBatch(userId)).toEqual({
      processed: 0,
      failed: 1,
      skipped: 0,
      remaining: 0,
    });

    expect(await stateOf(run.id)).toEqual({ version: null, attempts: BEST_EFFORTS_MAX_ATTEMPTS });
    expect((await connection(userId)).lastError).toBeNull();
  });

  it("rejects with garmin_unavailable and marks nothing when several runs all come back without samples (details endpoint moved)", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, MANUAL_ENTRIES);

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    for (const run of runs) expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminUnavailable);
  });

  it("rejects with garmin_unavailable when the runs Garmin was asked about all came back without samples and the rest were skipped (details endpoint moved)", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, [...MANUAL_ENTRIES, LONG_RUN]);
    skipRunsFrom(MANUAL_ENTRIES.length);

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    for (const run of runs) expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
  });

  it("rejects with garmin_unavailable and counts no attempt for a lone run that failed before when the service skipped it (Garmin outage)", async () => {
    const userId = await connectedUser();
    const [run] = await createRuns(userId, [UNREADABLE]);
    if (!run) throw new Error("run missing");
    await db.update(activity).set({ bestEffortsAttempts: 1 }).where(eq(activity.id, run.id));
    skipRunsFrom(0);

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    expect(await stateOf(run.id)).toEqual({ version: null, attempts: 1 });
  });

  it("marks a lone run Garmin holds no samples for done with no efforts", async () => {
    const userId = await connectedUser();
    const [run] = await createRuns(userId, MANUAL_ENTRIES.slice(0, 1));
    if (!run) throw new Error("run missing");

    expect(await computeBestEffortsBatch(userId)).toEqual({
      processed: 1,
      failed: 0,
      skipped: 0,
      remaining: 0,
    });

    expect(await stateOf(run.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    expect(await effortsOf([run.id])).toEqual([]);
  });

  it("takes the newest pending runs first and fetches Garmin's records only with the batch that empties the list", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, HISTORY_RUNS);
    const calls = recordSeriesCalls();

    const first = await computeBestEffortsBatch(userId);

    expect(first).toEqual({
      processed: GARMIN_SERIES_BATCH_MAX,
      failed: 0,
      skipped: 0,
      remaining: 2,
    });
    expect(calls[0]).toEqual({
      garminActivityIds: HISTORY_RUNS.slice(0, GARMIN_SERIES_BATCH_MAX),
      includeRecords: false,
    });
    expect(await connection(userId)).toMatchObject({ garminRecords: null, garminRecordsAt: null });

    const second = await computeBestEffortsBatch(userId);

    expect(second).toEqual({ processed: 2, failed: 0, skipped: 0, remaining: 0 });
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

    expect(await computeBestEffortsBatch(userId)).toEqual({
      processed: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
    });
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
    "clears the version and failed attempts when Garmin changes the run's %s, so its efforts are hidden and recomputed (edited activity)",
    async (_, change) => {
      const userId = await createUser();
      const run = await computedRun(userId);
      await db
        .update(activity)
        .set({ bestEffortsAttempts: BEST_EFFORTS_MAX_ATTEMPTS })
        .where(eq(activity.id, run.id));

      expect(await upsertActivities(userId, [summary(change)])).toBe(1);

      expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
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

  it("queues a batch at boot for each user with pending runs and none for a user without (deploy with pending runs)", async () => {
    const pendingUser = await connectedUser();
    await createRuns(pendingUser, [LONG_RUN, RACE]);
    const doneUser = await createUser("done@example.com");
    await createRun(doneUser, { bestEffortsVersion: BEST_EFFORTS_VERSION });
    const givenUpUser = await createUser("given-up@example.com");
    await createRun(givenUpUser, { bestEffortsAttempts: BEST_EFFORTS_MAX_ATTEMPTS });
    const treadmillUser = await createUser("treadmill@example.com");
    await createRun(treadmillUser, { garminActivityId: TREADMILL, isIndoor: true });

    expect(await queuePendingBestEfforts()).toBe(1);

    expect(await queuedBatches(pendingUser)).toHaveLength(1);
    for (const userId of [doneUser, givenUpUser, treadmillUser]) {
      expect(await queuedBatches(userId)).toEqual([]);
    }
  });

  it("resolves at boot when pg-boss cannot take the batch, and the next sync queues it", async () => {
    const userId = await connectedUser();
    vi.spyOn(getBoss(), "send").mockRejectedValueOnce(new Error("pg-boss is down"));
    await createRuns(userId, [LONG_RUN]);

    expect(await queuePendingBestEfforts()).toBe(0);

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
