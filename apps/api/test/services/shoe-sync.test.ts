import { ErrorCode, type GarminActivitySummary } from "@running-coach/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, garminConnection, shoe } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as analyzeRunQueue from "../../src/jobs/analyze-run-queue";
import * as bestEffortsQueue from "../../src/jobs/best-efforts-queue";
import { startBoss, stopBoss } from "../../src/jobs/boss";
import { DomainError } from "../../src/lib/errors";
import {
  syncGarmin,
  type WrittenActivities,
  writeActivities,
} from "../../src/services/garmin-sync";
import { importHistoryPage } from "../../src/services/history-import";
import { activateShoe, deleteShoe, listShoes, setActivityShoe } from "../../src/services/shoes";
import { connectGarmin, createUser, seedImport } from "../seed";
import { aQueryWaitsForARowLock, createPair, pairsOfRuns } from "../seed-shoes";

// Which pair a sync or the history import puts on a run (slice 52), on the real Postgres against the Garmin
// service in fixture mode: the active pair goes on each run the sync inserts, once, and nothing reassigns
// it. The fixture's seven runs start 2026-08-30 22:40 to 2026-09-27 06:00 UTC (local 2026-08-31 00:40 to
// 2026-09-27 08:00), one of them the treadmill of 09-24; from CURSOR the sync reads all seven. The import
// adds 39 older runs. pg-boss runs without workers, so a queued job stays queued.

const NOW = new Date("2026-09-28T10:00:00Z");
const CURSOR = new Date("2026-09-01T12:00:00Z");
const FIXTURE_RUNS = [
  10_000_000_001, 10_000_000_002, 10_000_000_003, 10_000_000_004, 10_000_000_005, 10_000_000_006,
  10_000_000_007,
];
const TREADMILL = 10_000_000_006;
const LONG_RUN = 10_000_000_007;
/** The seven runs' distance and time. */
const FIXTURE_DISTANCE_M = 18_000 + 8000 + 14_000 + 6500 + 5000 + 10_200 + 5000;
const FIXTURE_DURATION_S = 6120 + 2700 + 4620 + 2280 + 1800 + 3300 + 1860;

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(analyzeRunQueue.name, analyzeRunQueue.queue);
  await boss.createQueue(bestEffortsQueue.name, bestEffortsQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connectedUser(lastSyncAt = CURSOR): Promise<string> {
  const userId = await createUser();
  await connectGarmin(userId, undefined, { lastSyncAt });
  return userId;
}

/** Moves the cursor back, so the next sync reads every fixture run again. */
async function rewindCursor(userId: string): Promise<void> {
  await db
    .update(garminConnection)
    .set({ lastSyncAt: CURSOR })
    .where(eq(garminConnection.userId, userId));
}

/** Every run on the same pair, keyed by Garmin id. */
function allOn(shoeId: string | null, runs: number[] = FIXTURE_RUNS) {
  return Object.fromEntries(runs.map((id) => [id, shoeId]));
}

async function runId(userId: string, garminActivityId: number): Promise<string> {
  const [row] = await db
    .select({ id: activity.id })
    .from(activity)
    .where(and(eq(activity.userId, userId), eq(activity.garminActivityId, garminActivityId)));
  if (!row) throw new Error("no such run");
  return row.id;
}

/** A run as Garmin lists it, its local clock on UTC unless `values` say otherwise. */
function summaryOf(
  garminActivityId: number,
  startLocal: string,
  values: Partial<GarminActivitySummary> = {},
): GarminActivitySummary {
  return {
    garminActivityId,
    type: "running",
    startUtc: `${startLocal}Z`,
    startLocal,
    tz: null,
    distanceM: 5000,
    durationS: 1500,
    avgHr: null,
    maxHr: null,
    cadence: null,
    calories: null,
    elevationGainM: null,
    isIndoor: false,
    isManual: false,
    eventType: null,
    ...values,
  };
}

/** Three new runs of 2026-09-21 to 09-23, Garmin ids 501 to 503. */
const THREE_RUNS = [1, 2, 3].map((n) => summaryOf(500 + n, `2026-09-2${n}T08:00:00`));

/** writeActivities in a chunk's own transaction, as the sync's chunk calls it from SINCE. */
const SINCE = "2026-09-01";
function writeChunk(userId: string, summaries = THREE_RUNS): Promise<WrittenActivities> {
  return db.transaction((tx) =>
    writeActivities(userId, summaries, tx, { wearActivePairFrom: SINCE }),
  );
}

/** Stores another distance for the run, so the next sync, reading Garmin's, rewrites it (edited run). */
async function editStored(userId: string, garminActivityId: number): Promise<void> {
  await db
    .update(activity)
    .set({ distanceM: 1234 })
    .where(and(eq(activity.userId, userId), eq(activity.garminActivityId, garminActivityId)));
}

describe("the active pair on synced runs", () => {
  it("puts the active pair on each new run, the indoor one too, and the pair counts them (indoor run)", async () => {
    const userId = await connectedUser();
    const pair = await createPair(userId, { active: true, startDistanceM: 100_000 });
    const other = await createPair(userId);

    const result = await syncGarmin({ userId, now: NOW });

    expect(result.activitiesWritten).toBe(7);
    expect(await pairsOfRuns(userId)).toEqual(allOn(pair.id));
    const { shoes } = await listShoes(userId);
    expect(shoes.find((row) => row.id === pair.id)).toMatchObject({
      distanceM: 100_000 + FIXTURE_DISTANCE_M,
      runs: 7,
      durationS: FIXTURE_DURATION_S,
    });
    expect(shoes.find((row) => row.id === other.id)).toMatchObject({ distanceM: 0, runs: 0 });
    // The treadmill run is among them.
    expect((await pairsOfRuns(userId))[TREADMILL]).toBe(pair.id);
  });

  it("leaves new runs without a pair when none is active (no active pair)", async () => {
    const userId = await connectedUser();
    await createPair(userId);
    await createPair(userId, { retiredAt: new Date("2026-06-01T00:00:00Z") });

    await syncGarmin({ userId, now: NOW });

    expect(await pairsOfRuns(userId)).toEqual(allOn(null));
  });

  it("never puts another runner's active pair on a run", async () => {
    const userId = await connectedUser();
    const otherId = await createUser("other@example.com");
    await createPair(otherId, { active: true });

    await syncGarmin({ userId, now: NOW });

    expect(await pairsOfRuns(userId)).toEqual(allOn(null));
  });

  it("never reassigns a run on a re-sync, also after the active pair changed (duplicate activities)", async () => {
    const userId = await connectedUser();
    const first = await createPair(userId, { active: true });
    const second = await createPair(userId);
    await syncGarmin({ userId, now: NOW });
    await activateShoe(userId, second.id);
    await rewindCursor(userId);

    const result = await syncGarmin({ userId, now: NOW });

    expect(result.activitiesSeen).toBe(7);
    expect(result.activitiesWritten).toBe(0);
    expect(await pairsOfRuns(userId)).toEqual(allOn(first.id));
  });

  it("keeps a run's pair when Garmin's edit rewrites it (edited run)", async () => {
    const userId = await connectedUser();
    const first = await createPair(userId, { active: true });
    const second = await createPair(userId);
    await syncGarmin({ userId, now: NOW });
    await activateShoe(userId, second.id);
    await editStored(userId, LONG_RUN);
    await rewindCursor(userId);

    const result = await syncGarmin({ userId, now: NOW });

    expect(result.activitiesWritten).toBe(1);
    expect(await pairsOfRuns(userId)).toEqual(allOn(first.id));
  });

  it("keeps a pair the runner changed or cleared by hand through the next sync, edited runs too (changed by hand)", async () => {
    const userId = await connectedUser();
    const active = await createPair(userId, { active: true });
    const picked = await createPair(userId);
    await syncGarmin({ userId, now: NOW });
    await setActivityShoe(userId, await runId(userId, LONG_RUN), picked.id);
    await setActivityShoe(userId, await runId(userId, TREADMILL), null);
    await editStored(userId, LONG_RUN);
    await editStored(userId, TREADMILL);
    await rewindCursor(userId);

    const result = await syncGarmin({ userId, now: NOW });

    expect(result.activitiesWritten).toBe(2);
    expect(await pairsOfRuns(userId)).toEqual({
      ...allOn(active.id),
      [LONG_RUN]: picked.id,
      [TREADMILL]: null,
    });
  });

  it("puts a pair on each run once when a sync fails partway and the next one reads the rest (partial sync)", async () => {
    // From 2026-09-19: chunks 09-19..09-25 (the 09-20 run and the treadmill of 09-24) and 09-26..09-28.
    const userId = await connectedUser(new Date("2026-09-20T12:00:00Z"));
    const first = await createPair(userId, { active: true });
    const second = await createPair(userId);
    const passThrough = garminClient.sync.bind(garminClient);
    let calls = 0;
    vi.spyOn(garminClient, "sync").mockImplementation(async (body, options) => {
      calls += 1;
      if (calls > 1) throw new DomainError(ErrorCode.garminUnavailable, 502, "Garmin is down.");
      return passThrough(body, options);
    });
    await expect(syncGarmin({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });
    expect(await pairsOfRuns(userId)).toEqual(allOn(first.id, [10_000_000_005, TREADMILL]));
    vi.restoreAllMocks();
    await activateShoe(userId, second.id);

    // Resumes at 09-24: the treadmill again, which keeps its pair, and the 09-27 run, new.
    await syncGarmin({ userId, now: NOW });

    expect(await pairsOfRuns(userId)).toEqual({
      ...allOn(first.id, [10_000_000_005, TREADMILL]),
      [LONG_RUN]: second.id,
    });
  });

  it("joins a sync asked for while one runs, which puts the pair on each run once, and a later pair changes none", async () => {
    const userId = await connectedUser();
    const first = await createPair(userId, { active: true });
    const second = await createPair(userId);

    await Promise.all([syncGarmin({ userId, now: NOW }), syncGarmin({ userId, now: NOW })]);
    await activateShoe(userId, second.id);
    await rewindCursor(userId);
    await syncGarmin({ userId, now: NOW });

    expect(await pairsOfRuns(userId)).toEqual(allOn(first.id));
    const { shoes } = await listShoes(userId);
    expect(shoes.find((row) => row.id === first.id)?.runs).toBe(7);
  });

  it("assigns once when two writes of the same runs race in separate transactions (overlapping syncs)", async () => {
    const userId = await createUser();
    const first = await createPair(userId, { active: true });

    const [a, b] = await Promise.all([writeChunk(userId), writeChunk(userId)]);
    await activateShoe(userId, (await createPair(userId)).id);
    const again = await writeChunk(userId);

    expect(a.insertedIds.length + b.insertedIds.length).toBe(3);
    expect(again.insertedIds).toEqual([]);
    expect(await pairsOfRuns(userId)).toEqual(allOn(first.id, [501, 502, 503]));
  });

  it("puts the pair on new runs from the given local date on, by the local start, not the UTC one (time zones)", async () => {
    const userId = await createUser();
    const pair = await createPair(userId, { active: true });
    const runs = [
      // Local 09-20 just after midnight, UTC still 09-19: inside.
      summaryOf(601, "2026-09-20T00:30:00", { startUtc: "2026-09-19T22:30:00Z" }),
      // Local 09-19 in the evening, UTC already 09-20: outside.
      summaryOf(602, "2026-09-19T21:00:00", { startUtc: "2026-09-20T01:00:00Z" }),
      summaryOf(603, "2026-09-18T08:00:00"),
    ];

    await db.transaction((tx) =>
      writeActivities(userId, runs, tx, { wearActivePairFrom: "2026-09-20" }),
    );

    expect(await pairsOfRuns(userId)).toEqual({ 601: pair.id, 602: null, 603: null });
  });

  it("stores the new runs without a pair, and no error, when the active pair's delete is in flight as a chunk writes (pair deleted during a sync)", async () => {
    const userId = await createUser();
    const pair = await createPair(userId, { active: true });
    let write: Promise<WrittenActivities> | undefined;

    // The delete holds the pair's row until it commits, while the chunk reads the active pair.
    await db.transaction(async (tx) => {
      await tx.delete(shoe).where(eq(shoe.id, pair.id));
      write = writeChunk(userId);
      write.catch(() => undefined);
      await aQueryWaitsForARowLock();
    });

    expect((await write)?.insertedIds).toHaveLength(3);
    expect(await pairsOfRuns(userId)).toEqual(allOn(null, [501, 502, 503]));
  });

  it("makes a delete of the active pair wait for the chunk that put it on new runs, then clears it from them (pair deleted during a sync)", async () => {
    const userId = await createUser();
    const pair = await createPair(userId, { active: true });
    let deletion: ReturnType<typeof deleteShoe> | undefined;

    await db.transaction(async (tx) => {
      await writeActivities(userId, THREE_RUNS, tx, { wearActivePairFrom: SINCE });
      deletion = deleteShoe(userId, pair.id);
      deletion.catch(() => undefined);
      await aQueryWaitsForARowLock();
    });

    await expect(deletion).resolves.toEqual({ shoes: [] });
    expect(await pairsOfRuns(userId)).toEqual(allOn(null, [501, 502, 503]));
  });

  it("puts the active pair on the import's runs inside the next sync's window and none on older ones (import)", async () => {
    // The next sync reads from 2026-09-20: the runs of 09-20, 09-24 and 09-27.
    const userId = await connectedUser(new Date("2026-09-21T12:00:00Z"));
    const pair = await createPair(userId, { active: true });
    await seedImport(userId);

    const page = await importHistoryPage({ userId, pageSize: 50 });

    expect(page.status).toBe("done");
    const runs = await pairsOfRuns(userId);
    expect(Object.keys(runs)).toHaveLength(46);
    expect(Object.entries(runs).filter(([, shoeId]) => shoeId !== null)).toEqual(
      [10_000_000_005, TREADMILL, LONG_RUN].map((id) => [String(id), pair.id]),
    );
  });

  it("keeps the pair the import put on a run through the next sync, as if the sync had stored it (import then sync)", async () => {
    const userId = await connectedUser(new Date("2026-09-21T12:00:00Z"));
    const first = await createPair(userId, { active: true });
    const second = await createPair(userId);
    await seedImport(userId);
    await importHistoryPage({ userId, pageSize: 50 });
    await activateShoe(userId, second.id);

    const result = await syncGarmin({ userId, now: NOW });

    expect(result.activitiesSeen).toBe(3);
    expect(result.activitiesWritten).toBe(0);
    const runs = await pairsOfRuns(userId);
    expect(Object.entries(runs).filter(([, shoeId]) => shoeId !== null)).toEqual(
      [10_000_000_005, TREADMILL, LONG_RUN].map((id) => [String(id), first.id]),
    );
  });
});
