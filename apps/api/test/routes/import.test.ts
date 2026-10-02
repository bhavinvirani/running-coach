import { ErrorCode, importProgressSchema } from "@running-coach/shared";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { stopJobs } from "../../src/jobs";
import { getBoss, startBoss } from "../../src/jobs/boss";
import * as importJob from "../../src/jobs/import-history";
import { importLimiter } from "../../src/routes/import";
import { createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import {
  connectGarmin,
  createLongRun,
  fixturesSentTo,
  garminBundle,
  seedImport,
  storedImport,
} from "../seed";

// GET and POST /api/import on the real Postgres. pg-boss runs without the import worker, so a queued page
// stays queued and each test sees exactly what POST queued.

const app = createTestApp();
const PATH = "/api/import";

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(importJob.name, importJob.queue);
});

afterAll(async () => {
  await stopJobs();
});

afterEach(() => {
  importLimiter.reset();
});

async function connectedOwner(status: "ok" | "expired" = "ok") {
  const agent = await signedInAgent(app);
  const userId = await ownerId();
  await connectGarmin(userId, garminBundle(), { status });
  return { agent, userId };
}

/** The user's page jobs waiting to run. */
async function queuedPages(userId: string) {
  return getBoss().findJobs<object>(importJob.name, { key: userId, queued: true });
}

/** Queues a page of the user's import as the chain does; `startAfter` defers it. */
async function queuePage(userId: string, startAfter?: Date): Promise<string> {
  const id = await getBoss().send(
    importJob.name,
    { userId },
    { ...importJob.sendOptions({ userId }), ...(startAfter ? { startAfter } : {}) },
  );
  if (!id) throw new Error("page not queued");
  return id;
}

describe("GET /api/import", () => {
  it("returns not_started and the runs already stored for a runner who never imported", async () => {
    const { agent, userId } = await connectedOwner();
    await createLongRun(userId);

    const response = await agent.get(PATH);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(importProgressSchema.parse(response.body)).toEqual({
      status: "not_started",
      runsStored: 1,
      oldestDate: null,
      startedAt: null,
      finishedAt: null,
      resumeAt: null,
      errorCode: null,
    });
  });

  it("returns a paused import with when it resumes and why", async () => {
    const { agent, userId } = await connectedOwner();
    const resumeAt = new Date(Date.now() + 1800 * 1000);
    await seedImport(userId, {
      status: "paused",
      nextOffset: 95,
      cursorDate: "2024-03-17",
      resumeAt,
      lastError: ErrorCode.garminRateLimited,
    });
    await queuePage(userId, resumeAt);

    const response = await agent.get(PATH);

    expect(importProgressSchema.parse(response.body)).toMatchObject({
      status: "paused",
      oldestDate: "2024-03-17",
      resumeAt: resumeAt.toISOString(),
      errorCode: ErrorCode.garminRateLimited,
    });
  });

  it("returns stalled for an import marked running with no page job left to run (stalled)", async () => {
    const { agent, userId } = await connectedOwner();
    await seedImport(userId);

    const response = await agent.get(PATH);

    expect(importProgressSchema.parse(response.body).status).toBe("stalled");
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).get(PATH), 401, ErrorCode.unauthorized);
  });
});

describe("POST /api/import", () => {
  it("starts an import and queues its first page without calling Garmin itself", async () => {
    const { agent, userId } = await connectedOwner();
    const sent = fixturesSentTo("/history");

    const response = await agent.post(PATH);

    expect(response.status).toBe(200);
    const body = importProgressSchema.parse(response.body);
    expect(body).toMatchObject({ status: "running", oldestDate: null, finishedAt: null });
    expect(body.startedAt).not.toBeNull();
    expect(await storedImport(userId)).toMatchObject({ status: "running", nextOffset: 0 });
    const queued = await queuedPages(userId);
    expect(queued.map((job) => job.data)).toEqual([{ userId }]);
    expect(sent()).toEqual([]);
  });

  it("starts one import and queues one page for two concurrent POSTs (double tap)", async () => {
    const { agent, userId } = await connectedOwner();

    const [first, second] = await Promise.all([agent.post(PATH), agent.post(PATH)]);

    expect([first.status, second.status]).toEqual([200, 200]);
    const bodies = [first, second].map((response) => importProgressSchema.parse(response.body));
    expect(bodies.map((body) => body.status)).toEqual(["running", "running"]);
    expect(bodies[0]?.startedAt).toBe(bodies[1]?.startedAt);
    expect(await queuedPages(userId)).toHaveLength(1);
  });

  it("changes nothing and queues nothing while the import's page waits, waits for a retry, or is deferred by a 429 (Garmin outage)", async () => {
    const { agent, userId } = await connectedOwner();
    const running = await seedImport(userId, { nextOffset: 95 });
    const page = await queuePage(userId);

    const whileWaiting = await agent.post(PATH);
    // Garmin failed the attempt: pg-boss retries it 5 to 10 minutes later.
    await getBoss().fail(importJob.name, page);
    const whileRetrying = await agent.post(PATH);
    await seedImport(userId, {
      status: "paused",
      nextOffset: 95,
      startedAt: running.startedAt,
      resumeAt: new Date(Date.now() + 600_000),
      lastError: ErrorCode.garminRateLimited,
    });
    const whilePaused = await agent.post(PATH);

    expect(
      [whileWaiting, whileRetrying, whilePaused].map(
        (response) => importProgressSchema.parse(response.body).status,
      ),
    ).toEqual(["running", "running", "paused"]);
    expect(await storedImport(userId)).toMatchObject({ status: "paused", nextOffset: 95 });
    const jobs = await getBoss().findJobs<object>(importJob.name, { key: userId });
    expect(jobs.map((job) => [job.id, job.state])).toEqual([[page, "retry"]]);
  });

  it("resumes a failed import from its cursor and clears the error", async () => {
    const { agent, userId } = await connectedOwner();
    const failed = await seedImport(userId, {
      status: "failed",
      nextOffset: 195,
      cursorDate: "2024-03-17",
      lastError: ErrorCode.garminUnavailable,
    });

    const response = await agent.post(PATH);

    expect(importProgressSchema.parse(response.body)).toMatchObject({
      status: "running",
      oldestDate: "2024-03-17",
      startedAt: failed.startedAt.toISOString(),
      errorCode: null,
    });
    expect(await storedImport(userId)).toMatchObject({ nextOffset: 195, lastError: null });
    expect(await queuedPages(userId)).toHaveLength(1);
  });

  it("resumes a stalled import from its cursor with one page (stalled)", async () => {
    const { agent, userId } = await connectedOwner();
    // Marked running, but pg-boss holds no page of it.
    await seedImport(userId, { nextOffset: 95, cursorDate: "2025-01-11" });

    const response = await agent.post(PATH);

    expect(importProgressSchema.parse(response.body)).toMatchObject({
      status: "running",
      oldestDate: "2025-01-11",
    });
    expect(await storedImport(userId)).toMatchObject({ status: "running", nextOffset: 95 });
    expect(await queuedPages(userId)).toHaveLength(1);
  });

  it("starts a fresh import from the newest run after a finished one and keeps the stored runs", async () => {
    const { agent, userId } = await connectedOwner();
    await createLongRun(userId);
    const finished = await seedImport(userId, {
      status: "done",
      nextOffset: 49,
      cursorDate: "2023-09-17",
      startedAt: new Date("2026-09-01T10:00:00Z"),
      finishedAt: new Date("2026-09-01T10:05:00Z"),
    });

    const response = await agent.post(PATH);

    const body = importProgressSchema.parse(response.body);
    expect(body).toMatchObject({
      status: "running",
      runsStored: 1,
      oldestDate: null,
      finishedAt: null,
    });
    expect(body.startedAt).not.toBe(finished.startedAt.toISOString());
    expect(await storedImport(userId)).toMatchObject({ nextOffset: 0, cursorDate: null });
    expect(await queuedPages(userId)).toHaveLength(1);
  });

  it("returns 409 garmin_not_connected without a Garmin connection, and starts nothing", async () => {
    const agent = await signedInAgent(app);

    expectProblem(await agent.post(PATH), 409, ErrorCode.garminNotConnected);

    const progress = await agent.get(PATH);
    expect(importProgressSchema.parse(progress.body).status).toBe("not_started");
    expect(await queuedPages(await ownerId())).toEqual([]);
  });

  it("returns 409 garmin_auth_expired when the login is marked expired, and starts nothing (token expiry)", async () => {
    const { agent, userId } = await connectedOwner("expired");
    await seedImport(userId, { status: "failed", lastError: ErrorCode.garminAuthExpired });

    expectProblem(await agent.post(PATH), 409, ErrorCode.garminAuthExpired);

    expect((await storedImport(userId)).status).toBe("failed");
    expect(await queuedPages(userId)).toEqual([]);
  });

  it("returns 401 without a session", async () => {
    expectProblem(await request(app).post(PATH), 401, ErrorCode.unauthorized);
  });

  it("returns 429 rate_limited on the 7th POST in a minute", async () => {
    const { agent } = await connectedOwner();
    for (let call = 0; call < 6; call += 1) {
      expect((await agent.post(PATH)).status).toBe(200);
    }

    const response = await agent.post(PATH);

    const problem = expectProblem(response, 429, ErrorCode.rateLimited);
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
    expect(response.headers["retry-after"]).toBe(String(problem.retryAfterSeconds));
  });
});
