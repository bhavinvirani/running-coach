import { setTimeout as sleep } from "node:timers/promises";
import { connectGarminResponseSchema, ErrorCode } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { decrypt } from "../../src/lib/crypto";
import { connectGarminLimiter } from "../../src/routes/garmin";
import { syncLimiter } from "../../src/routes/sync";
import { syncGarmin } from "../../src/services/garmin-sync";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { connectGarmin, createLongRun, fixtureOf, fixturesSentTo, garminBundle } from "../seed";

// Against the Garmin service in fixture mode: the bundle picks its answer (see test/seed.ts). pg-boss runs
// without workers, so the workout push a connect queues stays queued.

const app = createTestApp();
const PATH = "/api/garmin/connection";

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

async function pushJobs(userId: string) {
  return getBoss().findJobs(pushQueue.name, { key: userId });
}

afterEach(() => {
  vi.restoreAllMocks();
  connectGarminLimiter.reset();
  syncLimiter.reset();
});

async function connections() {
  return db.select().from(garminConnection);
}

async function storedConnection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection stored");
  return row;
}

describe("PUT /api/garmin/connection", () => {
  it("stores the bundle encrypted and returns the display name", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();

    const response = await agent.put(PATH).send({ tokenBundle: garminBundle() });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(connectGarminResponseSchema.parse(response.body)).toEqual({
      displayName: "Alex Fixture",
    });
    const row = await storedConnection(userId);
    expect(row).toMatchObject({ status: "ok", lastError: null, lastSyncAt: null });
    expect(row.tokenBundleEnc.startsWith("v1:")).toBe(true);
    expect(decrypt(row.tokenBundleEnc, userId)).toBe(garminBundle());
  });

  it("queues one workout push once the login works, and none when the check fails (reconnect)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();

    expectProblem(
      await agent.put(PATH).send({ tokenBundle: garminBundle("expired") }),
      409,
      ErrorCode.garminAuthExpired,
    );
    expect(await pushJobs(userId)).toEqual([]);
    await agent.put(PATH).send({ tokenBundle: garminBundle() });
    await agent.put(PATH).send({ tokenBundle: garminBundle() });

    // The second connect's push folds into the one waiting.
    expect((await pushJobs(userId)).map((job) => [job.state, job.data])).toEqual([
      ["created", { userId }],
    ]);
  });

  it("never sends the bundle back, plain or encrypted", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.put(PATH).send({ tokenBundle: garminBundle() });
    const me = await agent.get("/api/me");

    for (const text of [response.text, me.text]) {
      for (const secret of ["fixture-token", "fixture-refresh", "tokenBundle", "v1:"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("keeps last_sync_at and the runs on reconnect, and clears an expired status and last_error", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const lastSyncAt = new Date("2026-09-27T09:00:00Z");
    await connectGarmin(userId, garminBundle("expired"), {
      status: "expired",
      lastError: ErrorCode.garminAuthExpired,
      lastSyncAt,
    });
    await createLongRun(userId);

    const response = await agent.put(PATH).send({ tokenBundle: garminBundle() });

    expect(response.status).toBe(200);
    expect(await connections()).toHaveLength(1);
    const row = await storedConnection(userId);
    expect(row).toMatchObject({ status: "ok", lastError: null, lastSyncAt });
    expect(decrypt(row.tokenBundleEnc, userId)).toBe(garminBundle());
    expect(await db.select().from(activity)).toHaveLength(1);
  });

  it("stores nothing and returns 409 when the bundle is expired (token expiry)", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.put(PATH).send({ tokenBundle: garminBundle("expired") });

    expectProblem(response, 409, ErrorCode.garminAuthExpired);
    expect(await connections()).toEqual([]);
  });

  it("leaves an existing connection unchanged when the new bundle fails the check", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle(), {
      lastSyncAt: new Date("2026-09-27T09:00:00Z"),
    });
    const before = await storedConnection(userId);

    const expired = await agent.put(PATH).send({ tokenBundle: garminBundle("expired") });
    const limited = await agent.put(PATH).send({ tokenBundle: garminBundle("rate_limited") });
    const down = await agent.put(PATH).send({ tokenBundle: garminBundle("unavailable") });

    expectProblem(expired, 409, ErrorCode.garminAuthExpired);
    expectProblem(limited, 429, ErrorCode.garminRateLimited);
    expectProblem(down, 502, ErrorCode.garminUnavailable);
    expect(await storedConnection(userId)).toEqual(before);
  });

  it("stores the bundle Garmin rotated during the check (rotated token)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();

    const response = await agent.put(PATH).send({ tokenBundle: garminBundle("rotate") });

    expect(response.status).toBe(200);
    const row = await storedConnection(userId);
    expect(fixtureOf(decrypt(row.tokenBundleEnc, userId))).toBe("rotated");
  });

  it("returns 400 and calls no Garmin for a bundle that is not a JSON object", async () => {
    const agent = await signedInAgent(app);
    const profile = vi.spyOn(garminClient, "profile");

    for (const tokenBundle of ["not json at all", "[1, 2]", '"a string"', "null", "42"]) {
      const response = await agent.put(PATH).send({ tokenBundle });

      const problem = expectProblem(response, 400, ErrorCode.validation);
      expect(problem.issues).toEqual([expect.objectContaining({ path: "tokenBundle" })]);
    }
    expect(profile).not.toHaveBeenCalled();
    expect(await connections()).toEqual([]);
  });

  it("returns 400 validation for an unknown field, a missing bundle or one that is not a string", async () => {
    const agent = await signedInAgent(app);
    const profile = vi.spyOn(garminClient, "profile");

    const unknown = await agent
      .put(PATH)
      .send({ tokenBundle: garminBundle(), userId: "00000000-0000-4000-8000-000000000000" });
    const missing = await agent.put(PATH).send({});
    const notString = await agent.put(PATH).send({ tokenBundle: { di_token: "fixture-token" } });

    expectProblem(unknown, 400, ErrorCode.validation);
    expectProblem(missing, 400, ErrorCode.validation);
    expectProblem(notString, 400, ErrorCode.validation);
    expect(profile).not.toHaveBeenCalled();
    expect(await connections()).toEqual([]);
  });

  it("returns 429 with Retry-After and stores nothing when Garmin rate limits (Garmin 429)", async () => {
    const agent = await signedInAgent(app);
    const sent = fixturesSentTo("/profile");

    const response = await agent.put(PATH).send({ tokenBundle: garminBundle("rate_limited") });

    const problem = expectProblem(response, 429, ErrorCode.garminRateLimited);
    expect(problem.retryAfterSeconds).toBe(3600);
    expect(response.headers["retry-after"]).toBe("3600");
    expect(sent()).toEqual(["rate_limited"]);
    expect(await connections()).toEqual([]);
  });

  it("returns 502 and stores nothing when Garmin is down (Garmin outage)", async () => {
    const agent = await signedInAgent(app);

    const response = await agent.put(PATH).send({ tokenBundle: garminBundle("unavailable") });

    expectProblem(response, 502, ErrorCode.garminUnavailable);
    expect(await connections()).toEqual([]);
  });

  it("waits for a running sync of the same user before checking the bundle (overlapping sync)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle(), {
      lastSyncAt: new Date("2026-09-26T12:00:00Z"),
    });
    const events: string[] = [];
    const sync = garminClient.sync.bind(garminClient);
    vi.spyOn(garminClient, "sync").mockImplementation(async (body, options) => {
      events.push("sync start");
      await sleep(50);
      const answer = await sync(body, options);
      events.push("sync end");
      return answer;
    });
    const profile = garminClient.profile.bind(garminClient);
    vi.spyOn(garminClient, "profile").mockImplementation((body, options) => {
      events.push("profile");
      return profile(body, options);
    });

    // syncGarmin joins the user's lock queue before its first await, so it is ahead of the request.
    const running = syncGarmin({ userId, now: new Date("2026-09-28T10:00:00Z") });
    const response = await agent.put(PATH).send({ tokenBundle: garminBundle() });
    await running;

    expect(response.status).toBe(200);
    expect(events).toEqual(["sync start", "sync end", "profile"]);
  });

  it("returns 401 without a session and calls no Garmin", async () => {
    const profile = vi.spyOn(garminClient, "profile");

    const response = await request(app).put(PATH).send({ tokenBundle: garminBundle() });

    expectProblem(response, 401, ErrorCode.unauthorized);
    expect(profile).not.toHaveBeenCalled();
    expect(await connections()).toEqual([]);
  });

  it("returns 429 rate_limited on the 7th call in a minute without calling Garmin, in its own bucket", async () => {
    const agent = await signedInAgent(app);
    const sent = fixturesSentTo("/profile");
    for (let call = 0; call < 6; call += 1) {
      expect((await agent.put(PATH).send({ tokenBundle: garminBundle() })).status).toBe(200);
    }

    const response = await agent.put(PATH).send({ tokenBundle: garminBundle() });

    const problem = expectProblem(response, 429, ErrorCode.rateLimited);
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
    expect(problem.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(response.headers["retry-after"]).toBe(String(problem.retryAfterSeconds));
    expect(sent()).toHaveLength(6);
    // Sync now counts separately.
    expect((await agent.post("/api/sync")).status).toBe(200);
  });
});
