import { ErrorCode } from "@running-coach/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, coachMessage } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as analyzeRunQueue from "../../src/jobs/analyze-run-queue";
import * as bestEffortsQueue from "../../src/jobs/best-efforts-queue";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import { DomainError } from "../../src/lib/errors";
import { syncGarmin } from "../../src/services/garmin-sync";
import { importHistoryPage } from "../../src/services/history-import";
import { queueRunInsights } from "../../src/services/insights";
import {
  claudeKey,
  connectGarmin,
  createRunOn,
  createUser,
  seedImport,
  setSettings,
} from "../seed";

// Which runs a sync queues the coach for, on the real Postgres against the Garmin service in fixture
// mode. Its seven runs start 2026-08-30 22:40 to 2026-09-27 06:00 UTC; with the sync's clock pinned at
// 2026-09-28 10:00 UTC, the last seven days hold two of them. pg-boss runs without workers, so a queued
// job stays queued.

const NOW = new Date("2026-09-28T10:00:00Z");
const CURSOR = new Date("2026-09-01T12:00:00Z");
/** The fixture runs that start within seven days of NOW: the 18 km of 09-27 and the treadmill of 09-24. */
const RECENT_RUNS = [10_000_000_007, 10_000_000_006];

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

async function connectedUser({ key = true, lastSyncAt = CURSOR } = {}): Promise<string> {
  const userId = await createUser();
  if (key) await setSettings(userId, { claudeKey: claudeKey("valid") });
  await connectGarmin(userId, undefined, { lastSyncAt });
  return userId;
}

/** The Garmin ids of the runs the user's analyze-run jobs are for. */
async function queuedRuns(userId: string): Promise<number[]> {
  const jobs = await getBoss().findJobs<{ activityId: string }>(analyzeRunQueue.name, {
    data: { userId },
  });
  if (jobs.length === 0) return [];
  const runs = await db
    .select({ garminActivityId: activity.garminActivityId })
    .from(activity)
    .where(
      inArray(
        activity.id,
        jobs.map((job) => job.data.activityId),
      ),
    );
  expect(runs).toHaveLength(jobs.length);
  return runs.map((run) => run.garminActivityId).sort((a, b) => b - a);
}

describe("queueing the coach after a sync", () => {
  it("queues one job per new run that started in the last seven days when a key is set", async () => {
    const userId = await connectedUser();

    const result = await syncGarmin({ userId, now: NOW });

    expect(result.activitiesWritten).toBe(7);
    expect(await queuedRuns(userId)).toEqual(RECENT_RUNS);
  });

  it("queues none when the user has no Claude key (no key)", async () => {
    const userId = await connectedUser({ key: false });

    await syncGarmin({ userId, now: NOW });

    expect(await queuedRuns(userId)).toEqual([]);
  });

  it("queues none for a run the sync updated rather than inserted (edited activity)", async () => {
    const userId = await connectedUser({ key: false });
    await syncGarmin({ userId, now: NOW });
    await setSettings(userId, { claudeKey: claudeKey("valid") });
    // Garmin now lists the 18 km differently from what is stored, so the next sync rewrites it.
    await db
      .update(activity)
      .set({ distanceM: 17_500 })
      .where(and(eq(activity.userId, userId), eq(activity.garminActivityId, 10_000_000_007)));

    const result = await syncGarmin({ userId, now: NOW });

    expect(result.activitiesWritten).toBeGreaterThan(0);
    expect(await queuedRuns(userId)).toEqual([]);
  });

  it("queues each new run once when two syncs overlap or a sync runs again (overlapping syncs)", async () => {
    const userId = await connectedUser();
    const send = vi.spyOn(getBoss(), "send");

    await Promise.all([syncGarmin({ userId, now: NOW }), syncGarmin({ userId, now: NOW })]);
    await syncGarmin({ userId, now: NOW });

    const sends = send.mock.calls.filter(([name]) => name === analyzeRunQueue.name);
    expect(sends).toHaveLength(RECENT_RUNS.length);
    expect(await queuedRuns(userId)).toEqual(RECENT_RUNS);
  });

  it("queues the runs the chunks before a failed one stored (partial sync)", async () => {
    // From 2026-09-19: chunks 09-19..09-25 (the treadmill of 09-24 and the 09-20 run) and 09-26..09-28.
    const userId = await connectedUser({ lastSyncAt: new Date("2026-09-20T12:00:00Z") });
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

    expect(await queuedRuns(userId)).toEqual([10_000_000_006]);
  });

  it("queues none for the history import's runs, however recent (import queues nothing)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);

    const page = await importHistoryPage({ userId, pageSize: 50 });

    expect(page.status).toBe("done");
    expect((await db.select().from(activity).where(eq(activity.userId, userId))).length).toBe(46);
    expect(await queuedRuns(userId)).toEqual([]);
  });
});

describe("queueRunInsights", () => {
  it("leaves out a run that already has a card, and one older than seven days", async () => {
    const userId = await createUser();
    await setSettings(userId, { claudeKey: claudeKey("valid") });
    const carded = await createRunOn(userId, "2026-09-27");
    const fresh = await createRunOn(userId, "2026-09-26");
    const old = await createRunOn(userId, "2026-09-20");
    await db.insert(coachMessage).values({
      userId,
      kind: "insight",
      activityId: carded.id,
      promptVersion: "run-insight/v1",
      content: {},
      fallbackReason: "refusal",
    });

    const queued = await queueRunInsights(userId, [carded.id, fresh.id, old.id], NOW);

    expect(queued).toBe(1);
    const jobs = await getBoss().findJobs(analyzeRunQueue.name, { data: { userId } });
    expect(jobs.map((job) => job.singletonKey)).toEqual([fresh.id]);
  });

  it("never throws: a failure to queue is logged and the sync goes on", async () => {
    const userId = await createUser();
    await setSettings(userId, { claudeKey: claudeKey("valid") });
    const run = await createRunOn(userId, "2026-09-27");
    vi.spyOn(getBoss(), "send").mockRejectedValue(new Error("pg-boss is down"));

    await expect(queueRunInsights(userId, [run.id], NOW)).resolves.toBe(0);
  });
});
