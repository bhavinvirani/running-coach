import { setTimeout as sleep } from "node:timers/promises";
import { ErrorCode, RACE_EVENT_TYPE, syncResponseSchema } from "@running-coach/shared";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import { decrypt } from "../../src/lib/crypto";
import { addDays, type DateRange, dateChunks } from "../../src/lib/local-date";
import { connectGarminLimiter } from "../../src/routes/garmin";
import { syncLimiter } from "../../src/routes/sync";
import { SYNC_CHUNK_DAYS } from "../../src/services/garmin-sync";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { connectGarmin, fixtureOf, fixturesSentTo, garminBundle } from "../seed";

// Sync now on the real Postgres against the Garmin service in fixture mode. The route syncs up to today,
// so each connection starts with a cursor of 2026-09-01: the sync then re-reads from 2026-08-31 and finds
// all seven fixture runs (2026-08-31 to 2026-09-27) whatever today's date.

const app = createTestApp();
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

  it("serializes two Sync now requests of one user: the second reads the cursor the first committed (overlapping syncs)", async () => {
    const { agent } = await connectedOwner();
    const windows: DateRange[] = [];
    const sync = garminClient.sync.bind(garminClient);
    vi.spyOn(garminClient, "sync").mockImplementation(async (body, options) => {
      windows.push({ start: body.startDate, end: body.endDate });
      // Keeps the first sync running while the second request arrives, so only the lock orders them.
      await sleep(20);
      return sync(body, options);
    });

    const [first, second] = await Promise.all([agent.post(PATH), agent.post(PATH)]);

    // The first sync asks for 2026-08-31 to today in chunks; the second, after it, asks only for the day
    // before the first one's last day onwards. Unserialized, both would read 2026-09-01 and ask twice.
    const firstSync = windows.slice(0, -1);
    const lastDay = firstSync.at(-1)?.end ?? "no first sync";
    expect(firstSync).toEqual(dateChunks("2026-08-31", lastDay, SYNC_CHUNK_DAYS));
    expect(windows.at(-1)?.start).toBe(addDays(lastDay, -1));
    const written = [first, second].map(
      (response) => syncResponseSchema.parse(response.body).activitiesWritten,
    );
    expect(written.sort()).toEqual([0, FIXTURE_RUNS]);
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
