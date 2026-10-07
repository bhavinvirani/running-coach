import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCode,
  garminLoginConnectedSchema,
  startGarminLoginResponseSchema,
} from "@running-coach/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/client";
import { activity, garminConnection } from "../../src/db/schema";
import { garminClient } from "../../src/garmin/client";
import { getBoss, startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { decrypt } from "../../src/lib/crypto";
import { DomainError } from "../../src/lib/errors";
import { connectGarminLimiter } from "../../src/routes/garmin";
import { syncLimiter } from "../../src/routes/sync";
import { syncGarmin } from "../../src/services/garmin-sync";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { connectGarmin, createLongRun, fixturesSentTo, garminBundle } from "../seed";
import { FIXTURE_LOGIN } from "../seed-garmin-login";

// The web Garmin login against the Garmin service in fixture mode (FIXTURE_LOGIN). The service keeps a
// pending login under the user id, which is new for every test (tables are truncated), so tests never
// share one. pg-boss runs without workers, so the workout push a connect queues stays queued.

const app = createTestApp();
const LOGIN = "/api/garmin/login";
const CODE = "/api/garmin/login/code";

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
});

afterEach(() => {
  vi.restoreAllMocks();
  connectGarminLimiter.reset();
  syncLimiter.reset();
});

async function pushJobs(userId: string) {
  return getBoss().findJobs(pushQueue.name, { key: userId });
}

async function connections() {
  return db.select().from(garminConnection);
}

async function storedConnection(userId: string) {
  const [row] = await db.select().from(garminConnection).where(eq(garminConnection.userId, userId));
  if (!row) throw new Error("no connection stored");
  return row;
}

type Agent = Awaited<ReturnType<typeof signedInAgent>>;

function startLogin(agent: Agent, email: string = FIXTURE_LOGIN.email) {
  return agent.post(LOGIN).send({ email, password: FIXTURE_LOGIN.password });
}

function sendCode(agent: Agent, mfaCode: string = FIXTURE_LOGIN.code) {
  return agent.post(CODE).send({ mfaCode });
}

/** The stored login holds the fixture's base bundle, encrypted, and works. */
async function expectConnected(userId: string) {
  const row = await storedConnection(userId);
  expect(row).toMatchObject({ status: "ok", lastError: null });
  expect(row.tokenBundleEnc.startsWith("v1:")).toBe(true);
  expect(decrypt(row.tokenBundleEnc, userId)).toBe(garminBundle());
  return row;
}

describe("POST /api/garmin/login", () => {
  it("answers code_needed and stores nothing until the code comes (2FA)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();

    const response = await startLogin(agent);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(startGarminLoginResponseSchema.parse(response.body)).toEqual({ status: "code_needed" });
    expect(await connections()).toEqual([]);
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("connects in one call when Garmin asks for no code: proved, stored encrypted, a push queued", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const proofs = fixturesSentTo("/profile");

    const response = await startLogin(agent, FIXTURE_LOGIN.noCodeEmail);

    expect(response.status).toBe(200);
    expect(startGarminLoginResponseSchema.parse(response.body)).toEqual({
      status: "connected",
      displayName: "Alex Fixture",
    });
    await expectConnected(userId);
    expect(proofs()).toHaveLength(1);
    expect((await pushJobs(userId)).map((job) => [job.state, job.data])).toEqual([
      ["created", { userId }],
    ]);
  });

  it("returns 422 garmin_credentials_rejected and leaves an expired login as it was (wrong password)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle("expired"), {
      status: "expired",
      lastError: ErrorCode.garminAuthExpired,
    });
    const before = await storedConnection(userId);

    const response = await agent
      .post(LOGIN)
      .send({ email: FIXTURE_LOGIN.email, password: "not-the-password" });

    expectProblem(response, 422, ErrorCode.garminCredentialsRejected);
    expect(await storedConnection(userId)).toEqual(before);
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("returns 502 garmin_unavailable and leaves an expired login as it was when Garmin is down (Garmin outage)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle("expired"), {
      status: "expired",
      lastError: ErrorCode.garminAuthExpired,
    });
    const before = await storedConnection(userId);
    vi.spyOn(garminClient, "login").mockRejectedValueOnce(
      new DomainError(
        ErrorCode.garminUnavailable,
        502,
        "Garmin is not answering. Try again later.",
      ),
    );

    const response = await startLogin(agent);

    expectProblem(response, 502, ErrorCode.garminUnavailable);
    expect(await storedConnection(userId)).toEqual(before);
    expect(await pushJobs(userId)).toEqual([]);
  });

  it("returns 429 with Retry-After after one Garmin login, stores nothing and starts no sync hour (Garmin 429)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle(), { lastSyncAt: new Date("2026-09-26T12:00:00Z") });
    const before = await storedConnection(userId);
    const logins = fixturesSentTo("/connect");

    const response = await startLogin(agent, FIXTURE_LOGIN.rateLimitedEmail);

    const problem = expectProblem(response, 429, ErrorCode.garminRateLimited);
    expect(problem.retryAfterSeconds).toBe(3600);
    expect(response.headers["retry-after"]).toBe("3600");
    expect(logins()).toHaveLength(1);
    expect(await storedConnection(userId)).toEqual(before);
    // The stored login's hour (openGarminAccount) is not started: Sync now still calls Garmin.
    expect((await agent.post("/api/sync")).status).toBe(200);
  });

  it("returns 429 and stores no row for a runner without Garmin (Garmin 429)", async () => {
    const agent = await signedInAgent(app);

    expectProblem(
      await startLogin(agent, FIXTURE_LOGIN.rateLimitedEmail),
      429,
      ErrorCode.garminRateLimited,
    );
    expect(await connections()).toEqual([]);
  });

  it("returns 400 validation without echoing the password, and calls no Garmin, for a bad body", async () => {
    const agent = await signedInAgent(app);
    const login = vi.spyOn(garminClient, "login");
    const secret = "pw-that-must-not-echo";

    const bodies = [
      {},
      { email: FIXTURE_LOGIN.email },
      { email: "not an email", password: secret },
      { email: FIXTURE_LOGIN.email, password: "" },
      { email: FIXTURE_LOGIN.email, password: "x".repeat(257) },
      { email: FIXTURE_LOGIN.email, password: secret, loginId: "someone-else" },
    ];
    for (const body of bodies) {
      const response = await agent.post(LOGIN).send(body);

      expectProblem(response, 400, ErrorCode.validation);
      expect(response.text).not.toContain(secret);
    }
    expect(login).not.toHaveBeenCalled();
    expect(await connections()).toEqual([]);
  });

  it("returns 401 without a session and calls no Garmin", async () => {
    const login = vi.spyOn(garminClient, "login");

    const response = await request(app)
      .post(LOGIN)
      .send({ email: FIXTURE_LOGIN.email, password: FIXTURE_LOGIN.password });

    expectProblem(response, 401, ErrorCode.unauthorized);
    expect(login).not.toHaveBeenCalled();
  });

  it("stores the login only after a running sync of the same user finishes (overlapping syncs)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await connectGarmin(userId, garminBundle(), { lastSyncAt: new Date("2026-09-26T12:00:00Z") });
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
    const response = await startLogin(agent, FIXTURE_LOGIN.noCodeEmail);
    await running;

    expect(response.status).toBe(200);
    expect(events).toEqual(["sync start", "sync end", "profile"]);
    await expectConnected(userId);
  });

  it("counts every connect attempt in one budget: the 7th in a minute is 429 rate_limited without Garmin", async () => {
    const agent = await signedInAgent(app);
    const login = vi.spyOn(garminClient, "login");

    expect(
      (await agent.put("/api/garmin/connection").send({ tokenBundle: garminBundle() })).status,
    ).toBe(200);
    expect((await agent.delete("/api/garmin/connection?workouts=keep")).status).toBe(200);
    expect((await startLogin(agent)).status).toBe(200);
    expect((await sendCode(agent, FIXTURE_LOGIN.wrongCode)).status).toBe(422);
    expect((await sendCode(agent)).status).toBe(200);
    expect((await startLogin(agent)).status).toBe(200);

    const response = await startLogin(agent);

    const problem = expectProblem(response, 429, ErrorCode.rateLimited);
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
    expect(problem.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(response.headers["retry-after"]).toBe(String(problem.retryAfterSeconds));
    expect(login).toHaveBeenCalledTimes(2);
    expectProblem(await sendCode(agent), 429, ErrorCode.rateLimited);
    // Sync now counts separately.
    expect((await agent.post("/api/sync")).status).toBe(200);
  });
});

describe("POST /api/garmin/login/code", () => {
  it("connects with the right code: proved, stored encrypted, a push queued, the bundle never sent back", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await startLogin(agent);

    const response = await sendCode(agent);

    expect(response.status).toBe(200);
    expect(garminLoginConnectedSchema.parse(response.body)).toEqual({
      status: "connected",
      displayName: "Alex Fixture",
    });
    const row = await expectConnected(userId);
    expect(row.lastSyncAt).toBeNull();
    expect((await pushJobs(userId)).map((job) => [job.state, job.data])).toEqual([
      ["created", { userId }],
    ]);
    for (const secret of ["fixture-token", "fixture-refresh", "tokenBundle", "v1:"]) {
      expect(response.text).not.toContain(secret);
    }
  });

  it("takes the right code after a wrong one on the same login, storing nothing in between (wrong code)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const logins = fixturesSentTo("/connect");
    await startLogin(agent);

    expectProblem(await sendCode(agent, FIXTURE_LOGIN.wrongCode), 422, ErrorCode.garminMfaRejected);
    expect(await connections()).toEqual([]);
    const response = await sendCode(agent);

    expect(response.status).toBe(200);
    await expectConnected(userId);
    expect(logins()).toHaveLength(1);
  });

  it("returns 502 garmin_unavailable and stores nothing when Garmin is down, and the same login then takes the code (Garmin outage)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    await startLogin(agent);
    vi.spyOn(garminClient, "loginCode").mockRejectedValueOnce(
      new DomainError(
        ErrorCode.garminUnavailable,
        502,
        "Garmin is not answering. Try again later.",
      ),
    );

    expectProblem(await sendCode(agent), 502, ErrorCode.garminUnavailable);
    expect(await connections()).toEqual([]);
    const response = await sendCode(agent);

    expect(response.status).toBe(200);
    await expectConnected(userId);
  });

  it("answers 409 garmin_login_lost on the third wrong code, and to the right code after it (lost login)", async () => {
    const agent = await signedInAgent(app);
    await startLogin(agent);

    expectProblem(await sendCode(agent, FIXTURE_LOGIN.wrongCode), 422, ErrorCode.garminMfaRejected);
    expectProblem(await sendCode(agent, FIXTURE_LOGIN.wrongCode), 422, ErrorCode.garminMfaRejected);
    expectProblem(await sendCode(agent, FIXTURE_LOGIN.wrongCode), 409, ErrorCode.garminLoginLost);
    expectProblem(await sendCode(agent), 409, ErrorCode.garminLoginLost);
    expect(await connections()).toEqual([]);
  });

  it("answers 409 garmin_login_lost and stores nothing for a code with no login started (lost login)", async () => {
    const agent = await signedInAgent(app);

    const response = await sendCode(agent);

    expectProblem(response, 409, ErrorCode.garminLoginLost);
    expect(await connections()).toEqual([]);
  });

  it("finishes only the signed-in runner's own login: another runner's code finds none", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const other = await signedInAgent(app, {
      email: "second.runner@example.com",
      password: "another-correct-horse-battery",
      name: "Second Runner",
    });
    await startLogin(agent);

    expectProblem(await sendCode(other), 409, ErrorCode.garminLoginLost);
    expect((await sendCode(agent)).status).toBe(200);
    await expectConnected(userId);
    expect(await connections()).toHaveLength(1);
  });

  it("reconnects an expired login: status ok, last error cleared, last_sync_at and runs kept (token expiry)", async () => {
    const agent = await signedInAgent(app);
    const userId = await ownerId();
    const lastSyncAt = new Date("2026-09-27T09:00:00Z");
    await connectGarmin(userId, garminBundle("expired"), {
      status: "expired",
      lastError: ErrorCode.garminAuthExpired,
      lastSyncAt,
    });
    await createLongRun(userId);
    await startLogin(agent);

    const response = await sendCode(agent);

    expect(response.status).toBe(200);
    expect(await connections()).toHaveLength(1);
    const row = await expectConnected(userId);
    expect(row.lastSyncAt).toEqual(lastSyncAt);
    expect(await db.select().from(activity)).toHaveLength(1);
    expect(await pushJobs(userId)).toHaveLength(1);
  });

  it("returns 400 validation and calls no Garmin for a code that is not 4 to 10 digits or a bad body", async () => {
    const agent = await signedInAgent(app);
    const loginCode = vi.spyOn(garminClient, "loginCode");

    for (const body of [
      {},
      { mfaCode: "12ab56" },
      { mfaCode: "123" },
      { mfaCode: "12345678901" },
      { mfaCode: 123456 },
      { mfaCode: FIXTURE_LOGIN.code, loginId: "someone-else" },
    ]) {
      expectProblem(await agent.post(CODE).send(body), 400, ErrorCode.validation);
    }
    expect(loginCode).not.toHaveBeenCalled();
  });

  it("returns 401 without a session and calls no Garmin", async () => {
    const loginCode = vi.spyOn(garminClient, "loginCode");

    const response = await request(app).post(CODE).send({ mfaCode: FIXTURE_LOGIN.code });

    expectProblem(response, 401, ErrorCode.unauthorized);
    expect(loginCode).not.toHaveBeenCalled();
  });
});
