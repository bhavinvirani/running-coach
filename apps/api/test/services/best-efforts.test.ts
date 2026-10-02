import { BEST_EFFORTS_VERSION, bestEfforts } from "@running-coach/engine";
import {
  ErrorCode,
  GARMIN_SERIES_BATCH_MAX,
  type GarminActivitySummary,
  type GarminSeriesRequest,
} from "@running-coach/shared";
import { asc, eq, inArray } from "drizzle-orm";
import type { SendOptions } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, bestEffort, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as bestEffortsQueue from "../../src/jobs/best-efforts-queue";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import { decrypt } from "../../src/lib/crypto";
import {
  BEST_EFFORTS_MAX_ATTEMPTS,
  BEST_EFFORTS_RETRY_AFTER_S,
  computeBestEffortsBatch,
  getPersonalBests,
  getRunBestEfforts,
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
  storedImport,
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
// Ids outside the fixture account: Garmin answers 404, "gone".
const GONE = 12_345;
const GONE_TOO = 12_346;
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

type SeriesCall = Omit<GarminSeriesRequest, "tokenBundle">;

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

/**
 * A run computed at the current rule with one stored effort, in August, older than every run createRuns
 * makes: the user's canary. Garmin's answer for it is whatever the fixture service gives its id.
 */
async function createCanary(userId: string, garminActivityId = LONG_RUN, day = 20) {
  const run = await createRun(userId, {
    garminActivityId,
    startUtc: new Date(Date.UTC(2026, 7, day, 6)),
    startLocal: `2026-08-${String(day).padStart(2, "0")} 08:00:00`,
    bestEffortsVersion: BEST_EFFORTS_VERSION,
  });
  await db
    .insert(bestEffort)
    .values({ userId, activityId: run.id, distanceKey: "1k", timeS: 300, startS: 0 });
  return run;
}

/** Lets every series call through to the fixture service and records what was asked. */
function recordSeriesCalls(): SeriesCall[] {
  const original = garminClient.series.bind(garminClient);
  const calls: SeriesCall[] = [];
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

/**
 * More unreadable runs than the fixture's two: answers these ids "failed" as the service does for a run
 * Garmin cannot read, and, as the service does after two failures in a row, every run after them
 * "skipped" with no records; the runs it would still ask about go to the fixture service. Records what
 * was asked.
 */
function unreadableRuns(ids: readonly number[]): SeriesCall[] {
  const original = garminClient.series.bind(garminClient);
  const calls: SeriesCall[] = [];
  vi.spyOn(garminClient, "series").mockImplementation(async (request, options) => {
    calls.push({
      garminActivityIds: request.garminActivityIds,
      includeRecords: request.includeRecords,
    });
    const outcomes = new Map<number, "failed" | "skipped">();
    let failedInARow = 0;
    for (const id of request.garminActivityIds) {
      if (failedInARow >= 2) {
        outcomes.set(id, "skipped");
      } else if (ids.includes(id)) {
        outcomes.set(id, "failed");
        failedInARow += 1;
      } else {
        failedInARow = 0;
      }
    }
    const response = await original(
      {
        ...request,
        garminActivityIds: request.garminActivityIds.filter((id) => !outcomes.has(id)),
        includeRecords: request.includeRecords && failedInARow < 2,
      },
      options,
    );
    return {
      ...response,
      series: request.garminActivityIds.map(
        (id) =>
          response.series.find((series) => series.garminActivityId === id) ?? {
            garminActivityId: id,
            outcome: outcomes.get(id) ?? "failed",
            elapsedS: [],
            distanceM: [],
          },
      ),
    };
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

async function stateOf(activityId: string) {
  const [row] = await db
    .select({ version: activity.bestEffortsVersion, attempts: activity.bestEffortsAttempts })
    .from(activity)
    .where(eq(activity.id, activityId));
  if (!row) throw new Error("no such run");
  return row;
}

async function failedAtOf(activityId: string): Promise<Date | null> {
  const [row] = await db
    .select({ failedAt: activity.bestEffortsFailedAt })
    .from(activity)
    .where(eq(activity.id, activityId));
  if (!row) throw new Error("no such run");
  return row.failedAt;
}

/** Whether a batch stamped the run in the last minute. */
async function stampedNow(activityId: string): Promise<boolean> {
  const failedAt = await failedAtOf(activityId);
  return failedAt !== null && Date.now() - failedAt.getTime() < 60_000;
}

/** Moves the runs' last failure past BEST_EFFORTS_RETRY_AFTER_S, as if they had waited it out. */
async function waitOut(activityIds: string[]): Promise<void> {
  await db
    .update(activity)
    .set({ bestEffortsFailedAt: new Date(Date.now() - (BEST_EFFORTS_RETRY_AFTER_S + 60) * 1000) })
    .where(inArray(activity.id, activityIds));
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

const NOTHING_DONE = { processed: 0, failed: 0, skipped: 0, remaining: 0, waiting: 0 };

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

    expect(result).toEqual({ ...NOTHING_DONE, processed: 2 });
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

    expect(result).toEqual(NOTHING_DONE);
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
    // An older rule version: every run is pending again, and none is a canary.
    await db
      .update(activity)
      .set({ bestEffortsVersion: BEST_EFFORTS_VERSION - 1 })
      .where(eq(activity.userId, userId));

    const result = await computeBestEffortsBatch(userId);

    expect(result).toEqual({ ...NOTHING_DONE, processed: 2 });
    expect(await effortsOf(ids)).toEqual(before);
    expect(before).toHaveLength(2 * FIXTURE_DISTANCES.length);
  });

  it("asks for the canary first beside one fewer pending run and never writes its answer, and the newest computed run is the next canary (canary)", async () => {
    const userId = await connectedUser();
    const canary = await createCanary(userId);
    const canaryRow = await db.select().from(activity).where(eq(activity.id, canary.id));
    const canaryEfforts = await db
      .select()
      .from(bestEffort)
      .where(eq(bestEffort.activityId, canary.id));
    await createRuns(userId, HISTORY_RUNS);
    const calls = recordSeriesCalls();

    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      processed: GARMIN_SERIES_BATCH_MAX - 1,
      remaining: 3,
    });
    // Its one seeded effort and its row stay: the fixture's eight efforts for it are never written.
    expect(await db.select().from(bestEffort).where(eq(bestEffort.activityId, canary.id))).toEqual(
      canaryEfforts,
    );
    expect(await db.select().from(activity).where(eq(activity.id, canary.id))).toEqual(canaryRow);

    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, processed: 3 });

    expect(calls).toEqual([
      {
        garminActivityIds: [LONG_RUN, ...HISTORY_RUNS.slice(0, GARMIN_SERIES_BATCH_MAX - 1)],
        includeRecords: false,
      },
      {
        garminActivityIds: [HISTORY_RUNS[0], ...HISTORY_RUNS.slice(GARMIN_SERIES_BATCH_MAX - 1)],
        includeRecords: true,
      },
    ]);
  });

  it("marks a run Garmin no longer has done with no efforts and clears its failed tries (deleted run)", async () => {
    const userId = await connectedUser();
    const [gone, kept] = await createRuns(userId, [GONE, LONG_RUN]);
    if (!gone || !kept) throw new Error("runs missing");
    await db.update(activity).set({ bestEffortsAttempts: 2 }).where(eq(activity.id, gone.id));
    await waitOut([gone.id]);

    const result = await computeBestEffortsBatch(userId);

    expect(result).toEqual({ ...NOTHING_DONE, processed: 2 });
    expect(await stateOf(gone.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    expect(await failedAtOf(gone.id)).toBeNull();
    expect(await effortsOf([gone.id])).toEqual([]);
    expect(await effortsOf([kept.id])).toHaveLength(FIXTURE_DISTANCES.length);
  });

  it("marks runs Garmin no longer has done when the canary reads, keeping nothing of their old efforts (all gone)", async () => {
    const userId = await connectedUser();
    await createCanary(userId);
    const runs = await createRuns(userId, [GONE, GONE_TOO]);
    const ids = runs.map((run) => run.id);

    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, processed: 2 });

    for (const id of ids) {
      expect(await stateOf(id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    }
    expect(await effortsOf(ids)).toEqual([]);
  });

  it("rejects with garmin_unavailable and keeps every run and effort when the canary is gone too (details endpoint answering 404 for every run)", async () => {
    const userId = await connectedUser();
    const canary = await createCanary(userId, GONE);
    // Computed by an older rule: pending, with efforts a wrong "gone" would delete.
    const runs = [];
    for (const [index, garminActivityId] of [GONE_TOO, 12_347].entries()) {
      runs.push(
        await createRun(userId, {
          garminActivityId,
          startUtc: new Date(Date.UTC(2026, 8, 27 - index, 6)),
          bestEffortsVersion: BEST_EFFORTS_VERSION - 1,
        }),
      );
    }
    const ids = runs.map((run) => run.id);
    await db.insert(bestEffort).values(
      ids.map((id) => ({
        userId,
        activityId: id,
        distanceKey: "5k" as const,
        timeS: 1500,
        startS: 0,
      })),
    );

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    for (const id of ids) {
      expect(await stateOf(id)).toEqual({ version: BEST_EFFORTS_VERSION - 1, attempts: 0 });
    }
    expect(await effortsOf(ids)).toHaveLength(2);
    // Stamped, so the retry asks other runs and another canary.
    for (const id of [canary.id, ...ids]) expect(await stampedNow(id)).toBe(true);
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminUnavailable);
  });

  it("marks runs Garmin holds no samples for done with no efforts when the canary reads (runs without samples)", async () => {
    const userId = await connectedUser();
    await createCanary(userId);
    const runs = await createRuns(userId, MANUAL_ENTRIES);
    const ids = runs.map((run) => run.id);

    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, processed: 2 });

    for (const id of ids) {
      expect(await stateOf(id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    }
    expect(await effortsOf(ids)).toEqual([]);
  });

  it("rejects with garmin_unavailable and marks nothing when, without a canary, every run comes back without samples (details endpoint moved)", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, MANUAL_ENTRIES);

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    for (const run of runs) {
      expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
      expect(await stampedNow(run.id)).toBe(true);
    }
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminUnavailable);
  });

  it("counts a try for a run Garmin could not read while it read the others, asks for it again only once it waited 6 h, and gives it up after 3 tries (one run failing)", async () => {
    const userId = await connectedUser();
    const [unreadable, longRun, race] = await createRuns(userId, [UNREADABLE, LONG_RUN, RACE]);
    if (!unreadable || !longRun || !race) throw new Error("runs missing");
    const calls = recordSeriesCalls();

    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      processed: 2,
      failed: 1,
      waiting: 1,
    });

    expect(await stateOf(unreadable.id)).toEqual({ version: null, attempts: 1 });
    expect(await stampedNow(unreadable.id)).toBe(true);
    for (const run of [longRun, race]) {
      expect(await stateOf(run.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
      expect(await effortsOf([run.id])).toHaveLength(FIXTURE_DISTANCES.length);
    }
    expect(await effortsOf([unreadable.id])).toEqual([]);
    // Garmin answered for the others, so the login is working.
    expect((await connection(userId)).lastError).toBeNull();

    // Within its 6 h: a newer run goes without it, and a batch with nothing else due calls no one.
    await createOlderRun(userId, HISTORY_RUNS[0] ?? 0, 10);
    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      processed: 1,
      waiting: 1,
    });
    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, waiting: 1 });

    // Waited out, it is asked again beside the canary, the newest computed run.
    await waitOut([unreadable.id]);
    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      failed: 1,
      waiting: 1,
    });
    await waitOut([unreadable.id]);
    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, failed: 1 });

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [UNREADABLE, LONG_RUN, RACE],
      [LONG_RUN, HISTORY_RUNS[0]],
      [LONG_RUN, UNREADABLE],
      [LONG_RUN, UNREADABLE],
    ]);
    expect(await stateOf(unreadable.id)).toEqual({
      version: null,
      attempts: BEST_EFFORTS_MAX_ATTEMPTS,
    });
    // Given up: no longer pending, fetched or queued, however long it waited.
    await waitOut([unreadable.id]);
    expect(await computeBestEffortsBatch(userId)).toEqual(NOTHING_DONE);
    expect(calls).toHaveLength(4);
    expect(await queueBestEfforts(userId)).toBeNull();
  });

  it("computes the readable runs behind four unreadable newest ones in later batches while those count tries (unreadable runs at the head)", async () => {
    const userId = await connectedUser();
    await createCanary(userId);
    const unreadableIds = [UNREADABLE, UNREADABLE_TOO, 9_000_000_505, 9_000_000_506];
    const runs = await createRuns(userId, [...unreadableIds, RACE, 10_000_000_005]);
    const unreadable = runs.slice(0, 4);
    const readable = runs.slice(4);
    const calls = unreadableRuns(unreadableIds);

    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      failed: 2,
      skipped: 4,
      remaining: 4,
      waiting: 2,
    });
    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      failed: 2,
      skipped: 2,
      remaining: 2,
      waiting: 4,
    });
    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      processed: 2,
      waiting: 4,
    });

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [LONG_RUN, ...unreadableIds, RACE, 10_000_000_005],
      [LONG_RUN, ...unreadableIds.slice(2), RACE, 10_000_000_005],
      [LONG_RUN, RACE, 10_000_000_005],
    ]);
    for (const run of unreadable) {
      expect(await stateOf(run.id)).toEqual({ version: null, attempts: 1 });
      expect(await stampedNow(run.id)).toBe(true);
    }
    for (const run of readable) {
      expect(await stateOf(run.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
      expect(await effortsOf([run.id])).toHaveLength(FIXTURE_DISTANCES.length);
    }
  });

  it("rejects with garmin_unavailable, writes nothing and records the error when Garmin is down, and a later batch computes the runs (Garmin outage)", async () => {
    const userId = await connectedUser(garminBundle("unavailable"));
    const runs = await createRuns(userId, [LONG_RUN, RACE]);
    const ids = runs.map((run) => run.id);

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    for (const id of ids) {
      expect(await stateOf(id)).toEqual({ version: null, attempts: 0 });
      // The service gave no answer at all: no run was asked, so none waits.
      expect(await failedAtOf(id)).toBeNull();
    }
    expect(await effortsOf(ids)).toEqual([]);
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminUnavailable);

    await setGarminBundle(userId, garminBundle());

    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, processed: 2 });
    for (const id of ids) {
      expect(await stateOf(id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    }
    expect(await effortsOf(ids)).toHaveLength(2 * FIXTURE_DISTANCES.length);
    expect((await connection(userId)).lastError).toBeNull();
  });

  it("rejects with garmin_unavailable, counts no try and stamps the run when the only run of a first batch fails, keeping a rotated bundle (whole batch failed)", async () => {
    const userId = await connectedUser(garminBundle("rotate"));
    const [run] = await createRuns(userId, [UNREADABLE]);
    if (!run) throw new Error("run missing");

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
    expect(await stampedNow(run.id)).toBe(true);
    const stored = await connection(userId);
    expect(stored.lastError).toBe(ErrorCode.garminUnavailable);
    expect(JSON.parse(decrypt(stored.tokenBundleEnc, userId))).toMatchObject({
      fixture: "rotated",
    });
  });

  it("stamps two unreadable newest runs of a first batch as an outage, and the next batch computes the older runs the service skipped (Garmin outage without a canary)", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, [UNREADABLE, UNREADABLE_TOO, LONG_RUN, RACE]);
    const [unreadable, unreadableToo, longRun, race] = runs;
    if (!unreadable || !unreadableToo || !longRun || !race) throw new Error("runs missing");
    const calls = recordSeriesCalls();

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    for (const run of runs) expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
    expect(await effortsOf(runs.map((run) => run.id))).toEqual([]);
    expect(await stampedNow(unreadable.id)).toBe(true);
    expect(await stampedNow(unreadableToo.id)).toBe(true);
    // Never asked: they go first in the retry.
    expect(await failedAtOf(longRun.id)).toBeNull();
    expect(await failedAtOf(race.id)).toBeNull();
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminUnavailable);

    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      processed: 2,
      waiting: 2,
    });

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [UNREADABLE, UNREADABLE_TOO, LONG_RUN, RACE],
      [LONG_RUN, RACE],
    ]);
    for (const run of [longRun, race]) {
      expect(await effortsOf([run.id])).toHaveLength(FIXTURE_DISTANCES.length);
    }
    for (const run of [unreadable, unreadableToo]) {
      expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
    }
    expect((await connection(userId)).lastError).toBeNull();
  });

  it("computes the runs Garmin reads beside a canary it cannot read, counting a try for the run that failed and taking the canary off duty (failing canary)", async () => {
    const userId = await connectedUser();
    const canary = await createCanary(userId, UNREADABLE);
    const canaryEfforts = await effortsOf([canary.id]);
    const runs = await createRuns(userId, [LONG_RUN, UNREADABLE_TOO, RACE]);
    const [longRun, unreadableToo, race] = runs;
    if (!longRun || !unreadableToo || !race) throw new Error("runs missing");
    const calls = recordSeriesCalls();

    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      processed: 2,
      failed: 1,
      waiting: 1,
    });

    // Garmin read two runs, so it works: each run's outcome is its own.
    for (const run of [longRun, race]) {
      expect(await stateOf(run.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
      expect(await effortsOf([run.id])).toHaveLength(FIXTURE_DISTANCES.length);
    }
    expect(await stateOf(unreadableToo.id)).toEqual({ version: null, attempts: 1 });
    expect(await stampedNow(unreadableToo.id)).toBe(true);
    // Retired for good through its tries, not stamped (a stamp only rests a run), its own efforts kept.
    expect(await stampedNow(canary.id)).toBe(false);
    expect(await stateOf(canary.id)).toEqual({
      version: BEST_EFFORTS_VERSION,
      attempts: BEST_EFFORTS_MAX_ATTEMPTS,
    });
    expect(await effortsOf([canary.id])).toEqual(canaryEfforts);
    expect((await connection(userId)).lastError).toBeNull();

    await createOlderRun(userId, HISTORY_RUNS[0] ?? 0, 10);
    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      processed: 1,
      waiting: 1,
    });

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [UNREADABLE, LONG_RUN, UNREADABLE_TOO, RACE],
      [LONG_RUN, HISTORY_RUNS[0]],
    ]);
  });

  it("rests a canary stamped in an outage for 6 h, then asks it again, and only retires it when another run reads beside it (Garmin outage)", async () => {
    const userId = await connectedUser();
    const canary = await createCanary(userId, GONE);
    await createRun(userId, {
      garminActivityId: GONE_TOO,
      startUtc: new Date(Date.UTC(2026, 8, 27, 6)),
    });
    const calls = recordSeriesCalls();

    // Nothing read: an outage, which stamps the canary but counts it no try.
    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });
    expect(await stampedNow(canary.id)).toBe(true);
    expect(await stateOf(canary.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });

    // Rested, it is the canary again; beside a run Garmin reads it comes back without samples, so it retires.
    await waitOut([canary.id]);
    await createOlderRun(userId, LONG_RUN, 15);
    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      processed: 1,
      waiting: 1,
    });

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [GONE, GONE_TOO],
      [GONE, LONG_RUN],
    ]);
    expect(await stateOf(canary.id)).toEqual({
      version: BEST_EFFORTS_VERSION,
      attempts: BEST_EFFORTS_MAX_ATTEMPTS,
    });
  });

  it("computes a new run when the canary is deleted on Garmin, records no outage, and asks the next computed run as canary for good (deleted canary)", async () => {
    const userId = await connectedUser();
    // Newer than the run the batch computes, so only being off duty keeps it from the next batch.
    const deleted = await createCanary(userId, GONE, 20);
    const deletedEfforts = await effortsOf([deleted.id]);
    const newRun = await createOlderRun(userId, LONG_RUN, 15);
    const calls = recordSeriesCalls();

    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, processed: 1 });

    expect(await stateOf(newRun.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    expect(await effortsOf([newRun.id])).toHaveLength(FIXTURE_DISTANCES.length);
    expect((await connection(userId)).lastError).toBeNull();
    expect(await stampedNow(deleted.id)).toBe(false);
    expect(await stateOf(deleted.id)).toEqual({
      version: BEST_EFFORTS_VERSION,
      attempts: BEST_EFFORTS_MAX_ATTEMPTS,
    });
    expect(await effortsOf([deleted.id])).toEqual(deletedEfforts);

    // Even with an old stamp past the 6 h a failed run waits, the retired canary stays off duty.
    await waitOut([deleted.id]);
    await createOlderRun(userId, RACE, 10);
    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, processed: 1 });

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [GONE, LONG_RUN],
      [LONG_RUN, RACE],
    ]);
  });

  it("rejects with garmin_unavailable and writes nothing when the service spent its time on the canary and skipped every run of the batch, and the retry asks the same runs (canary used the time budget)", async () => {
    const userId = await connectedUser();
    const canary = await createCanary(userId);
    const runs = await createRuns(userId, [RACE, 10_000_000_005]);
    const ids = [canary.id, ...runs.map((run) => run.id)];
    const before = await db.select().from(activity).where(inArray(activity.id, ids));
    skipRunsFrom(1);

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    expect(await db.select().from(activity).where(inArray(activity.id, ids))).toEqual(before);
    expect(await effortsOf(runs.map((run) => run.id))).toEqual([]);
    // Recorded like any Garmin failure, so the screen says why while pg-boss retries.
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminUnavailable);

    vi.restoreAllMocks();
    const calls = recordSeriesCalls();
    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, processed: 2 });
    expect(calls.map((call) => call.garminActivityIds)).toEqual([[LONG_RUN, RACE, 10_000_000_005]]);
  });

  it("throws a plain error and leaves the connection's last error and the runs untouched when the service answers out of request order (service bug)", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, [LONG_RUN, RACE]);
    const original = garminClient.series.bind(garminClient);
    vi.spyOn(garminClient, "series").mockImplementation(async (request, options) => {
      const response = await original(request, options);
      return { ...response, series: [...response.series].reverse() };
    });

    const error: unknown = await computeBestEffortsBatch(userId).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("code");
    expect((error as Error).message).toMatch(/out of request order/);
    expect((await connection(userId)).lastError).toBeNull();
    for (const run of runs) {
      expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
      expect(await failedAtOf(run.id)).toBeNull();
    }
    expect(await effortsOf(runs.map((run) => run.id))).toEqual([]);
  });

  it("counts a try for the runs Garmin failed on and leaves the runs the service skipped after them untouched, which a later batch computes (partial batch)", async () => {
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
      remaining: 1,
      waiting: 2,
    });

    expect(await stateOf(longRun.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    expect(await effortsOf([longRun.id])).toHaveLength(FIXTURE_DISTANCES.length);
    for (const run of [unreadable, unreadableToo]) {
      expect(await stateOf(run.id)).toEqual({ version: null, attempts: 1 });
    }
    // Never asked about: still pending, no try counted, nothing written.
    expect(await stateOf(race.id)).toEqual({ version: null, attempts: 0 });
    expect(await failedAtOf(race.id)).toBeNull();
    expect(await effortsOf([race.id, unreadable.id, unreadableToo.id])).toEqual([]);
    // The service stopped before the records call, so none are stored.
    expect(await connection(userId)).toMatchObject({
      lastError: null,
      garminRecords: null,
      garminRecordsAt: null,
    });

    // The runs that failed wait; the skipped one goes beside the canary.
    expect(await computeBestEffortsBatch(userId)).toEqual({
      ...NOTHING_DONE,
      processed: 1,
      waiting: 2,
    });

    expect(calls.map((call) => call.garminActivityIds)).toEqual([
      [LONG_RUN, UNREADABLE, UNREADABLE_TOO, RACE],
      [LONG_RUN, RACE],
    ]);
    expect(await stateOf(race.id)).toEqual({ version: BEST_EFFORTS_VERSION, attempts: 0 });
    expect(await effortsOf([race.id])).toHaveLength(FIXTURE_DISTANCES.length);
  });

  it("rejects with garmin_unavailable and stamps only the runs Garmin was asked about when the rest were skipped (details endpoint moved)", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, [...MANUAL_ENTRIES, LONG_RUN]);
    skipRunsFrom(MANUAL_ENTRIES.length);

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    for (const run of runs) expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
    const stamped = await Promise.all(runs.map((run) => stampedNow(run.id)));
    expect(stamped).toEqual([true, true, false]);
  });

  it("rejects with garmin_unavailable and counts no try for a run that failed before when the service skipped it (Garmin outage)", async () => {
    const userId = await connectedUser();
    const [run] = await createRuns(userId, [UNREADABLE]);
    if (!run) throw new Error("run missing");
    await db.update(activity).set({ bestEffortsAttempts: 1 }).where(eq(activity.id, run.id));
    await waitOut([run.id]);
    const failedAt = await failedAtOf(run.id);
    skipRunsFrom(0);

    await expect(computeBestEffortsBatch(userId)).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    expect(await stateOf(run.id)).toEqual({ version: null, attempts: 1 });
    expect(await failedAtOf(run.id)).toEqual(failedAt);
  });

  it("takes the newest pending runs first and fetches Garmin's records only with the batch that takes the last due runs", async () => {
    const userId = await connectedUser();
    const runs = await createRuns(userId, HISTORY_RUNS);
    const calls = recordSeriesCalls();

    const first = await computeBestEffortsBatch(userId);

    expect(first).toEqual({ ...NOTHING_DONE, processed: GARMIN_SERIES_BATCH_MAX, remaining: 2 });
    expect(calls[0]).toEqual({
      garminActivityIds: HISTORY_RUNS.slice(0, GARMIN_SERIES_BATCH_MAX),
      includeRecords: false,
    });
    expect(await connection(userId)).toMatchObject({ garminRecords: null, garminRecordsAt: null });

    const second = await computeBestEffortsBatch(userId);

    expect(second).toEqual({ ...NOTHING_DONE, processed: 2 });
    // The newest run computed by the first batch is the canary.
    expect(calls[1]).toEqual({
      garminActivityIds: [HISTORY_RUNS[0], ...HISTORY_RUNS.slice(GARMIN_SERIES_BATCH_MAX)],
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
    expect(await failedAtOf(run.id)).toBeNull();
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

    expect(await computeBestEffortsBatch(userId)).toEqual(NOTHING_DONE);
  });

  it("returns at once without calling Garmin when every pending run waits out its 6 h", async () => {
    const userId = await connectedUser();
    const [run] = await createRuns(userId, [LONG_RUN]);
    if (!run) throw new Error("run missing");
    await db
      .update(activity)
      .set({ bestEffortsAttempts: 1, bestEffortsFailedAt: new Date() })
      .where(eq(activity.id, run.id));
    const calls = recordSeriesCalls();

    expect(await computeBestEffortsBatch(userId)).toEqual({ ...NOTHING_DONE, waiting: 1 });
    expect(calls).toEqual([]);
  });
});

describe("getRunBestEfforts", () => {
  /**
   * Every personal-best flag of the runs against the run getPersonalBests names per distance: a flag is
   * true exactly when that run holds the best there.
   */
  async function expectFlagsMatchBests(userId: string, activityIds: string[]) {
    const { bests } = await getPersonalBests(userId);
    const holder = new Map(bests.map((best) => [best.distanceKey, best.activityId]));
    for (const activityId of activityIds) {
      for (const effort of await getRunBestEfforts(userId, activityId)) {
        expect(effort.personalBest).toBe(holder.get(effort.distanceKey) === activityId);
      }
    }
    return bests;
  }

  it("flags exactly the runs getPersonalBests names after a batch computes them, the earlier of two identical runs holding every best (duplicate activities)", async () => {
    const userId = await connectedUser();
    // The fixture service serves both the same series: every effort ties, and RACE started a day earlier.
    const [longRun, race] = await createRuns(userId, [LONG_RUN, RACE]);
    const treadmill = await createRun(userId, {
      garminActivityId: TREADMILL,
      type: "treadmill_running",
      isIndoor: true,
    });
    if (!longRun || !race) throw new Error("runs missing");
    await computeBestEffortsBatch(userId);

    const bests = await expectFlagsMatchBests(userId, [longRun.id, race.id, treadmill.id]);

    expect(bests.map((best) => best.distanceKey)).toEqual(FIXTURE_DISTANCES);
    expect(new Set(bests.map((best) => best.activityId))).toEqual(new Set([race.id]));
    const efforts = bests.map(({ distanceKey, timeS }) => ({ distanceKey, timeS }));
    expect(await getRunBestEfforts(userId, race.id)).toEqual(
      efforts.map((effort) => ({ ...effort, personalBest: true })),
    );
    expect(await getRunBestEfforts(userId, longRun.id)).toEqual(
      efforts.map((effort) => ({ ...effort, personalBest: false })),
    );
    expect(await getRunBestEfforts(userId, treadmill.id)).toEqual([]);
  });

  it("moves every flag to the other run when the holder is edited, and answers the edited run nothing (edited activity)", async () => {
    const userId = await connectedUser();
    const [longRun, race] = await createRuns(userId, [LONG_RUN, RACE]);
    if (!longRun || !race) throw new Error("runs missing");
    await computeBestEffortsBatch(userId);
    // What the sync's upsert does when Garmin changes the run's distance or time.
    await db.update(activity).set({ bestEffortsVersion: null }).where(eq(activity.id, race.id));

    const bests = await expectFlagsMatchBests(userId, [longRun.id, race.id]);

    expect(new Set(bests.map((best) => best.activityId))).toEqual(new Set([longRun.id]));
    expect(await getRunBestEfforts(userId, race.id)).toEqual([]);
    expect(
      (await getRunBestEfforts(userId, longRun.id)).every((effort) => effort.personalBest),
    ).toBe(true);
  });

  it("answers nothing for another runner's run", async () => {
    const userId = await connectedUser();
    const [run] = await createRuns(userId, [LONG_RUN]);
    if (!run) throw new Error("run missing");
    await computeBestEffortsBatch(userId);
    const other = await createUser("other.runner@example.com");

    expect(await getRunBestEfforts(userId, run.id)).toHaveLength(FIXTURE_DISTANCES.length);
    expect(await getRunBestEfforts(other, run.id)).toEqual([]);
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
    "clears the version, failed tries and last failure when Garmin changes the run's %s, so its efforts are hidden and recomputed at once (edited activity)",
    async (_, change) => {
      const userId = await createUser();
      const run = await computedRun(userId);
      await db
        .update(activity)
        .set({ bestEffortsAttempts: BEST_EFFORTS_MAX_ATTEMPTS, bestEffortsFailedAt: new Date() })
        .where(eq(activity.id, run.id));

      expect(await upsertActivities(userId, [summary(change)])).toBe(1);

      expect(await stateOf(run.id)).toEqual({ version: null, attempts: 0 });
      expect(await failedAtOf(run.id)).toBeNull();
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

  it("queues the batch for the import's last page before its progress reads done, so a reader never sees the import done with nothing checking its runs", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    const boss = getBoss();
    const send = boss.send.bind(boss);
    const importAtSend: string[] = [];
    vi.spyOn(boss, "send").mockImplementation(
      async (name: string, data?: object | null, options?: SendOptions) => {
        importAtSend.push((await storedImport(userId)).status);
        return send(name, data, options);
      },
    );

    // One page larger than the fixture's list: it is also the last.
    const page = await importHistoryPage({ userId, pageSize: 100 });

    expect(page.status).toBe("done");
    expect(importAtSend).toEqual(["running"]);
    expect((await storedImport(userId)).status).toBe("done");
    expect(await queuedBatches(userId)).toHaveLength(1);
  });

  it("sends nothing while a batch of the user waits, is deferred or waits for its retry (overlapping jobs)", async () => {
    const userId = await connectedUser();
    await createRuns(userId, [LONG_RUN]);
    const boss = getBoss();
    const options = bestEffortsQueue.sendOptions({ userId });

    const waiting = await boss.send(bestEffortsQueue.name, { userId }, options);
    if (!waiting) throw new Error("batch not queued");
    expect(await queueBestEfforts(userId)).toBeNull();
    await boss.deleteJob(bestEffortsQueue.name, waiting);

    const deferred = await boss.send(
      bestEffortsQueue.name,
      { userId },
      { ...options, startAfter: 3600 },
    );
    if (!deferred) throw new Error("batch not queued");
    expect(await queueBestEfforts(userId)).toBeNull();
    // Failed once: it waits out the retry's backoff, which a fresh batch beside it would skip.
    await boss.fail(bestEffortsQueue.name, deferred);
    const [retrying] = await boss.findJobs(bestEffortsQueue.name, { id: deferred });
    expect(retrying?.state).toBe("retry");
    expect(await queueBestEfforts(userId)).toBeNull();

    expect(await queuedBatches(userId)).toEqual([deferred]);
  });

  it("sends a batch beside the user's running one, BATCH_GAP_S later like its successor, which then folds into it (overlapping jobs)", async () => {
    const userId = await connectedUser();
    await createRuns(userId, [LONG_RUN]);
    const boss = getBoss();
    const options = bestEffortsQueue.sendOptions({ userId });
    const running = await boss.send(bestEffortsQueue.name, { userId }, options);
    if (!running) throw new Error("batch not queued");
    // Earlier tests leave other users' batches queued: take them all, one per user.
    await boss.fetch(bestEffortsQueue.name, { batchSize: 100 });
    const [active] = await boss.findJobs(bestEffortsQueue.name, { id: running });
    expect(active?.state).toBe("active");

    const queued = await queueBestEfforts(userId);

    expect(queued).not.toBeNull();
    expect(await queuedBatches(userId)).toEqual([queued]);
    // Not due at once: an import whose pages each queue a batch keeps the gap between Garmin logins.
    const [waiting] = await boss.findJobs(bestEffortsQueue.name, { id: queued ?? "" });
    const startsInS = ((waiting?.startAfter.getTime() ?? 0) - Date.now()) / 1000;
    expect(startsInS).toBeGreaterThan(bestEffortsQueue.BATCH_GAP_S - 5);
    expect(startsInS).toBeLessThanOrEqual(bestEffortsQueue.BATCH_GAP_S);
    // The running batch queues its successor as the job does: the waiting batch already covers it.
    expect(
      await boss.send(bestEffortsQueue.name, { userId }, { ...options, startAfter: 30 }),
    ).toBeNull();
    expect(await queuedBatches(userId)).toEqual([queued]);
  });

  it("queues nothing when every pending run waits out its 6 h after a failed try", async () => {
    const userId = await connectedUser();
    await createRun(userId, { bestEffortsAttempts: 1, bestEffortsFailedAt: new Date() });

    expect(await queueBestEfforts(userId)).toBeNull();
    expect(await queuedBatches(userId)).toEqual([]);
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
    const waitingUser = await createUser("waiting@example.com");
    await createRun(waitingUser, { bestEffortsAttempts: 1, bestEffortsFailedAt: new Date() });
    const treadmillUser = await createUser("treadmill@example.com");
    await createRun(treadmillUser, { garminActivityId: TREADMILL, isIndoor: true });

    expect(await queuePendingBestEfforts()).toBe(1);

    expect(await queuedBatches(pendingUser)).toHaveLength(1);
    for (const userId of [doneUser, givenUpUser, waitingUser, treadmillUser]) {
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
