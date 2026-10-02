import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BEST_EFFORTS_VERSION } from "@running-coach/engine";
import { ErrorCode } from "@running-coach/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Job, JobWithMetadata } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, bestEffort, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import { enqueueBestEfforts, enqueueSyncGarmin, startJobs, stopJobs } from "../../src/jobs";
import * as bestEffortsJob from "../../src/jobs/best-efforts";
import { getBoss } from "../../src/jobs/boss";
import { connectGarmin, createRun, createUser, garminBundle, setSettings } from "../seed";

// The best-efforts job on pg-boss with every worker running, against the Garmin service in fixture mode,
// which serves its detail fixture for any run of the fixture account. The workers chain batches without
// the production gap; tests that check the gap call `handle` directly.

const NOW = new Date("2026-09-28T10:00:00Z");
// Twelve outdoor runs of the fixture account's history, for two chained batches.
const HISTORY_RUNS = [
  9_000_000_042, 9_000_000_039, 9_000_000_037, 9_000_000_035, 9_000_000_034, 9_000_000_033,
  9_000_000_032, 9_000_000_030, 9_000_000_029, 9_000_000_028, 9_000_000_026, 9_000_000_024,
];
const LONG_RUN = 10_000_000_007;

async function connectedUser(bundle = garminBundle()): Promise<string> {
  const userId = await createUser();
  await setSettings(userId, { timezone: "Europe/Berlin" });
  await connectGarmin(userId, bundle);
  return userId;
}

/** One outdoor run per id, a day apart, the first newest. */
async function createRuns(userId: string, ids: readonly number[]) {
  for (const [index, garminActivityId] of ids.entries()) {
    await createRun(userId, {
      garminActivityId,
      startUtc: new Date(Date.UTC(2026, 8, 27 - index, 6)),
      startLocal: `2026-09-${String(27 - index).padStart(2, "0")} 08:00:00`,
    });
  }
}

async function pendingRuns(userId: string): Promise<number> {
  const rows = await db
    .select({ id: activity.id })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        eq(activity.isIndoor, false),
        eq(activity.isManual, false),
        isNull(activity.bestEffortsVersion),
      ),
    );
  return rows.length;
}

/** The user's best-efforts jobs, oldest first. */
async function userJobs(userId: string): Promise<JobWithMetadata[]> {
  const jobs = await getBoss().findJobs<object>(bestEffortsJob.name, { key: userId });
  return jobs.sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime());
}

async function queuedJobs(userId: string): Promise<string[]> {
  const jobs = await getBoss().findJobs(bestEffortsJob.name, { key: userId, queued: true });
  return jobs.map((job) => job.id);
}

async function findJob(id: string | null | undefined): Promise<JobWithMetadata | undefined> {
  if (!id) throw new Error("no job id");
  const [job] = await getBoss().findJobs<object>(bestEffortsJob.name, { id });
  return job;
}

async function waitForJob(id: string | null): Promise<JobWithMetadata> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const job = await findJob(id);
    if (job && ["completed", "failed"].includes(job.state)) return job;
    await sleep(100);
  }
  throw new Error(`job ${id ?? "null"} did not finish`);
}

/** Waits until the user has no pending run and every best-efforts job of theirs has finished. */
async function waitForChain(userId: string): Promise<JobWithMetadata[]> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const jobs = await userJobs(userId);
    const finished = jobs.every((job) => ["completed", "failed"].includes(job.state));
    if (jobs.length > 0 && finished && (await pendingRuns(userId)) === 0) return jobs;
    await sleep(100);
  }
  throw new Error("the best-efforts chain did not finish");
}

async function waitForJobState(
  id: string | null,
  state: JobWithMetadata["state"],
): Promise<JobWithMetadata> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const job = await findJob(id);
    if (job?.state === state) return job;
    await sleep(100);
  }
  throw new Error(`job ${id ?? "null"} did not reach ${state}`);
}

function secondsUntil(date: Date | undefined): number {
  return ((date?.getTime() ?? 0) - Date.now()) / 1000;
}

/** A job as the worker hands it to the handler, for calling `handle` directly. */
function runningJob(userId: string): Job<unknown> {
  return {
    id: randomUUID(),
    name: bestEffortsJob.name,
    data: { userId },
    signal: new AbortController().signal,
    expireInSeconds: 600,
    heartbeatSeconds: null,
    retryCount: 0,
  };
}

beforeAll(async () => {
  await startJobs({ pollingIntervalSeconds: 0.5, clock: () => NOW, bestEffortsGapSeconds: 0 });
});

afterAll(async () => {
  await stopJobs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("best-efforts job", () => {
  it("chains batches until no run is pending, fetching Garmin's records with the last (more than one batch)", async () => {
    const userId = await connectedUser();
    await createRuns(userId, HISTORY_RUNS);

    const first = await enqueueBestEfforts({ userId });

    const jobs = await waitForChain(userId);
    expect(jobs.map((job) => job.state)).toEqual(["completed", "completed"]);
    expect(jobs[0]?.id).toBe(first);
    expect(jobs[0]?.output).toEqual({
      status: "ok",
      processed: 10,
      failed: 0,
      skipped: 0,
      remaining: 2,
      nextJobId: jobs[1]?.id,
    });
    expect(jobs[1]?.output).toEqual({
      status: "ok",
      processed: 2,
      failed: 0,
      skipped: 0,
      remaining: 0,
      nextJobId: null,
    });
    const [stored] = await db
      .select({ records: garminConnection.garminRecords })
      .from(garminConnection)
      .where(eq(garminConnection.userId, userId));
    expect(stored?.records).toHaveLength(5);
  });

  it("finds nothing pending and calls no one when it runs again (a job firing twice)", async () => {
    const userId = await connectedUser();
    await createRuns(userId, [LONG_RUN]);
    await waitForJob(await enqueueBestEfforts({ userId }));
    const efforts = await db.select().from(bestEffort).where(eq(bestEffort.userId, userId));
    const series = vi.spyOn(garminClient, "series");

    const job = await waitForJob(await enqueueBestEfforts({ userId }));

    expect(job.output).toEqual({
      status: "ok",
      processed: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
      nextJobId: null,
    });
    expect(series).not.toHaveBeenCalled();
    expect(await db.select().from(bestEffort).where(eq(bestEffort.userId, userId))).toEqual(
      efforts,
    );
  });

  it("queues its successor BATCH_GAP_S after a batch while runs are pending (paced backfill)", async () => {
    const userId = await connectedUser();
    await createRuns(userId, HISTORY_RUNS);

    const output = await bestEffortsJob.handle(getBoss(), runningJob(userId));

    expect(output).toMatchObject({
      status: "ok",
      processed: 10,
      failed: 0,
      skipped: 0,
      remaining: 2,
    });
    const next = await findJob((output as { nextJobId: string | null }).nextJobId);
    expect(next?.state).toBe("created");
    expect(secondsUntil(next?.startAfter)).toBeGreaterThan(bestEffortsJob.BATCH_GAP_S - 5);
    expect(secondsUntil(next?.startAfter)).toBeLessThanOrEqual(bestEffortsJob.BATCH_GAP_S);
    // A sync's send while the successor waits folds into it.
    expect(await enqueueBestEfforts({ userId })).toBeNull();
    expect(await queuedJobs(userId)).toEqual([next?.id]);
  });

  it("rethrows garmin_unavailable so pg-boss retries, leaving the runs pending (Garmin outage)", async () => {
    const userId = await connectedUser(garminBundle("unavailable"));
    await createRuns(userId, [LONG_RUN]);

    await expect(bestEffortsJob.handle(getBoss(), runningJob(userId))).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });
    const retrying = await waitForJobState(await enqueueBestEfforts({ userId }), "retry");

    // Backoff from a 5-minute delay: the retry starts 5 to 10 minutes after the failed attempt.
    expect(secondsUntil(retrying.startAfter)).toBeGreaterThan(250);
    expect(await pendingRuns(userId)).toBe(1);
    const [run] = await db
      .select({ attempts: activity.bestEffortsAttempts })
      .from(activity)
      .where(eq(activity.userId, userId));
    expect(run?.attempts).toBe(0);
  });

  it("folds repeated sends into the one batch already queued for the user", async () => {
    const userId = await connectedUser();
    await createRuns(userId, [LONG_RUN]);
    // Not due for a minute, so the worker leaves it queued while the sends come in.
    const queued = await getBoss().send(
      bestEffortsJob.name,
      { userId },
      { ...bestEffortsJob.sendOptions({ userId }), startAfter: 60 },
    );

    const sends = await Promise.all([
      enqueueBestEfforts({ userId }),
      enqueueBestEfforts({ userId }),
    ]);

    expect(queued).not.toBeNull();
    expect(sends).toEqual([null, null]);
    expect(await queuedJobs(userId)).toEqual([queued]);
  });

  it("computes the runs a sync stored, queued by the sync job (new runs after sync)", async () => {
    const userId = await connectedUser();

    const syncJob = await enqueueSyncGarmin({ userId, trigger: "user" });

    await waitForChain(userId);
    const [sync] = await getBoss().findJobs<object>("sync-garmin", { id: syncJob ?? "" });
    expect(sync?.state).toBe("completed");
    const computed = await db
      .select({ id: activity.id })
      .from(activity)
      .where(
        and(eq(activity.userId, userId), eq(activity.bestEffortsVersion, BEST_EFFORTS_VERSION)),
      );
    // The fixture's seven runs less the treadmill and the manual entry.
    expect(computed).toHaveLength(5);
  });

  it("reschedules itself after retryAfterSeconds on a 429 without counting a failed attempt (Garmin 429)", async () => {
    const userId = await connectedUser(garminBundle("rate_limited"));
    await createRuns(userId, [LONG_RUN]);

    const job = await waitForJob(await enqueueBestEfforts({ userId }));

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toMatchObject({ status: "rate_limited", retryAfterSeconds: 3600 });
    const [nextId] = (job.output as { rescheduledJobIds: string[] }).rescheduledJobIds;
    const next = await findJob(nextId);
    expect(next?.state).toBe("created");
    expect(next?.data).toEqual({ userId });
    expect(secondsUntil(next?.startAfter)).toBeGreaterThan(3500);
    expect(secondsUntil(next?.startAfter)).toBeLessThanOrEqual(3600);
    expect(await pendingRuns(userId)).toBe(1);
    // A sync's send while the successor waits does not reach Garmin before the delay.
    expect(await enqueueBestEfforts({ userId })).toBeNull();
    expect(await queuedJobs(userId)).toEqual([nextId]);
  });

  it("pushes back the user's waiting batch on a 429 instead of queueing one beside it (429 with a queued job)", async () => {
    const userId = await connectedUser(garminBundle("rate_limited"));
    await createRuns(userId, [LONG_RUN]);
    const waiting = await getBoss().send(
      bestEffortsJob.name,
      { userId },
      { ...bestEffortsJob.sendOptions({ userId }), startAfter: 60 },
    );

    const output = await bestEffortsJob.handle(getBoss(), runningJob(userId));

    expect(output).toEqual({
      status: "rate_limited",
      retryAfterSeconds: 3600,
      rescheduledJobIds: [waiting],
    });
    expect(await queuedJobs(userId)).toEqual([waiting]);
    expect(secondsUntil((await findJob(waiting))?.startAfter)).toBeGreaterThan(3500);
  });

  it("completes without retrying when Garmin rejects the login (token expiry)", async () => {
    const userId = await connectedUser(garminBundle("expired"));
    await createRuns(userId, [LONG_RUN]);

    const job = await waitForJob(await enqueueBestEfforts({ userId }));

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toEqual({ status: ErrorCode.garminAuthExpired });
    expect(await pendingRuns(userId)).toBe(1);
    expect(await queuedJobs(userId)).toEqual([]);
  });

  it("completes without retrying when the user has no Garmin connection", async () => {
    const userId = await createUser();
    await createRuns(userId, [LONG_RUN]);

    const output = await bestEffortsJob.handle(getBoss(), runningJob(userId));

    expect(output).toEqual({ status: ErrorCode.garminNotConnected });
  });
});
