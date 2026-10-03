import { setTimeout as sleep } from "node:timers/promises";
import { BEST_EFFORTS_VERSION } from "@running-coach/engine";
import {
  ErrorCode,
  type GarminRecentRuns,
  type GarminSyncRequest,
  latestActivityResponseSchema,
  personalBestsResponseSchema,
  RACE_EVENT_TYPE,
  RECENT_RUNS_CHECKED,
  syncResponseSchema,
} from "@running-coach/shared";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import {
  activity,
  activityLap,
  activityStream,
  bestEffort,
  coachMessage,
  garminConnection,
} from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import * as bestEffortsQueue from "../../src/jobs/best-efforts-queue";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { decrypt } from "../../src/lib/crypto";
import { type DateRange, dateChunks } from "../../src/lib/local-date";
import { connectGarminLimiter } from "../../src/routes/garmin";
import { syncLimiter } from "../../src/routes/sync";
import { MAX_RUNS_REMOVED_PER_SYNC, SYNC_CHUNK_DAYS } from "../../src/services/garmin-sync";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import {
  bodiesSentTo,
  connectGarmin,
  createPlan,
  createRunOn,
  createSession,
  fixtureOf,
  fixturesSentTo,
  createUser,
  garminBundle,
  setGarminBundle,
  storedSession,
} from "../seed";

// Sync now on the real Postgres against the Garmin service in fixture mode. The route syncs up to today,
// so each connection starts with a cursor of 2026-09-01: the sync then re-reads from 2026-08-31 and finds
// all seven fixture runs (2026-08-31 to 2026-09-27) whatever today's date. pg-boss runs without workers, so
// the workout push a reconnect queues stays queued.

const app = createTestApp();

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});
const PATH = "/api/sync";
const CURSOR = new Date("2026-09-01T12:00:00Z");
const FIXTURE_RUNS = 7;
/** The fixture's 10.2 km of 2026-09-06, which Garmin lists with event type race. */
const RACE_RUN = 10_000_000_002;
const EASY_RUN = 10_000_000_005;

afterEach(() => {
  vi.restoreAllMocks();
  syncLimiter.reset();
  connectGarminLimiter.reset();
});

async function connectedOwner(bundle = garminBundle(), status: "ok" | "expired" = "ok") {
  const agent = await signedInAgent(app);
  const userId = await ownerId();
  await connectGarmin(userId, bundle, { lastSyncAt: CURSOR, status });
  return { agent, userId };
}

async function storedConnection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection stored");
  return row;
}

async function runs() {
  return db.select().from(activity);
}

/** Moves the connection's last change, which marks a 429, this many seconds into the past. */
async function rateLimitedSecondsAgo(userId: string, seconds: number) {
  await db
    .update(garminConnection)
    .set({ updatedAt: new Date(Date.now() - seconds * 1000) })
    .where(eq(garminConnection.userId, userId));
}

describe("POST /api/sync", () => {
  it("stores the runs and returns lastSyncAt and the number written", async () => {
    const { agent, userId } = await connectedOwner();
    const before = Date.now();

    const response = await agent.post(PATH);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = syncResponseSchema.parse(response.body);
    expect(body.activitiesWritten).toBe(FIXTURE_RUNS);
    expect(Date.parse(body.lastSyncAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.lastSyncAt)).toBeLessThanOrEqual(Date.now());
    expect(body.lastSyncAt).toBe((await storedConnection(userId)).lastSyncAt?.toISOString());
    expect(await runs()).toHaveLength(FIXTURE_RUNS);
  });

  it("writes 0 on a second Sync now and keeps each run once (duplicate activities)", async () => {
    const { agent } = await connectedOwner();
    await agent.post(PATH);

    const response = await agent.post(PATH);

    expect(response.status).toBe(200);
    expect(syncResponseSchema.parse(response.body).activitiesWritten).toBe(0);
    expect(await runs()).toHaveLength(FIXTURE_RUNS);
  });

  it("stores Garmin's event type: the fixture race as race and the other runs uncategorized (race badge)", async () => {
    const { agent } = await connectedOwner();

    await agent.post(PATH);

    const stored = await runs();
    expect(stored.find((run) => run.garminActivityId === RACE_RUN)?.eventType).toBe(
      RACE_EVENT_TYPE,
    );
    expect(stored.find((run) => run.garminActivityId === EASY_RUN)?.eventType).toBe(
      "uncategorized",
    );
    expect(stored.filter((run) => run.eventType === RACE_EVENT_TYPE)).toHaveLength(1);
  });

  it("rewrites only the runs whose event type changed on Garmin, and nothing when re-read unchanged (edited activity)", async () => {
    const { agent, userId } = await connectedOwner();
    await agent.post(PATH);
    const rereadAll = () =>
      db
        .update(garminConnection)
        .set({ lastSyncAt: CURSOR })
        .where(eq(garminConnection.userId, userId));

    await rereadAll();
    const unchanged = await agent.post(PATH);
    // As if the race was synced before the runner marked it a race, and the easy run before 0007.
    await db
      .update(activity)
      .set({ eventType: "uncategorized" })
      .where(eq(activity.garminActivityId, RACE_RUN));
    await db
      .update(activity)
      .set({ eventType: null })
      .where(eq(activity.garminActivityId, EASY_RUN));
    await rereadAll();
    const changed = await agent.post(PATH);

    expect(syncResponseSchema.parse(unchanged.body).activitiesWritten).toBe(0);
    expect(syncResponseSchema.parse(changed.body).activitiesWritten).toBe(2);
    const rewritten = await db
      .select({ garminActivityId: activity.garminActivityId, eventType: activity.eventType })
      .from(activity)
      .where(inArray(activity.garminActivityId, [RACE_RUN, EASY_RUN]));
    expect(rewritten).toEqual(
      expect.arrayContaining([
        { garminActivityId: RACE_RUN, eventType: RACE_EVENT_TYPE },
        { garminActivityId: EASY_RUN, eventType: "uncategorized" },
      ]),
    );
    expect(await runs()).toHaveLength(FIXTURE_RUNS);
  });

  it("joins a Sync now that is running: both answer 200 with the same lastSyncAt, and Garmin is asked for each chunk once (overlapping syncs)", async () => {
    const { agent } = await connectedOwner();
    const windows: DateRange[] = [];
    const sync = garminClient.sync.bind(garminClient);
    vi.spyOn(garminClient, "sync").mockImplementation(async (body, options) => {
      windows.push({ start: body.startDate, end: body.endDate });
      // Keeps the first sync running while the second request arrives.
      await sleep(100);
      return sync(body, options);
    });

    const [first, second] = await Promise.all([agent.post(PATH), agent.post(PATH)]);

    expect([first.status, second.status]).toEqual([200, 200]);
    const body = syncResponseSchema.parse(first.body);
    expect(second.body).toEqual(body);
    expect(body.activitiesWritten).toBe(FIXTURE_RUNS);
    // One sync from 2026-08-31 to today; a second, after it, would have asked again for its last days.
    const lastDay = windows.at(-1)?.end ?? "no sync";
    expect(windows).toEqual(dateChunks("2026-08-31", lastDay, SYNC_CHUNK_DAYS));
    expect(await runs()).toHaveLength(FIXTURE_RUNS);
  });

  it("returns 409 garmin_not_connected without a Garmin connection", async () => {
    const agent = await signedInAgent(app);
    const sent = fixturesSentTo("/sync");

    const response = await agent.post(PATH);

    expectProblem(response, 409, ErrorCode.garminNotConnected);
    expect(sent()).toEqual([]);
  });

  it("returns 409 garmin_auth_expired and stores no runs when Garmin rejects the bundle (token expiry)", async () => {
    const { agent, userId } = await connectedOwner(garminBundle("expired"));

    const response = await agent.post(PATH);

    expectProblem(response, 409, ErrorCode.garminAuthExpired);
    expect(await runs()).toEqual([]);
    expect(await storedConnection(userId)).toMatchObject({
      lastSyncAt: CURSOR,
      lastError: ErrorCode.garminAuthExpired,
    });
  });

  it("returns 409 garmin_auth_expired without calling Garmin once the login is marked expired", async () => {
    const { agent } = await connectedOwner(garminBundle(), "expired");
    const sent = fixturesSentTo("/sync");

    const response = await agent.post(PATH);

    expectProblem(response, 409, ErrorCode.garminAuthExpired);
    expect(sent()).toEqual([]);
  });

  it("writes the bundle Garmin rotated back, encrypted (rotated token)", async () => {
    const { agent, userId } = await connectedOwner(garminBundle("rotate"));

    const response = await agent.post(PATH);

    expect(response.status).toBe(200);
    const stored = await storedConnection(userId);
    expect(stored.tokenBundleEnc.startsWith("v1:")).toBe(true);
    expect(fixtureOf(decrypt(stored.tokenBundleEnc, userId))).toBe("rotated");
  });

  it("returns 429 with Retry-After 3600 and stores no runs when Garmin rate limits, without retrying (Garmin 429)", async () => {
    const { agent, userId } = await connectedOwner(garminBundle("rate_limited"));
    const sent = fixturesSentTo("/sync");

    const response = await agent.post(PATH);

    const problem = expectProblem(response, 429, ErrorCode.garminRateLimited);
    expect(problem.retryAfterSeconds).toBe(3600);
    expect(response.headers["retry-after"]).toBe("3600");
    expect(sent()).toEqual(["rate_limited"]);
    expect(await runs()).toEqual([]);
    expect(await storedConnection(userId)).toMatchObject({
      status: "ok",
      lastSyncAt: CURSOR,
      lastError: ErrorCode.garminRateLimited,
    });
  });

  it("refuses Sync now for the hour after a Garmin 429 without calling Garmin or restarting the hour (Garmin 429)", async () => {
    const { agent, userId } = await connectedOwner(garminBundle("rate_limited"));
    expectProblem(await agent.post(PATH), 429, ErrorCode.garminRateLimited);
    const limited = await storedConnection(userId);
    const sent = fixturesSentTo("/sync");

    const response = await agent.post(PATH);

    const problem = expectProblem(response, 429, ErrorCode.garminRateLimited);
    expect(problem.retryAfterSeconds).toBeGreaterThan(3500);
    expect(problem.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(response.headers["retry-after"]).toBe(String(problem.retryAfterSeconds));
    expect(sent()).toEqual([]);
    expect(await storedConnection(userId)).toEqual(limited);
  });

  it("answers the seconds left of the hour after a 429, and calls Garmin again once the hour has passed (Garmin 429)", async () => {
    const { agent, userId } = await connectedOwner(garminBundle("rate_limited"));
    expectProblem(await agent.post(PATH), 429, ErrorCode.garminRateLimited);
    const sent = fixturesSentTo("/sync");

    await rateLimitedSecondsAgo(userId, 3590);
    const during = await agent.post(PATH);
    await rateLimitedSecondsAgo(userId, 3601);
    const after = await agent.post(PATH);

    const refused = expectProblem(during, 429, ErrorCode.garminRateLimited);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(10);
    // Garmin still limits: the fresh 429 starts a new hour.
    expect(expectProblem(after, 429, ErrorCode.garminRateLimited).retryAfterSeconds).toBe(3600);
    expect(sent()).toEqual(["rate_limited"]);
    const restarted = await storedConnection(userId);
    expect(Date.now() - restarted.updatedAt.getTime()).toBeLessThan(60_000);
  });

  it("calls Garmin at once after a reconnect during the hour after a 429 (Garmin 429)", async () => {
    const { agent } = await connectedOwner(garminBundle("rate_limited"));
    expectProblem(await agent.post(PATH), 429, ErrorCode.garminRateLimited);
    expect(
      (await agent.put("/api/garmin/connection").send({ tokenBundle: garminBundle() })).status,
    ).toBe(200);
    const sent = fixturesSentTo("/sync");

    const response = await agent.post(PATH);

    expect(response.status).toBe(200);
    expect(syncResponseSchema.parse(response.body).activitiesWritten).toBe(FIXTURE_RUNS);
    expect(sent().length).toBeGreaterThan(0);
  });

  it("keeps the bundle Garmin rotated before a 429 (rotate then 429)", async () => {
    const { agent, userId } = await connectedOwner(garminBundle("rotate_then_rate_limited"));

    const response = await agent.post(PATH);

    expectProblem(response, 429, ErrorCode.garminRateLimited);
    const stored = await storedConnection(userId);
    expect(fixtureOf(decrypt(stored.tokenBundleEnc, userId))).toBe("rotated");
  });

  it("returns 502 garmin_unavailable and keeps the cursor when Garmin is down (Garmin outage)", async () => {
    const { agent, userId } = await connectedOwner(garminBundle("unavailable"));

    const response = await agent.post(PATH);

    expectProblem(response, 502, ErrorCode.garminUnavailable);
    expect(await runs()).toEqual([]);
    expect(await storedConnection(userId)).toMatchObject({
      lastSyncAt: CURSOR,
      lastError: ErrorCode.garminUnavailable,
    });
  });

  it("returns 401 without a session and calls no Garmin", async () => {
    const sent = fixturesSentTo("/sync");

    const response = await request(app).post(PATH);

    expectProblem(response, 401, ErrorCode.unauthorized);
    expect(sent()).toEqual([]);
  });

  it("returns 429 rate_limited on the 7th call in a minute without calling Garmin", async () => {
    const { agent } = await connectedOwner();
    for (let call = 0; call < 6; call += 1) {
      expect((await agent.post(PATH)).status).toBe(200);
    }
    const sent = fixturesSentTo("/sync");

    const response = await agent.post(PATH);

    const problem = expectProblem(response, 429, ErrorCode.rateLimited);
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
    expect(problem.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(response.headers["retry-after"]).toBe(String(problem.retryAfterSeconds));
    expect(sent()).toEqual([]);
  });
});

describe("POST /api/sync, runs deleted on Garmin", () => {
  /** The fixture's newest run, which the "deleted_run" bundle leaves out of the account. */
  const DELETED_RUN = 10_000_000_007;
  /** The fixture's 14 km of 2026-09-20, outdoors: the next fastest 5 km below. */
  const NEXT_FASTEST = 10_000_000_005;
  /** The fixture's treadmill run of 2026-09-24: the latest run once the 18 km of the 27th is gone. */
  const TREADMILL = 10_000_000_006;
  /** A walk in the fixture account (history.json) that Garmin's running list leaves out. */
  const WALK = 9_000_000_040;

  // GET /api/personal-bests reads the best-efforts queue; no worker runs, so a batch a sync queues waits.
  beforeAll(async () => {
    await getBoss().createQueue(bestEffortsQueue.name, bestEffortsQueue.queue);
  });

  /** Syncs the owner's fixture runs, then lets Sync now run again from the same cursor. */
  async function syncedOwner() {
    const owner = await connectedOwner();
    expect((await owner.agent.post(PATH)).status).toBe(200);
    await db
      .update(garminConnection)
      .set({ lastSyncAt: CURSOR })
      .where(eq(garminConnection.userId, owner.userId));
    syncLimiter.reset();
    return owner;
  }

  async function storedRun(garminActivityId: number) {
    const [row] = await db
      .select()
      .from(activity)
      .where(eq(activity.garminActivityId, garminActivityId));
    if (!row) throw new Error(`no run ${garminActivityId}`);
    return row;
  }

  async function storedGarminIds(): Promise<number[]> {
    return (await runs()).map((run) => run.garminActivityId).sort();
  }

  /** Replaces the newest runs the service answers on a sync's last chunk; earlier chunks pass through. */
  function answerRecent(replace: (answered: GarminRecentRuns | null) => GarminRecentRuns | null) {
    const sync = garminClient.sync.bind(garminClient);
    vi.spyOn(garminClient, "sync").mockImplementation(async (body, options) => {
      const response = await sync(body, options);
      return body.recentLimit > 0 ? { ...response, recent: replace(response.recent) } : response;
    });
  }

  /** Runs on Garmin's side unknown to its list: stored under ids the fixture account does not hold. */
  async function unlistedRuns(userId: string, dates: string[]) {
    return Promise.all(dates.map((date) => createRunOn(userId, date)));
  }

  it("asks for the newest runs on the last chunk only, so a sync costs one more call and no login", async () => {
    const { agent } = await connectedOwner();
    const sent = bodiesSentTo<GarminSyncRequest>("/sync");

    const response = await agent.post(PATH);

    expect(response.status).toBe(200);
    const limits = sent().map((body) => body.recentLimit);
    expect(limits.length).toBeGreaterThan(1);
    expect(limits.at(-1)).toBe(RECENT_RUNS_CHECKED);
    expect(limits.slice(0, -1).every((limit) => limit === 0)).toBe(true);
  });

  it("removes nothing and answers 0 when every stored run is still on Garmin", async () => {
    const { agent } = await syncedOwner();

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body)).toMatchObject({
      activitiesWritten: 0,
      activitiesRemoved: 0,
    });
    expect(await runs()).toHaveLength(FIXTURE_RUNS);
  });

  it("removes a run deleted on Garmin within the newest 100 with its laps, streams, best efforts and coach messages, and Progress's best falls back to the next fastest run (deleted activity)", async () => {
    const { agent, userId } = await syncedOwner();
    const deleted = await storedRun(DELETED_RUN);
    const nextFastest = await storedRun(NEXT_FASTEST);
    await db
      .update(activity)
      .set({ bestEffortsVersion: BEST_EFFORTS_VERSION })
      .where(inArray(activity.id, [deleted.id, nextFastest.id]));
    await db.insert(bestEffort).values([
      { userId, activityId: deleted.id, distanceKey: "5k", timeS: 1490, startS: 600 },
      { userId, activityId: nextFastest.id, distanceKey: "5k", timeS: 1580, startS: 300 },
    ]);
    await db
      .insert(activityLap)
      .values({ activityId: deleted.id, idx: 1, distanceM: 1000, durationS: 300 });
    await db
      .insert(activityStream)
      .values({ activityId: deleted.id, elapsedS: [0, 1], distanceM: [0, 3] });
    await db.insert(coachMessage).values({
      userId,
      kind: "insight",
      activityId: deleted.id,
      promptVersion: "run-insight/v1",
      content: {},
    });
    const plan = await createPlan(userId);
    const session = await createSession(userId, plan.id, {
      date: "2026-09-27",
      status: "done",
      activityId: deleted.id,
    });
    const bestsBefore = personalBestsResponseSchema.parse(
      (await agent.get("/api/personal-bests")).body,
    );
    expect(bestsBefore.bests).toEqual([
      expect.objectContaining({ distanceKey: "5k", timeS: 1490, activityId: deleted.id }),
    ]);
    await setGarminBundle(userId, garminBundle("deleted_run"));

    const response = await agent.post(PATH);

    expect(response.status).toBe(200);
    expect(syncResponseSchema.parse(response.body)).toMatchObject({
      activitiesWritten: 0,
      activitiesRemoved: 1,
    });
    expect(await storedGarminIds()).not.toContain(DELETED_RUN);
    expect(await runs()).toHaveLength(FIXTURE_RUNS - 1);
    for (const table of [bestEffort, activityLap, activityStream, coachMessage]) {
      expect(await db.select().from(table).where(eq(table.activityId, deleted.id))).toEqual([]);
    }
    expect(await storedSession(session.id)).toMatchObject({ status: "done", activityId: null });
    const bests = personalBestsResponseSchema.parse((await agent.get("/api/personal-bests")).body);
    expect(bests.bests).toEqual([
      expect.objectContaining({ distanceKey: "5k", timeS: 1580, activityId: nextFastest.id }),
    ]);
    const latest = latestActivityResponseSchema.parse(
      (await agent.get("/api/activities/latest")).body,
    );
    expect(latest.activity?.id).toBe((await storedRun(TREADMILL)).id);
  });

  it("removes a run whose type changed away from running on Garmin (edited activity)", async () => {
    const { agent, userId } = await syncedOwner();
    // Stored while it was a run; Garmin's running list no longer holds it as one.
    await createRunOn(userId, "2026-08-15", { garminActivityId: WALK });

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body).activitiesRemoved).toBe(1);
    expect(await storedGarminIds()).not.toContain(WALK);
    expect(await runs()).toHaveLength(FIXTURE_RUNS);
  });

  /** As if the account held more runs than the 100 listed, the oldest of them starting at the times given. */
  function oldestListedAt(startUtc: string, startLocal: string) {
    answerRecent((answered) => ({
      garminActivityIds: answered?.garminActivityIds ?? [],
      oldestStartUtc: startUtc,
      oldestStartLocal: startLocal,
      listed: RECENT_RUNS_CHECKED,
    }));
  }

  it("keeps a run older than the oldest of the newest 100, and removes one after it", async () => {
    const { agent, userId } = await syncedOwner();
    const [older, newer] = await unlistedRuns(userId, ["2026-08-20", "2026-09-10"]);
    // The fixture's first run: 00:40 local, 22:40 UTC the day before.
    oldestListedAt("2026-08-30T22:40:00Z", "2026-08-31T00:40:00");

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body).activitiesRemoved).toBe(1);
    const stored = await storedGarminIds();
    expect(stored).toContain(older?.garminActivityId);
    expect(stored).not.toContain(newer?.garminActivityId);
  });

  // A run in Tokyo (UTC+9) at 20:00, a flight over the date line, a run in Honolulu (UTC-10) at 12:00 the
  // same date: the Honolulu run is later in UTC and earlier on the clock. Garmin lists by local start, which
  // UTC order can contradict, so a run beyond the oldest listed one on either clock may sit past the list.
  const TOKYO = { startUtc: "2026-09-19T11:00:00Z", startLocal: "2026-09-19T20:00:00" };
  const HONOLULU = { startUtc: "2026-09-19T22:00:00Z", startLocal: "2026-09-19T12:00:00" };

  async function unlistedRunAt(userId: string, start: { startUtc: string; startLocal: string }) {
    return createRunOn(userId, start.startLocal.slice(0, 10), {
      startUtc: new Date(start.startUtc),
      startLocal: start.startLocal.replace("T", " "),
    });
  }

  it("keeps an unlisted run whose local start is older than the oldest listed run's though its UTC start is newer, and removes a plainly newer one (time zones and DST)", async () => {
    const { agent, userId } = await syncedOwner();
    oldestListedAt(TOKYO.startUtc, TOKYO.startLocal);
    const honolulu = await unlistedRunAt(userId, HONOLULU);
    const [newer] = await unlistedRuns(userId, ["2026-09-21"]);

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body).activitiesRemoved).toBe(1);
    const stored = await storedGarminIds();
    expect(stored).toContain(honolulu.garminActivityId);
    expect(stored).not.toContain(newer?.garminActivityId);
  });

  it("keeps an unlisted run whose UTC start is older than the oldest listed run's though its local start is newer, and removes a plainly newer one (time zones and DST)", async () => {
    const { agent, userId } = await syncedOwner();
    oldestListedAt(HONOLULU.startUtc, HONOLULU.startLocal);
    const tokyo = await unlistedRunAt(userId, TOKYO);
    const [newer] = await unlistedRuns(userId, ["2026-09-21"]);

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body).activitiesRemoved).toBe(1);
    const stored = await storedGarminIds();
    expect(stored).toContain(tokyo.garminActivityId);
    expect(stored).not.toContain(newer?.garminActivityId);
  });

  it("removes nothing when Garmin's newest runs could not be read (recent null)", async () => {
    const { agent, userId } = await syncedOwner();
    await unlistedRuns(userId, ["2026-09-10"]);
    answerRecent(() => null);

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body).activitiesRemoved).toBe(0);
    expect(await runs()).toHaveLength(FIXTURE_RUNS + 1);
  });

  it("removes nothing when Garmin's newest runs hold no run while runs are stored (Garmin glitch)", async () => {
    const { agent } = await syncedOwner();
    answerRecent(() => ({
      garminActivityIds: [],
      oldestStartUtc: null,
      oldestStartLocal: null,
      listed: 0,
    }));

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body).activitiesRemoved).toBe(0);
    expect(await runs()).toHaveLength(FIXTURE_RUNS);
  });

  it(`removes nothing when more than ${MAX_RUNS_REMOVED_PER_SYNC} runs would go at once (Garmin glitch)`, async () => {
    const { agent, userId } = await syncedOwner();
    const days = Array.from(
      { length: MAX_RUNS_REMOVED_PER_SYNC + 1 },
      (_, index) => `2026-08-${String(index + 1).padStart(2, "0")}`,
    );
    await unlistedRuns(userId, days);

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body).activitiesRemoved).toBe(0);
    expect(await runs()).toHaveLength(FIXTURE_RUNS + MAX_RUNS_REMOVED_PER_SYNC + 1);
  });

  it(`removes ${MAX_RUNS_REMOVED_PER_SYNC} runs deleted on Garmin in one sync`, async () => {
    const { agent, userId } = await syncedOwner();
    const days = Array.from(
      { length: MAX_RUNS_REMOVED_PER_SYNC },
      (_, index) => `2026-08-${String(index + 1).padStart(2, "0")}`,
    );
    await unlistedRuns(userId, days);

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body).activitiesRemoved).toBe(
      MAX_RUNS_REMOVED_PER_SYNC,
    );
    expect(await runs()).toHaveLength(FIXTURE_RUNS);
  });

  it("removes only the signed-in runner's runs", async () => {
    const { agent } = await syncedOwner();
    const other = await createUser("other@example.com");
    await createRunOn(other, "2026-09-10");

    const response = await agent.post(PATH);

    expect(syncResponseSchema.parse(response.body).activitiesRemoved).toBe(0);
    expect(await db.select().from(activity).where(eq(activity.userId, other))).toHaveLength(1);
  });
});
