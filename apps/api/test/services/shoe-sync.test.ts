import { ErrorCode, type GarminActivitySummary } from "@running-coach/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as analyzeRunQueue from "../../src/jobs/analyze-run-queue";
import * as bestEffortsQueue from "../../src/jobs/best-efforts-queue";
import { startBoss, stopBoss } from "../../src/jobs/boss";
import { DomainError } from "../../src/lib/errors";
import { syncGarmin, writeActivities } from "../../src/services/garmin-sync";
import { importHistoryPage } from "../../src/services/history-import";
import { activateShoe, listShoes, setActivityShoe } from "../../src/services/shoes";
import { connectGarmin, createUser, seedImport } from "../seed";
import { createPair, pairsOfRuns } from "../seed-shoes";

// Which pair a sync puts on a run (slice 52), on the real Postgres against the Garmin service in fixture
// mode: the active pair goes on each run the sync inserts, once, and nothing reassigns it. The fixture's
// seven runs start 2026-08-30 22:40 to 2026-09-27 06:00 UTC, one of them the treadmill of 09-24; from
// CURSOR the sync reads all seven. pg-boss runs without workers, so a queued job stays queued.

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

  it("never reassigns a run on a re-sync, also after the active pair changed (re-sync)", async () => {
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

  it("puts the pair on each run once when two syncs overlap, and a later pair changes none (overlapping syncs)", async () => {
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
    const summaries: GarminActivitySummary[] = [1, 2, 3].map((n) => ({
      garminActivityId: 500 + n,
      type: "running",
      startUtc: `2026-09-2${n}T06:00:00Z`,
      startLocal: `2026-09-2${n}T08:00:00`,
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
    }));
    const write = () =>
      db.transaction((tx) => writeActivities(userId, summaries, tx, { wearActivePair: true }));

    const [a, b] = await Promise.all([write(), write()]);
    await activateShoe(userId, (await createPair(userId)).id);
    const again = await write();

    expect(a.insertedIds.length + b.insertedIds.length).toBe(3);
    expect(again.insertedIds).toEqual([]);
    expect(await pairsOfRuns(userId)).toEqual(allOn(first.id, [501, 502, 503]));
  });

  it("puts no pair on the history import's runs, which predate it (import)", async () => {
    const userId = await connectedUser();
    await createPair(userId, { active: true });
    await seedImport(userId);

    const page = await importHistoryPage({ userId, pageSize: 50 });

    expect(page.status).toBe("done");
    const runs = Object.values(await pairsOfRuns(userId));
    expect(runs).toHaveLength(46);
    expect(runs.every((shoeId) => shoeId === null)).toBe(true);
  });
});
