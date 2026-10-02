import { setTimeout as sleep } from "node:timers/promises";
import { ErrorCode } from "@running-coach/shared";
import { asc, eq } from "drizzle-orm";
import type { SendOptions } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import { stopJobs } from "../../src/jobs";
import { getBoss, startBoss } from "../../src/jobs/boss";
import * as importJob from "../../src/jobs/import-history";
import { decrypt } from "../../src/lib/crypto";
import { DomainError } from "../../src/lib/errors";
import { syncGarmin } from "../../src/services/garmin-sync";
import {
  getImportProgress,
  HISTORY_PAGE_OVERLAP,
  type ImportedPage,
  importHistoryPage,
} from "../../src/services/history-import";
import {
  connectGarmin,
  createUser,
  FIXTURE_ACCOUNT,
  fixtureOf,
  fixturesSentTo,
  garminBundle,
  seedImport,
  setGarminBundle,
  setSettings,
  storedImport,
} from "../seed";

// The history import's pages on the real Postgres, against the Garmin service in fixture mode, whose account
// lists 49 items (46 runs). Pages of 10 re-read 5, so the import takes nine pages: offsets 0, 5, ..., 40.

const PAGE_SIZE = 10;
const PAGE_STARTS = [0, 5, 10, 15, 20, 25, 30, 35, 40];

afterEach(() => {
  vi.restoreAllMocks();
});

async function connectedUser(bundle = garminBundle()): Promise<string> {
  const userId = await createUser();
  await setSettings(userId, { timezone: "Europe/Berlin" });
  await connectGarmin(userId, bundle);
  return userId;
}

async function runs(userId: string) {
  return db
    .select()
    .from(activity)
    .where(eq(activity.userId, userId))
    .orderBy(asc(activity.startUtc));
}

async function run(userId: string, garminActivityId: number) {
  const found = (await runs(userId)).find((row) => row.garminActivityId === garminActivityId);
  if (!found) throw new Error(`run ${garminActivityId} not stored`);
  return found;
}

async function connection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection");
  return row;
}

/** Lets every history call through to the fixture service and records the offsets asked for. */
function recordHistoryCalls() {
  const original = garminClient.history.bind(garminClient);
  const starts: number[] = [];
  const spy = vi.spyOn(garminClient, "history").mockImplementation(async (request, options) => {
    starts.push(request.start);
    return original(request, options);
  });
  return { starts, spy, original };
}

/** Runs pages until the import is done, at most `limit` of them; returns the pages. */
async function importPages(userId: string, limit = 20): Promise<ImportedPage[]> {
  const pages: ImportedPage[] = [];
  for (let index = 0; index < limit; index += 1) {
    const page = await importHistoryPage({ userId, pageSize: PAGE_SIZE });
    if (page.status === "skipped") throw new Error("page skipped");
    pages.push(page);
    if (page.status === "done") break;
  }
  return pages;
}

describe("importHistoryPage", () => {
  it("stores every run Garmin lists, in pages that re-read the last 5, and ends on the short page (imported count equals Garmin's)", async () => {
    const userId = await connectedUser();
    const started = await seedImport(userId);
    const { starts } = recordHistoryCalls();

    const pages = await importPages(userId);

    expect(starts).toEqual(PAGE_STARTS);
    expect(pages.map((page) => page.status)).toEqual([
      ...Array<string>(8).fill("continued"),
      "done",
    ]);
    expect(pages.reduce((sum, page) => sum + page.written, 0)).toBe(FIXTURE_ACCOUNT.runs);
    expect(await runs(userId)).toHaveLength(FIXTURE_ACCOUNT.runs);
    const progress = await getImportProgress(userId);
    expect(progress).toMatchObject({
      status: "done",
      runsStored: FIXTURE_ACCOUNT.runs,
      oldestDate: FIXTURE_ACCOUNT.oldestRunDate,
      startedAt: started.startedAt.toISOString(),
      resumeAt: null,
      errorCode: null,
    });
    expect(progress.finishedAt).not.toBeNull();
    expect(await storedImport(userId)).toMatchObject({ nextOffset: FIXTURE_ACCOUNT.listed });
    // The import is not the sync: its cursor stays where it was.
    expect(await connection(userId)).toMatchObject({
      status: "ok",
      lastError: null,
      lastSyncAt: null,
    });
  });

  it("skips walks, rides and strength sessions though the fake lists them (non-running activities)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);

    await importPages(userId);

    const stored = await runs(userId);
    const ids = stored.map((row) => row.garminActivityId);
    for (const nonRun of FIXTURE_ACCOUNT.nonRunIds) expect(ids).not.toContain(nonRun);
    expect(stored.every((row) => /^running$|_run(ning)?$/.test(row.type))).toBe(true);
  });

  it("resumes from the stored cursor after the import is killed after two pages (killed import)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    await importPages(userId, 2);

    const stopped = await storedImport(userId);
    expect(stopped).toMatchObject({ status: "running", nextOffset: 10, cursorDate: "2026-07-23" });
    // Items 0 to 14, one of them a walk.
    expect(await runs(userId)).toHaveLength(14);
    const { starts } = recordHistoryCalls();

    const pages = await importPages(userId);

    expect(starts).toEqual(PAGE_STARTS.slice(2));
    expect(pages.at(-1)?.status).toBe("done");
    expect(await runs(userId)).toHaveLength(FIXTURE_ACCOUNT.runs);
  });

  it("keeps the cursor and stores nothing for a page Garmin failed, then reads that page again (Garmin outage)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    await importPages(userId, 2);
    const { starts, spy, original } = recordHistoryCalls();
    spy.mockImplementationOnce(() => {
      starts.push(-1);
      throw new DomainError(ErrorCode.garminUnavailable, 502, "Garmin is not answering.");
    });

    await expect(importHistoryPage({ userId, pageSize: PAGE_SIZE })).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });
    expect(await storedImport(userId)).toMatchObject({ status: "running", nextOffset: 10 });
    expect((await connection(userId)).lastError).toBe(ErrorCode.garminUnavailable);
    spy.mockImplementation(async (request, options) => {
      starts.push(request.start);
      return original(request, options);
    });

    await importHistoryPage({ userId, pageSize: PAGE_SIZE });

    expect(starts).toEqual([-1, 10]);
    expect((await connection(userId)).lastError).toBeNull();
  });

  it("creates no duplicates on a second import and rewrites only a run edited on Garmin (duplicate or edited activities)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    await importPages(userId);
    // The stored half marathon no longer matches Garmin's, as after an edit there.
    await db
      .update(activity)
      .set({ distanceM: 21_000 })
      .where(eq(activity.garminActivityId, 9_000_000_029));
    const before = await runs(userId);

    await seedImport(userId);
    const pages = await importPages(userId);

    expect(pages.reduce((sum, page) => sum + page.written, 0)).toBe(1);
    const after = await runs(userId);
    expect(after).toHaveLength(FIXTURE_ACCOUNT.runs);
    expect((await run(userId, 9_000_000_029)).distanceM).toBe(21_097.5);
    const changed = after.filter(
      (row, index) => row.updatedAt.getTime() !== before[index]?.updatedAt.getTime(),
    );
    expect(changed.map((row) => row.garminActivityId)).toEqual([9_000_000_029]);
  });

  it("imports treadmill, manual, missing-HR and HR-0 runs with nulls and flags (indoor run, missing HR)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);

    await importPages(userId);

    expect(await run(userId, 9_000_000_025)).toMatchObject({
      type: "treadmill_running",
      isIndoor: true,
      isManual: false,
      avgHr: null,
      maxHr: null,
      cadence: 171,
    });
    expect(await run(userId, 9_000_000_038)).toMatchObject({ isIndoor: true, avgHr: 151 });
    expect(await run(userId, 9_000_000_023)).toMatchObject({ type: "virtual_run", isIndoor: true });
    expect(await run(userId, 9_000_000_027)).toMatchObject({
      isManual: true,
      distanceM: 5000,
      durationS: 1800,
      avgHr: null,
      maxHr: null,
    });
    expect(await run(userId, 9_000_000_035)).toMatchObject({ avgHr: null, maxHr: null });
    expect(await run(userId, 9_000_000_036)).toMatchObject({
      type: "trail_running",
      isIndoor: false,
    });
  });

  it("keeps the wall-clock start of a Sunday 23:30 run in New York and of a run on the DST change day (time zones and DST)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);

    await importPages(userId);

    expect(await run(userId, 9_000_000_013)).toMatchObject({
      startLocal: "2025-03-30 23:30:00",
      startUtc: new Date("2025-03-31T03:30:00Z"),
    });
    expect(await run(userId, 9_000_000_026)).toMatchObject({
      startLocal: "2026-03-29 09:00:00",
      startUtc: new Date("2026-03-29T07:00:00Z"),
    });
  });

  it("writes a rotated bundle back before the next page, which sends it (rotated token)", async () => {
    const userId = await connectedUser(garminBundle("rotate"));
    await seedImport(userId);
    const sent = fixturesSentTo("/history");

    await importPages(userId, 1);
    const afterFirst = await connection(userId);
    await importPages(userId, 1);

    expect(afterFirst.tokenBundleEnc.startsWith("v1:")).toBe(true);
    expect(fixtureOf(decrypt(afterFirst.tokenBundleEnc, userId))).toBe("rotated");
    expect(sent()).toEqual(["rotate", "rotated"]);
  });

  it("writes back the bundle Garmin rotated before a failed page and keeps the cursor (rotate then 502)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    await importPages(userId, 1);
    await setGarminBundle(userId, garminBundle("rotate_then_unavailable"));

    await expect(importHistoryPage({ userId, pageSize: PAGE_SIZE })).rejects.toMatchObject({
      code: ErrorCode.garminUnavailable,
    });

    const stored = await connection(userId);
    expect(fixtureOf(decrypt(stored.tokenBundleEnc, userId))).toBe("rotated");
    expect(stored.lastError).toBe(ErrorCode.garminUnavailable);
    expect(await storedImport(userId)).toMatchObject({ status: "running", nextOffset: 5 });
  });

  it("refuses without calling Garmin during the hour after a 429, and reads on from the cursor once it passed (Garmin 429)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    await importPages(userId, 2);
    await setGarminBundle(userId, garminBundle("rate_limited"));
    await expect(importHistoryPage({ userId, pageSize: PAGE_SIZE })).rejects.toMatchObject({
      code: ErrorCode.garminRateLimited,
      retryAfterSeconds: 3600,
    });
    await setGarminBundle(userId, garminBundle());
    await db
      .update(garminConnection)
      .set({ updatedAt: new Date(Date.now() - 1800 * 1000) })
      .where(eq(garminConnection.userId, userId));
    const sent = fixturesSentTo("/history");

    const refusal: unknown = await importHistoryPage({ userId, pageSize: PAGE_SIZE }).then(
      () => new Error("expected a refusal"),
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({ code: ErrorCode.garminRateLimited });
    const { retryAfterSeconds } = refusal as DomainError;
    expect(retryAfterSeconds).toBeGreaterThan(1790);
    expect(retryAfterSeconds).toBeLessThanOrEqual(1800);
    expect(sent()).toEqual([]);

    await db
      .update(garminConnection)
      .set({ updatedAt: new Date(Date.now() - 3601 * 1000) })
      .where(eq(garminConnection.userId, userId));
    const page = await importHistoryPage({ userId, pageSize: PAGE_SIZE });

    expect(page).toMatchObject({ status: "continued", start: 10, nextOffset: 15 });
    expect(sent()).toEqual([undefined]);
    expect((await connection(userId)).lastError).toBeNull();
  });

  it("throws garmin_not_connected and garmin_auth_expired without calling Garmin (token expiry)", async () => {
    const missing = await createUser("missing@example.com");
    await seedImport(missing);
    const expired = await createUser("expired@example.com");
    await connectGarmin(expired, garminBundle(), { status: "expired" });
    await seedImport(expired);
    const sent = fixturesSentTo("/history");

    await expect(importHistoryPage({ userId: missing, pageSize: PAGE_SIZE })).rejects.toMatchObject(
      { code: ErrorCode.garminNotConnected, status: 409 },
    );
    await expect(importHistoryPage({ userId: expired, pageSize: PAGE_SIZE })).rejects.toMatchObject(
      { code: ErrorCode.garminAuthExpired, status: 409 },
    );
    expect(sent()).toEqual([]);
  });

  it("skips without calling Garmin when no import is running or paused", async () => {
    const userId = await connectedUser();
    const sent = fixturesSentTo("/history");

    const none = await importHistoryPage({ userId, pageSize: PAGE_SIZE });
    await seedImport(userId, { status: "done", finishedAt: new Date() });
    const done = await importHistoryPage({ userId, pageSize: PAGE_SIZE });
    await seedImport(userId, { status: "failed", lastError: ErrorCode.garminAuthExpired });
    const failed = await importHistoryPage({ userId, pageSize: PAGE_SIZE });

    expect([none, done, failed]).toEqual([
      { status: "skipped" },
      { status: "skipped" },
      { status: "skipped" },
    ]);
    expect(sent()).toEqual([]);
  });

  it("refuses a page size that would not move the cursor past the overlap", async () => {
    const userId = await connectedUser();
    await seedImport(userId);

    await expect(
      importHistoryPage({ userId, pageSize: HISTORY_PAGE_OVERLAP }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("serializes with a sync of the same user on the user lock, and both finish (overlapping import and sync)", async () => {
    const userId = await connectedUser();
    await seedImport(userId);
    const events: string[] = [];
    const history = garminClient.history.bind(garminClient);
    const sync = garminClient.sync.bind(garminClient);
    vi.spyOn(garminClient, "history").mockImplementation(async (request, options) => {
      events.push("start history");
      await sleep(10);
      const response = await history(request, options);
      events.push("end history");
      return response;
    });
    vi.spyOn(garminClient, "sync").mockImplementation(async (request, options) => {
      events.push("start sync");
      await sleep(10);
      const response = await sync(request, options);
      events.push("end sync");
      return response;
    });

    const [pages, synced] = await Promise.all([
      importPages(userId),
      syncGarmin({ userId, now: new Date("2026-09-28T10:00:00Z") }),
    ]);

    // Every Garmin call ends before the next one starts.
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]?.startsWith("start")).toBe(true);
      expect(events[index + 1]).toBe(events[index]?.replace("start", "end"));
    }
    expect(events.filter((event) => event === "start sync")).toHaveLength(5);
    expect(pages.at(-1)?.status).toBe("done");
    expect(synced.activitiesSeen).toBe(7);
    expect(await runs(userId)).toHaveLength(FIXTURE_ACCOUNT.runs);
    expect((await connection(userId)).lastSyncAt).not.toBeNull();
  });
});

describe("getImportProgress", () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const HOURS = 3600 * 1000;

  // pg-boss without the import worker: a page stays in the state the test puts it in. Each test starts
  // from an empty queue, so a fetch takes that test's page.
  beforeAll(async () => {
    const boss = await startBoss();
    await boss.createQueue(importJob.name, importJob.queue);
  });

  afterAll(async () => {
    await stopJobs();
  });

  beforeEach(async () => {
    await getBoss().deleteAllJobs(importJob.name);
  });

  /** Queues a page of the user's import as the chain does; `options` overrides the queue's. */
  async function queuePage(userId: string, options: SendOptions = {}): Promise<string> {
    const id = await getBoss().send(
      importJob.name,
      { userId },
      { ...importJob.sendOptions({ userId }), ...options },
    );
    if (!id) throw new Error("page not queued");
    return id;
  }

  async function jobState(id: string) {
    const [job] = await getBoss().findJobs<object>(importJob.name, { id });
    return job;
  }

  it("is not_started with the runs already stored when no import ran", async () => {
    const userId = await connectedUser();
    await syncGarmin({ userId, now: new Date("2026-09-28T10:00:00Z") });

    expect(await getImportProgress(userId)).toEqual({
      status: "not_started",
      runsStored: 7,
      oldestDate: null,
      startedAt: null,
      finishedAt: null,
      resumeAt: null,
      errorCode: null,
    });
  });

  it("is stalled when a running or paused import has no page job pg-boss can still run (stalled)", async () => {
    const userId = await connectedUser();

    // No job at all, as after a send lost with the process.
    await seedImport(userId);
    const neverQueued = await getImportProgress(userId);
    // Its page completed without moving the row, or ran out of attempts without the handler (expired).
    const completed = await queuePage(userId);
    await getBoss().complete(importJob.name, completed, null, { includeQueued: true });
    const afterCompleted = await getImportProgress(userId);
    const exhausted = await queuePage(userId, { retryLimit: 0 });
    await getBoss().fail(importJob.name, exhausted);
    const afterFailed = await getImportProgress(userId);
    await seedImport(userId, {
      status: "paused",
      resumeAt: ago(HOURS),
      lastError: ErrorCode.garminRateLimited,
    });
    const pausedWithoutPage = await getImportProgress(userId);

    expect((await jobState(completed))?.state).toBe("completed");
    expect((await jobState(exhausted))?.state).toBe("failed");
    expect(
      [neverQueued, afterCompleted, afterFailed, pausedWithoutPage].map(
        (progress) => progress.status,
      ),
    ).toEqual(["stalled", "stalled", "stalled", "stalled"]);
  });

  it("is running, not stalled, while its page waits, runs or waits for a retry, however long since the row moved (stalled)", async () => {
    const userId = await connectedUser();
    await seedImport(userId, { updatedAt: ago(3 * HOURS) });

    const id = await queuePage(userId);
    const waiting = await getImportProgress(userId);
    const [fetched] = await getBoss().fetch(importJob.name);
    const active = await getImportProgress(userId);
    // Garmin failed the attempt: pg-boss retries it 5 to 10 minutes later and the row stays as it was.
    await getBoss().fail(importJob.name, id);
    const retrying = await getImportProgress(userId);

    expect(fetched?.id).toBe(id);
    const retry = await jobState(id);
    expect(retry?.state).toBe("retry");
    expect(retry?.startAfter.getTime()).toBeGreaterThan(Date.now() + 250 * 1000);
    expect([waiting, active, retrying].map((progress) => progress.status)).toEqual([
      "running",
      "running",
      "running",
    ]);
  });

  it("is paused, not stalled, while its deferred page waits, also long after resume_at (paused)", async () => {
    const userId = await connectedUser();
    const resumeAt = ago(2 * HOURS);
    await seedImport(userId, {
      status: "paused",
      resumeAt,
      lastError: ErrorCode.garminRateLimited,
      updatedAt: ago(3 * HOURS),
    });
    // Deferred to resume_at, and not picked up since (a worker that was down).
    await queuePage(userId, { startAfter: resumeAt });

    expect(await getImportProgress(userId)).toMatchObject({
      status: "paused",
      resumeAt: resumeAt.toISOString(),
      errorCode: ErrorCode.garminRateLimited,
    });
  });

  it("never reports a done or failed import as stalled however old, and asks pg-boss only about a running or paused one", async () => {
    const userId = await connectedUser();
    const old = ago(24 * HOURS);
    const findJobs = vi.spyOn(getBoss(), "findJobs");

    const none = await getImportProgress(userId);
    await seedImport(userId, { status: "done", finishedAt: old, updatedAt: old });
    const done = await getImportProgress(userId);
    await seedImport(userId, { status: "failed", lastError: ErrorCode.internal, updatedAt: old });
    const failed = await getImportProgress(userId);

    expect(none.status).toBe("not_started");
    expect(done.status).toBe("done");
    expect(failed).toMatchObject({ status: "failed", errorCode: ErrorCode.internal });
    expect(findJobs).not.toHaveBeenCalled();
  });
});
