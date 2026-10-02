import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ErrorCode } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import type { Job, JobWithMetadata } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import {
  activity,
  garminConnection,
  type ImportProgressRow,
  importProgress,
} from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import { startJobs, stopJobs } from "../../src/jobs";
import { getBoss, startBoss } from "../../src/jobs/boss";
import * as importJob from "../../src/jobs/import-history";
import { DomainError } from "../../src/lib/errors";
import {
  getImportProgress,
  importHistoryPage,
  startImport,
} from "../../src/services/history-import";
import {
  connectGarmin,
  createUser,
  FIXTURE_ACCOUNT,
  fixturesSentTo,
  garminBundle,
  seedImport,
  setGarminBundle,
  storedImport,
} from "../seed";

// The import-history job on the real Postgres, against the Garmin service in fixture mode (49 items, 46
// runs). Pages of 10 re-read 5: offsets 0, 5, ..., 40. The first describe calls the handler directly with no
// import worker running; the second starts the workers and lets pg-boss chain the pages.

const PAGE_SIZE = 10;

async function connectedUser(bundle = garminBundle()): Promise<string> {
  const userId = await createUser();
  await connectGarmin(userId, bundle);
  return userId;
}

async function runCount(userId: string): Promise<number> {
  return (await db.select().from(activity).where(eq(activity.userId, userId))).length;
}

/** A job as the worker hands it to the handler, with metadata, for calling `handle` directly. */
function pageJob(userId: string, retryCount = 0): Job<unknown> & { retryLimit: number } {
  return {
    id: randomUUID(),
    name: importJob.name,
    data: { userId },
    signal: new AbortController().signal,
    expireInSeconds: 600,
    heartbeatSeconds: null,
    retryCount,
    retryLimit: importJob.jobOptions.retryLimit,
  };
}

async function findJob(id: string | null | undefined): Promise<JobWithMetadata | undefined> {
  if (!id) throw new Error("no job id");
  const [job] = await getBoss().findJobs<object>(importJob.name, { id });
  return job;
}

/** The user's page jobs, oldest first. */
async function userJobs(userId: string): Promise<JobWithMetadata[]> {
  const jobs = await getBoss().findJobs<object>(importJob.name, { key: userId });
  return jobs.sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime());
}

async function queuedJobs(userId: string): Promise<JobWithMetadata[]> {
  return getBoss().findJobs<object>(importJob.name, { key: userId, queued: true });
}

function secondsUntil(date: Date | undefined): number {
  return ((date?.getTime() ?? 0) - Date.now()) / 1000;
}

/** Waits until the user's import reaches a status (the stored one) and returns the row. */
async function waitForImport(
  userId: string,
  status: ImportProgressRow["status"],
): Promise<ImportProgressRow> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [row] = await db.select().from(importProgress).where(eq(importProgress.userId, userId));
    if (row?.status === status) return row;
    await sleep(100);
  }
  throw new Error(`the import did not reach ${status}`);
}

/** Waits until the user has a job in a finished state and returns it. */
async function waitForFinishedJob(userId: string): Promise<JobWithMetadata> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const finished = (await userJobs(userId)).find((job) =>
      ["completed", "failed"].includes(job.state),
    );
    if (finished) return finished;
    await sleep(100);
  }
  throw new Error("no job finished");
}

/** Waits until one of the user's page jobs is in `state` and returns it. */
async function waitForJobState(
  userId: string,
  state: JobWithMetadata["state"],
): Promise<JobWithMetadata> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const found = (await userJobs(userId)).find((job) => job.state === state);
    if (found) return found;
    await sleep(100);
  }
  throw new Error(`no job reached ${state}`);
}

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(importJob.name, importJob.queue);
});

afterAll(async () => {
  await stopJobs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("import-history job handler", () => {
  it("imports a page and queues the next under an id keyed on the import and offset, once however often it is queued (a page firing twice)", async () => {
    const userId = await connectedUser();
    const started = await seedImport(userId);

    const output = await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });

    const nextId = importJob.pageJobId(userId, started.startedAt, 5);
    expect(output).toMatchObject({
      status: "continued",
      start: 0,
      nextOffset: 5,
      nextJobId: nextId,
    });
    // The same page queueing its successor again is a no-op.
    expect(
      await getBoss().send(importJob.name, { userId }, importJob.sendOptions({ userId }, nextId)),
    ).toBeNull();
    expect((await queuedJobs(userId)).map((job) => job.id)).toEqual([nextId]);
    expect((await findJob(nextId))?.data).toEqual({ userId });
  });

  it("ends without queueing a successor on Garmin's short last page", async () => {
    const userId = await connectedUser();
    await seedImport(userId, { nextOffset: 40 });

    const output = await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });

    expect(output).toMatchObject({ status: "done", start: 40, nextOffset: FIXTURE_ACCOUNT.listed });
    expect(await queuedJobs(userId)).toEqual([]);
    expect((await storedImport(userId)).status).toBe("done");
  });

  it("pauses the import on a 429 and defers its page past retryAfter, keeping the cursor (Garmin 429)", async () => {
    const userId = await connectedUser();
    await seedImport(userId, { nextOffset: 10 });
    await setGarminBundle(userId, garminBundle("rate_limited"));

    const output = await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });

    if (output.status !== "paused") throw new Error(`expected paused, got ${output.status}`);
    expect(output.retryAfterSeconds).toBe(3600);
    const [deferred] = output.rescheduledJobIds;
    const next = await findJob(deferred);
    expect(next).toMatchObject({ state: "created", data: { userId } });
    expect(secondsUntil(next?.startAfter)).toBeGreaterThan(3500);
    expect(secondsUntil(next?.startAfter)).toBeLessThanOrEqual(3600);
    expect(await storedImport(userId)).toMatchObject({
      status: "paused",
      nextOffset: 10,
      resumeAt: output.resumeAt,
      lastError: ErrorCode.garminRateLimited,
    });
    expect(secondsUntil(output.resumeAt)).toBeGreaterThan(3500);
    expect(await getImportProgress(userId)).toMatchObject({
      status: "paused",
      resumeAt: output.resumeAt.toISOString(),
      errorCode: ErrorCode.garminRateLimited,
    });
  });

  it("calls no Garmin during the hour after a 429 and moves the waiting page by the seconds left (Garmin 429)", async () => {
    const userId = await connectedUser();
    await seedImport(userId, { nextOffset: 10 });
    await setGarminBundle(userId, garminBundle("rate_limited"));
    const first = await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });
    if (first.status !== "paused") throw new Error(`expected paused, got ${first.status}`);
    // The 429 was half an hour ago.
    await db
      .update(garminConnection)
      .set({ updatedAt: new Date(Date.now() - 1800 * 1000) })
      .where(eq(garminConnection.userId, userId));
    const sent = fixturesSentTo("/history");

    const output = await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });

    if (output.status !== "paused") throw new Error(`expected paused, got ${output.status}`);
    expect(sent()).toEqual([]);
    expect(output.retryAfterSeconds).toBeGreaterThan(1790);
    expect(output.retryAfterSeconds).toBeLessThanOrEqual(1800);
    // The page already waiting moved; no second one was queued beside it.
    expect(output.rescheduledJobIds).toEqual(first.rescheduledJobIds);
    expect((await queuedJobs(userId)).map((job) => job.id)).toEqual(first.rescheduledJobIds);
    expect(
      secondsUntil((await findJob(first.rescheduledJobIds[0]))?.startAfter),
    ).toBeLessThanOrEqual(1800);
    expect(await storedImport(userId)).toMatchObject({ status: "paused", nextOffset: 10 });
  });

  it("carries on from the stored cursor when the deferred page runs after the hour (Garmin 429)", async () => {
    const userId = await connectedUser();
    await seedImport(userId, { nextOffset: 10 });
    await setGarminBundle(userId, garminBundle("rate_limited"));
    await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });
    await setGarminBundle(userId, garminBundle(), new Date(Date.now() - 3601 * 1000));

    const output = await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });

    expect(output).toMatchObject({ status: "continued", start: 10, nextOffset: 15 });
    expect(await storedImport(userId)).toMatchObject({
      status: "running",
      nextOffset: 15,
      resumeAt: null,
      lastError: null,
    });
  });

  it("fails the import and completes without a retry when Garmin rejects the login (token expiry)", async () => {
    const userId = await connectedUser(garminBundle("expired"));
    await seedImport(userId, { nextOffset: 10 });

    const output = await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });

    expect(output).toEqual({ status: "failed", code: ErrorCode.garminAuthExpired });
    expect(await storedImport(userId)).toMatchObject({
      status: "failed",
      nextOffset: 10,
      lastError: ErrorCode.garminAuthExpired,
    });
    expect(await queuedJobs(userId)).toEqual([]);
  });

  it("fails the import with garmin_not_connected when the login was removed", async () => {
    const userId = await createUser();
    await seedImport(userId);

    const output = await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });

    expect(output).toEqual({ status: "failed", code: ErrorCode.garminNotConnected });
    expect((await storedImport(userId)).lastError).toBe(ErrorCode.garminNotConnected);
  });

  it("rethrows any other error for pg-boss to retry, and fails the import with its code only on the last attempt (Garmin outage)", async () => {
    const userId = await connectedUser(garminBundle("unavailable"));
    await seedImport(userId, { nextOffset: 10 });

    await expect(
      importJob.handle(getBoss(), pageJob(userId, 0), { pageSize: PAGE_SIZE }),
    ).rejects.toMatchObject({ code: ErrorCode.garminUnavailable });
    const afterFirst = await storedImport(userId);
    await expect(
      importJob.handle(getBoss(), pageJob(userId, importJob.jobOptions.retryLimit), {
        pageSize: PAGE_SIZE,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.garminUnavailable });

    expect(afterFirst).toMatchObject({ status: "running", lastError: null });
    expect(await storedImport(userId)).toMatchObject({
      status: "failed",
      nextOffset: 10,
      lastError: ErrorCode.garminUnavailable,
    });
  });

  it("fails the import as internal on the last attempt of an error without a code", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    vi.spyOn(garminClient, "history").mockRejectedValue(new Error("socket hang up"));

    await expect(
      importJob.handle(getBoss(), pageJob(userId, importJob.jobOptions.retryLimit), {
        pageSize: PAGE_SIZE,
      }),
    ).rejects.toThrow("socket hang up");

    expect(await storedImport(userId)).toMatchObject({
      status: "failed",
      lastError: ErrorCode.internal,
    });
  });

  it("skips a page whose import is done, and queues nothing", async () => {
    const userId = await connectedUser();
    await seedImport(userId, { status: "done", finishedAt: new Date() });

    const output = await importJob.handle(getBoss(), pageJob(userId), { pageSize: PAGE_SIZE });

    expect(output).toEqual({ status: "skipped" });
    expect(await queuedJobs(userId)).toEqual([]);
  });
});

describe("import-history job on pg-boss", () => {
  beforeAll(async () => {
    await startJobs({ pollingIntervalSeconds: 0.5, historyPageSize: PAGE_SIZE });
  });

  it("imports the whole history through chained page jobs, one per page (imported count equals Garmin's)", async () => {
    const userId = await connectedUser();

    await startImport(userId);
    const done = await waitForImport(userId, "done");

    expect(done).toMatchObject({
      nextOffset: FIXTURE_ACCOUNT.listed,
      cursorDate: FIXTURE_ACCOUNT.oldestRunDate,
    });
    expect(await runCount(userId)).toBe(FIXTURE_ACCOUNT.runs);
    const jobs = await userJobs(userId);
    expect(jobs).toHaveLength(9);
    expect(jobs.every((job) => job.state === "completed" && job.retryCount === 0)).toBe(true);
    expect(jobs.at(-1)?.output).toMatchObject({ status: "done" });
  });

  it("retries a page job that threw and continues from the stored cursor (killed import)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    await importHistoryPage({ userId, pageSize: PAGE_SIZE });
    await importHistoryPage({ userId, pageSize: PAGE_SIZE });
    const original = garminClient.history.bind(garminClient);
    const starts: number[] = [];
    const spy = vi.spyOn(garminClient, "history").mockImplementation(async (request, options) => {
      starts.push(request.start);
      return original(request, options);
    });
    spy.mockImplementationOnce((request) => {
      starts.push(request.start);
      return Promise.reject(new DomainError(ErrorCode.garminUnavailable, 502, "Garmin is down."));
    });

    // As the chain sends it, but retried at once rather than five minutes later.
    const { retryDelayMax: _max, ...options } = importJob.sendOptions({ userId });
    const id = await getBoss().send(
      importJob.name,
      { userId },
      { ...options, retryBackoff: false, retryDelay: 0 },
    );
    await waitForImport(userId, "done");

    expect(starts).toEqual([10, 10, 15, 20, 25, 30, 35, 40]);
    expect(await findJob(id)).toMatchObject({ state: "completed", retryCount: 1 });
    expect(await runCount(userId)).toBe(FIXTURE_ACCOUNT.runs);
  });

  it("keeps an import whose page waits for its retry running, and a POST queues nothing beside it (Garmin outage)", async () => {
    const userId = await connectedUser(garminBundle("unavailable"));
    const sent = fixturesSentTo("/history");

    await startImport(userId);
    const retrying = await waitForJobState(userId, "retry");
    const progress = await getImportProgress(userId);
    const resumed = await startImport(userId);

    // Backoff from a 5-minute delay: the retry starts 5 to 10 minutes after the failed attempt.
    expect(secondsUntil(retrying.startAfter)).toBeGreaterThan(250);
    expect(progress).toMatchObject({ status: "running", errorCode: null });
    expect(resumed.status).toBe("running");
    expect((await userJobs(userId)).map((job) => [job.id, job.state])).toEqual([
      [retrying.id, "retry"],
    ]);
    expect(sent()).toEqual(["unavailable"]);
  });

  it("resumes a stalled import with exactly one page, and the chain finishes from the stored cursor (stalled)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    // Two pages ran, then the chain was lost: the row says running and pg-boss holds no page.
    await importHistoryPage({ userId, pageSize: PAGE_SIZE });
    await importHistoryPage({ userId, pageSize: PAGE_SIZE });
    const stalled = await getImportProgress(userId);
    const original = garminClient.history.bind(garminClient);
    const starts: number[] = [];
    vi.spyOn(garminClient, "history").mockImplementation(async (request, options) => {
      starts.push(request.start);
      return original(request, options);
    });

    await startImport(userId);
    await waitForImport(userId, "done");

    expect(stalled.status).toBe("stalled");
    expect(starts).toEqual([10, 15, 20, 25, 30, 35, 40]);
    const jobs = await userJobs(userId);
    expect(jobs).toHaveLength(7);
    expect(jobs.every((job) => job.state === "completed" && job.retryCount === 0)).toBe(true);
    expect(await runCount(userId)).toBe(FIXTURE_ACCOUNT.runs);
  });

  it("runs the deferred page of a paused import and leaves it running when Garmin fails that page (Garmin outage after a 429)", async () => {
    const userId = await connectedUser(garminBundle("unavailable"));
    await seedImport(userId, {
      status: "paused",
      nextOffset: 10,
      resumeAt: new Date(Date.now() - 60_000),
      lastError: ErrorCode.garminRateLimited,
    });

    // The page the 429 deferred, now due.
    await getBoss().send(importJob.name, { userId }, importJob.sendOptions({ userId }));
    const retrying = await waitForJobState(userId, "retry");

    expect(secondsUntil(retrying.startAfter)).toBeGreaterThan(250);
    expect(await storedImport(userId)).toMatchObject({
      status: "running",
      nextOffset: 10,
      resumeAt: null,
      lastError: null,
    });
    expect(await getImportProgress(userId)).toMatchObject({
      status: "running",
      resumeAt: null,
      errorCode: null,
    });
  });

  it("completes a 429 page without a failed attempt and moves its page past retryAfter (Garmin 429)", async () => {
    const userId = await connectedUser(garminBundle("rate_limited"));

    await startImport(userId);
    const job = await waitForFinishedJob(userId);

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toMatchObject({ status: "paused", retryAfterSeconds: 3600 });
    const queued = await queuedJobs(userId);
    expect(queued).toHaveLength(1);
    expect(secondsUntil(queued[0]?.startAfter)).toBeGreaterThan(3500);
    expect(await storedImport(userId)).toMatchObject({
      status: "paused",
      nextOffset: 0,
      lastError: ErrorCode.garminRateLimited,
    });
  });

  it("fails an import whose login Garmin rejects and completes without retrying (token expiry)", async () => {
    const userId = await connectedUser(garminBundle("expired"));

    await startImport(userId);
    const job = await waitForFinishedJob(userId);

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toEqual({ status: "failed", code: ErrorCode.garminAuthExpired });
    expect(await storedImport(userId)).toMatchObject({
      status: "failed",
      lastError: ErrorCode.garminAuthExpired,
    });
    expect(await queuedJobs(userId)).toEqual([]);
  });
});
