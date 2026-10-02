import { setTimeout as sleep } from "node:timers/promises";
import { ErrorCode } from "@running-coach/shared";
import { asc, eq } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import { enqueueSyncGarmin, startJobs, stopJobs } from "../../src/jobs";
import { deterministicJobId, getBoss } from "../../src/jobs/boss";
import * as syncJob from "../../src/jobs/sync-garmin";
import { decrypt } from "../../src/lib/crypto";
import { DomainError } from "../../src/lib/errors";
import { noonUtc } from "../../src/lib/local-date";
import { syncGarmin } from "../../src/services/garmin-sync";
import { connectGarmin, createSettings, createUser, fixturesSentTo, garminBundle } from "../seed";

// The sync job and service on the real Postgres, against the Garmin service in fixture mode. The fixture
// runs lie between 2026-08-31 and 2026-09-27; "today" 2026-09-28 (NOW, midday in Berlin) makes the first
// sync (30 days back) read all seven in five 7-day chunks.

const TODAY = "2026-09-28";
const NOW = new Date("2026-09-28T10:00:00Z");
const FIXTURE_RUNS = 7;
// The jobs' clock; a test may move it and afterEach puts it back.
let jobClock = NOW;

async function connectedUser(bundle = garminBundle()): Promise<string> {
  const userId = await createUser();
  await createSettings(userId, { timezone: "Europe/Berlin" });
  await connectGarmin(userId, bundle);
  return userId;
}

async function connection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection");
  return row;
}

async function runs(userId: string) {
  return db
    .select()
    .from(activity)
    .where(eq(activity.userId, userId))
    .orderBy(asc(activity.startUtc));
}

/** Lets every call through to the fixture service and records the ranges asked for. */
function recordSyncCalls() {
  const original = garminClient.sync.bind(garminClient);
  const calls: { startDate: string; endDate: string }[] = [];
  const spy = vi.spyOn(garminClient, "sync").mockImplementation(async (request, options) => {
    calls.push({ startDate: request.startDate, endDate: request.endDate });
    return original(request, options);
  });
  return { calls, spy, original };
}

async function storedBundle(userId: string): Promise<{ fixture?: string }> {
  return JSON.parse(decrypt((await connection(userId)).tokenBundleEnc, userId)) as {
    fixture?: string;
  };
}

async function waitForJob(id: string): Promise<JobWithMetadata> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await getBoss().getJobById<object>(syncJob.name, id);
    if (job && ["completed", "failed"].includes(job.state)) return job;
    await sleep(100);
  }
  throw new Error(`job ${id} did not finish`);
}

beforeAll(async () => {
  await startJobs({ pollingIntervalSeconds: 0.5, clock: () => jobClock });
});

afterAll(async () => {
  await stopJobs();
});

afterEach(() => {
  vi.restoreAllMocks();
  jobClock = NOW;
});

describe("syncGarmin", () => {
  it("stores every run in the first 30 days once, oldest chunk first, and saves the cursor", async () => {
    const userId = await connectedUser();
    const { calls } = recordSyncCalls();

    const result = await syncGarmin({ userId, now: NOW });

    expect(result).toMatchObject({
      startDate: "2026-08-29",
      endDate: TODAY,
      chunks: 5,
      activitiesSeen: FIXTURE_RUNS,
      activitiesWritten: FIXTURE_RUNS,
    });
    expect(calls).toEqual([
      { startDate: "2026-08-29", endDate: "2026-09-04" },
      { startDate: "2026-09-05", endDate: "2026-09-11" },
      { startDate: "2026-09-12", endDate: "2026-09-18" },
      { startDate: "2026-09-19", endDate: "2026-09-25" },
      { startDate: "2026-09-26", endDate: TODAY },
    ]);
    const stored = await runs(userId);
    expect(stored).toHaveLength(FIXTURE_RUNS);
    // Just after local midnight in Berlin, still the previous day in UTC.
    expect(stored[0]).toMatchObject({
      startLocal: "2026-08-31 00:40:00",
      startUtc: new Date("2026-08-30T22:40:00Z"),
    });
    expect(stored.find((run) => run.type === "treadmill_running")?.isIndoor).toBe(true);
    expect(stored.find((run) => run.isManual)?.avgHr).toBeNull();
    expect(await connection(userId)).toMatchObject({
      status: "ok",
      lastError: null,
      // "today" is in the past here, so the cursor is noon UTC of it rather than now.
      lastSyncAt: noonUtc(TODAY),
    });
  });

  it("stores nothing new on a second run and only re-reads from the day before the cursor", async () => {
    const userId = await connectedUser();
    await syncGarmin({ userId, now: NOW });
    const before = await runs(userId);
    const { calls } = recordSyncCalls();

    const result = await syncGarmin({ userId, now: NOW });

    expect(calls).toEqual([{ startDate: "2026-09-27", endDate: TODAY }]);
    expect(result).toMatchObject({ activitiesSeen: 1, activitiesWritten: 0 });
    const after = await runs(userId);
    expect(after.map((run) => [run.id, run.updatedAt.getTime()])).toEqual(
      before.map((run) => [run.id, run.updatedAt.getTime()]),
    );
  });

  it("keeps finished chunks after an error and resumes from the cursor", async () => {
    const userId = await connectedUser();
    const { calls, spy, original } = recordSyncCalls();
    spy.mockImplementationOnce(async (request, options) => {
      calls.push({ startDate: request.startDate, endDate: request.endDate });
      return original(request, options);
    });
    spy.mockImplementationOnce(() => {
      throw new DomainError(ErrorCode.garminUnavailable, 502, "Garmin is not answering.");
    });

    await expect(syncGarmin({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });
    expect(await runs(userId)).toHaveLength(1);
    expect(await connection(userId)).toMatchObject({
      status: "ok",
      lastError: ErrorCode.garminUnavailable,
      lastSyncAt: noonUtc("2026-09-04"),
    });

    calls.length = 0;
    await syncGarmin({ userId, now: NOW });

    expect(calls[0]).toEqual({ startDate: "2026-09-03", endDate: "2026-09-09" });
    expect(await runs(userId)).toHaveLength(FIXTURE_RUNS);
    expect((await connection(userId)).lastError).toBeNull();
  });

  it("serializes two concurrent syncs for one user", async () => {
    const userId = await connectedUser();
    const original = garminClient.sync.bind(garminClient);
    const events: string[] = [];
    vi.spyOn(garminClient, "sync").mockImplementation(async (request, options) => {
      events.push(`start ${request.startDate}`);
      await sleep(20);
      const response = await original(request, options);
      events.push(`end ${request.startDate}`);
      return response;
    });

    const [first, second] = await Promise.all([
      syncGarmin({ userId, now: NOW }),
      syncGarmin({ userId, now: NOW }),
    ]);

    // Every call ends before the next one starts.
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]?.startsWith("start")).toBe(true);
      expect(events[index + 1]).toBe(events[index]?.replace("start", "end"));
    }
    // Whichever ran second started from the first one's cursor.
    expect([first.chunks, second.chunks].sort()).toEqual([1, 5]);
    expect(await runs(userId)).toHaveLength(FIXTURE_RUNS);
  });

  it("marks the connection expired and stores nothing when Garmin rejects the login", async () => {
    const userId = await connectedUser(garminBundle("expired"));

    await expect(syncGarmin({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminAuthExpired,
    });

    expect(await runs(userId)).toHaveLength(0);
    expect(await connection(userId)).toMatchObject({
      status: "expired",
      lastError: ErrorCode.garminAuthExpired,
      lastSyncAt: null,
    });

    // The dead login is not sent to Garmin again.
    const { calls } = recordSyncCalls();
    await expect(syncGarmin({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminAuthExpired,
    });
    expect(calls).toHaveLength(0);
  });

  it("writes a rotated bundle back, encrypted", async () => {
    const userId = await connectedUser(garminBundle("rotate"));
    const { calls, spy } = recordSyncCalls();

    await syncGarmin({ userId, now: NOW });

    const stored = await connection(userId);
    expect(stored.tokenBundleEnc.startsWith("v1:")).toBe(true);
    expect(JSON.parse(decrypt(stored.tokenBundleEnc, userId))).toMatchObject({
      fixture: "rotated",
    });
    // Every call after the rotation used the new bundle.
    expect(calls).toHaveLength(5);
    const sent = spy.mock.calls.map(([request]) => JSON.parse(request.tokenBundle) as object);
    expect(sent[0]).toMatchObject({ fixture: "rotate" });
    expect(
      sent.slice(1).every((bundle) => "fixture" in bundle && bundle.fixture === "rotated"),
    ).toBe(true);
  });

  it("writes back the bundle Garmin rotated before a 429, then throws garmin_rate_limited (rotate then 429)", async () => {
    const userId = await connectedUser(garminBundle("rotate_then_rate_limited"));

    await expect(syncGarmin({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminRateLimited,
    });

    expect(await storedBundle(userId)).toMatchObject({ fixture: "rotated" });
    expect(await connection(userId)).toMatchObject({
      status: "ok",
      lastError: ErrorCode.garminRateLimited,
    });
    expect(await runs(userId)).toHaveLength(0);
  });

  it("writes back the bundle Garmin rotated before a 502 and retries with it, not the stale one (rotate then 502)", async () => {
    const userId = await connectedUser(garminBundle("rotate_then_unavailable"));
    const sent = fixturesSentTo("/sync");

    const result = await syncGarmin({ userId, now: NOW });

    expect(sent()).toEqual(["rotate_then_unavailable", ...Array<string>(5).fill("rotated")]);
    expect(await storedBundle(userId)).toMatchObject({ fixture: "rotated" });
    expect(result.activitiesWritten).toBe(FIXTURE_RUNS);
  });

  it("syncs up to the user's local date at `now`, not the UTC date", async () => {
    const userId = await connectedUser();
    const { calls } = recordSyncCalls();

    // 00:30 on 2026-09-29 in Berlin, still 2026-09-28 in UTC.
    const result = await syncGarmin({ userId, now: new Date("2026-09-28T22:30:00Z") });

    expect(result.endDate).toBe("2026-09-29");
    expect(calls.at(-1)?.endDate).toBe("2026-09-29");
  });

  it("throws garmin_not_connected for a user without a Garmin connection", async () => {
    const userId = await createUser();

    await expect(syncGarmin({ userId, now: NOW })).rejects.toMatchObject({
      code: ErrorCode.garminNotConnected,
    });
  });
});

describe("sync-garmin job", () => {
  it("runs once for a user and date, however often it is enqueued", async () => {
    const userId = await connectedUser();
    const data = { userId, date: TODAY };

    const first = await enqueueSyncGarmin(data);
    const second = await enqueueSyncGarmin(data);

    expect(first).toBe(syncJob.jobId(data));
    expect(second).toBeNull();
    const job = await waitForJob(syncJob.jobId(data));
    expect(job.state).toBe("completed");
    expect(job.output).toMatchObject({ status: "ok", activitiesWritten: FIXTURE_RUNS });
    // Enqueued again after it finished: still the same id, still a no-op.
    expect(await enqueueSyncGarmin(data)).toBeNull();
    expect(await runs(userId)).toHaveLength(FIXTURE_RUNS);
  });

  it("reschedules itself after retryAfterSeconds on a 429 without counting a failed attempt", async () => {
    const userId = await connectedUser(garminBundle("rate_limited"));
    const data = { userId, date: TODAY };
    const id = await enqueueSyncGarmin(data);
    if (!id) throw new Error("not enqueued");

    const job = await waitForJob(id);

    expect(job.state).toBe("completed");
    expect(job.retryCount).toBe(0);
    expect(job.output).toMatchObject({ status: "rate_limited", retryAfterSeconds: 3600 });
    const next = await getBoss().getJobById(syncJob.name, deterministicJobId(`${id}:rate-limited`));
    expect(next?.state).toBe("created");
    expect(next?.data).toEqual(data);
    const delaySeconds = ((next?.startAfter.getTime() ?? 0) - Date.now()) / 1000;
    expect(delaySeconds).toBeGreaterThan(3500);
    expect(delaySeconds).toBeLessThanOrEqual(3600);
    expect(await connection(userId)).toMatchObject({
      status: "ok",
      lastError: ErrorCode.garminRateLimited,
    });
    expect(await runs(userId)).toHaveLength(0);
  });

  it("writes back the bundle Garmin rotated before a 429 and still reschedules (rotate then 429)", async () => {
    const userId = await connectedUser(garminBundle("rotate_then_rate_limited"));
    const id = await enqueueSyncGarmin({ userId, date: TODAY });
    if (!id) throw new Error("not enqueued");

    const job = await waitForJob(id);

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toMatchObject({ status: "rate_limited", retryAfterSeconds: 3600 });
    const next = await getBoss().getJobById(syncJob.name, deterministicJobId(`${id}:rate-limited`));
    expect(next?.state).toBe("created");
    expect(await storedBundle(userId)).toMatchObject({ fixture: "rotated" });
  });

  it("syncs up to the user's local date when it runs, not the date in its data (a job deferred by a 429)", async () => {
    const userId = await connectedUser();
    // Queued on 2026-09-20; runs at 00:30 on 2026-09-29 in Berlin, which is still 2026-09-28 in UTC.
    jobClock = new Date("2026-09-28T22:30:00Z");
    const id = await enqueueSyncGarmin({ userId, date: "2026-09-20" });
    if (!id) throw new Error("not enqueued");

    const job = await waitForJob(id);

    expect(job.state).toBe("completed");
    expect(job.output).toMatchObject({
      status: "ok",
      endDate: "2026-09-29",
      activitiesWritten: FIXTURE_RUNS,
    });
  });

  it("completes without retrying when the Garmin login has expired", async () => {
    const userId = await connectedUser(garminBundle("expired"));
    const id = await enqueueSyncGarmin({ userId, date: TODAY });
    if (!id) throw new Error("not enqueued");

    const job = await waitForJob(id);

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toEqual({ status: ErrorCode.garminAuthExpired });
    expect((await connection(userId)).status).toBe("expired");
  });
});
