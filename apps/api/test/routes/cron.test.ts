import { cronSyncResponseSchema, ErrorCode } from "@running-coach/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopJobs } from "../../src/jobs";
import { getBoss, startBoss } from "../../src/jobs/boss";
import * as syncQueue from "../../src/jobs/sync-garmin-queue";
import { config } from "../../src/lib/config";
import { localDateOf } from "../../src/lib/local-date";
import { queueDailySyncs } from "../../src/services/daily-sync";
import { createTestApp, expectProblem, signedInAgent } from "../helpers";
import { connectGarmin, createUser, fixturesSentTo, garminBundle, setSettings } from "../seed";

// POST /api/cron/sync on the real Postgres. pg-boss runs without the sync worker, so a queued sync stays
// queued and each test sees exactly what the cron queued.

const app = createTestApp();
const PATH = "/api/cron/sync";
const SECRET = config.CRON_SECRET ?? "";

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(syncQueue.name, syncQueue.queue);
});

afterAll(async () => {
  await stopJobs();
});

let users = 0;

/** A user with a settings time zone and, unless "none", a Garmin connection in that status. */
async function runner(
  status: "ok" | "expired" | "none" = "ok",
  timezone = "Europe/Berlin",
  values: Parameters<typeof connectGarmin>[2] = {},
): Promise<string> {
  users += 1;
  const userId = await createUser(`runner-${users}@example.com`);
  await setSettings(userId, { timezone });
  if (status !== "none") await connectGarmin(userId, garminBundle(), { status, ...values });
  return userId;
}

/** Every sync job of the user, whatever its state. */
async function syncJobs(userId: string) {
  return getBoss().findJobs<object>(syncQueue.name, { key: userId });
}

function fire(authorization?: string) {
  const call = request(app).post(PATH);
  return authorization === undefined ? call : call.set("authorization", authorization);
}

describe("POST /api/cron/sync", () => {
  it.each([
    ["no Authorization header", undefined],
    ["another scheme (Basic)", `Basic ${Buffer.from(`cron:${SECRET}`).toString("base64")}`],
    ["a wrong secret", "Bearer not-the-cron-secret-at-all"],
    ["the secret with a character missing", `Bearer ${SECRET.slice(0, -1)}`],
    ["Bearer without a secret", "Bearer "],
  ])("returns 401 unauthorized and queues nothing for %s", async (_case, authorization) => {
    const userId = await runner();

    const response = await fire(authorization);

    expectProblem(response, 401, ErrorCode.unauthorized);
    expect(await syncJobs(userId)).toEqual([]);
  });

  it("returns 401 and queues nothing when CRON_SECRET is not configured, even for a matching token", async () => {
    const userId = await runner();
    const configured = config.CRON_SECRET;
    config.CRON_SECRET = undefined;
    try {
      expectProblem(await fire(`Bearer ${SECRET}`), 401, ErrorCode.unauthorized);
    } finally {
      config.CRON_SECRET = configured;
    }
    expect(await syncJobs(userId)).toEqual([]);
  });

  it("returns 401 for a signed-in session without the secret: a session does not authorize the cron", async () => {
    const agent = await signedInAgent(app);

    expectProblem(await agent.post(PATH), 401, ErrorCode.unauthorized);
  });

  it("queues one sync per user with a working login, keyed on the user's local date, and answers { connected, queued }", async () => {
    const berlin = await runner("ok", "Europe/Berlin");
    const honolulu = await runner("ok", "Pacific/Honolulu");
    const sent = fixturesSentTo("/sync");
    const before = new Date();

    const response = await fire(`Bearer ${SECRET}`);

    const after = new Date();
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(cronSyncResponseSchema.parse(response.body)).toEqual({ connected: 2, queued: 2 });
    for (const [userId, timezone] of [
      [berlin, "Europe/Berlin"],
      [honolulu, "Pacific/Honolulu"],
    ] as const) {
      const [job, ...others] = await syncJobs(userId);
      expect(others).toEqual([]);
      // The date at the fire time; either side of a local midnight passing mid-request.
      const dates = [localDateOf(before, timezone), localDateOf(after, timezone)];
      expect(dates).toContain((job?.data as { date?: string }).date);
      expect(job?.id).toBe(syncQueue.jobId({ userId, date: (job?.data as { date: string }).date }));
      expect(job?.state).toBe("created");
    }
    // Queued, not run: the cron never calls Garmin in the request.
    expect(sent()).toEqual([]);
  });

  it("queues one job per user and date when the cron fires twice in a row (double fire)", async () => {
    const userId = await runner();

    const first = await fire(`Bearer ${SECRET}`);
    const second = await fire(`Bearer ${SECRET}`);

    expect(cronSyncResponseSchema.parse(first.body)).toEqual({ connected: 1, queued: 1 });
    expect(cronSyncResponseSchema.parse(second.body)).toEqual({ connected: 1, queued: 0 });
    const jobs = await syncJobs(userId);
    expect(jobs).toHaveLength(1);
    const { date } = jobs[0]?.data as { date: string };
    expect(jobs[0]?.id).toBe(syncQueue.jobId({ userId, date }));
  });

  it("queues nothing for an expired or missing Garmin login, so a dead login gets no daily job (token expiry, no retry storm)", async () => {
    const expired = await runner("expired");
    const notConnected = await runner("none");

    const response = await fire(`Bearer ${SECRET}`);

    expect(cronSyncResponseSchema.parse(response.body)).toEqual({ connected: 0, queued: 0 });
    expect(await syncJobs(expired)).toEqual([]);
    expect(await syncJobs(notConnected)).toEqual([]);
  });

  it("still queues a user in the hour after a Garmin 429: the job refuses without calling Garmin and defers itself (Garmin 429)", async () => {
    const userId = await runner("ok", "Europe/Berlin", { lastError: ErrorCode.garminRateLimited });

    const response = await fire(`Bearer ${SECRET}`);

    expect(cronSyncResponseSchema.parse(response.body)).toEqual({ connected: 1, queued: 1 });
    expect(await syncJobs(userId)).toHaveLength(1);
  });

  it("leaves every other /api path behind the session: 401 without one, 404 for an unknown path with one", async () => {
    expectProblem(await request(app).get("/api/no-such-path"), 401, ErrorCode.unauthorized);
    expectProblem(
      await request(app).get(PATH).set("authorization", `Bearer ${SECRET}`),
      401,
      ErrorCode.unauthorized,
    );
    expectProblem(
      await request(app).get("/api/me").set("authorization", `Bearer ${SECRET}`),
      401,
      ErrorCode.unauthorized,
    );
    const agent = await signedInAgent(app);
    expectProblem(await agent.get("/api/no-such-path"), 404, ErrorCode.notFound);
  });
});

describe("queueDailySyncs", () => {
  it("keys each user's sync on their own local date at the fire time (time zones)", async () => {
    // 23:30 UTC on 2026-10-01: already 2026-10-02 at UTC+14, still 2026-10-01 at UTC-10, and 01:30 on
    // 2026-10-02 in Berlin's summer time.
    const now = new Date("2026-10-01T23:30:00Z");
    const expected = [
      [await runner("ok", "Pacific/Kiritimati"), "2026-10-02"],
      [await runner("ok", "Pacific/Honolulu"), "2026-10-01"],
      [await runner("ok", "Europe/Berlin"), "2026-10-02"],
    ] as const;

    const result = await queueDailySyncs({ now });

    expect(result).toEqual({ connected: 3, queued: 3 });
    for (const [userId, date] of expected) {
      const jobs = await syncJobs(userId);
      expect(jobs.map((job) => ({ id: job.id, data: job.data }))).toEqual([
        { id: syncQueue.jobId({ userId, date }), data: { userId, date } },
      ]);
    }
  });

  it("queues nothing new on a second fire at the same local date, and counts only what it queued (double fire)", async () => {
    const userId = await runner("ok", "Pacific/Honolulu");

    const first = await queueDailySyncs({ now: new Date("2026-10-01T18:00:00Z") });
    // Six hours later: still 2026-10-01 in Honolulu.
    const second = await queueDailySyncs({ now: new Date("2026-10-02T00:00:00Z") });

    expect(first).toEqual({ connected: 1, queued: 1 });
    expect(second).toEqual({ connected: 1, queued: 0 });
    expect((await syncJobs(userId)).map((job) => job.id)).toEqual([
      syncQueue.jobId({ userId, date: "2026-10-01" }),
    ]);
  });
});
