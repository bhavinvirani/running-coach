import { cronSyncResponseSchema, ErrorCode } from "@running-coach/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopJobs } from "../../src/jobs";
import { getBoss, startBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
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
  await boss.createQueue(pushQueue.name, pushQueue.queue);
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

/** Every workout push of the user, whatever its state. */
async function pushJobs(userId: string) {
  return getBoss().findJobs<object>(pushQueue.name, { key: userId });
}

/** The UTC calendar date of an instant, which keys the cron's jobs. */
const utcDate = (instant: Date) => instant.toISOString().slice(0, 10);

/** Completes a queued sync as the worker would, so a later send cannot fold into a waiting job. */
async function runQueued(jobId: string) {
  await getBoss().complete(syncQueue.name, jobId, null, { includeQueued: true });
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

  it("queues one sync per user with a working login, keyed on the fire's UTC date, and answers { connected, queued }", async () => {
    const berlin = await runner("ok", "Europe/Berlin");
    const honolulu = await runner("ok", "Pacific/Honolulu");
    const sent = fixturesSentTo("/sync");
    const before = new Date();

    const response = await fire(`Bearer ${SECRET}`);

    const after = new Date();
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(cronSyncResponseSchema.parse(response.body)).toEqual({ connected: 2, queued: 2 });
    for (const userId of [berlin, honolulu]) {
      const [job, ...others] = await syncJobs(userId);
      expect(others).toEqual([]);
      // The UTC date at the fire time; either side of a UTC midnight passing mid-request.
      const dates = [utcDate(before), utcDate(after)];
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
  it("queues one workout push per user with a working login beside the sync, once however often the cron fires (double fire)", async () => {
    const userId = await runner("ok");
    const expired = await runner("expired");
    const notConnected = await runner("none");
    const now = new Date("2026-10-02T03:30:00Z");

    await queueDailySyncs({ now });
    await queueDailySyncs({ now });
    await queueDailySyncs({ now: new Date("2026-10-02T04:05:00Z") });

    expect((await pushJobs(userId)).map((job) => ({ id: job.id, data: job.data }))).toEqual([
      { id: pushQueue.cronJobId({ userId }, "2026-10-02"), data: { userId } },
    ]);
    expect(await pushJobs(expired)).toEqual([]);
    expect(await pushJobs(notConnected)).toEqual([]);
  });

  it("queues no second push when an edit's push already waits for the user", async () => {
    const userId = await runner("ok");
    const waiting = await pushQueue.enqueuePushWorkouts({ userId });

    await queueDailySyncs({ now: new Date("2026-10-02T03:30:00Z") });

    expect((await pushJobs(userId)).map((job) => job.id)).toEqual([waiting]);
  });

  it("queues the next day's push once the previous day's has run", async () => {
    const userId = await runner("ok");
    await queueDailySyncs({ now: new Date("2026-10-02T03:30:00Z") });
    await getBoss().complete(pushQueue.name, pushQueue.cronJobId({ userId }, "2026-10-02"), null, {
      includeQueued: true,
    });

    await queueDailySyncs({ now: new Date("2026-10-03T03:30:00Z") });

    expect((await pushJobs(userId)).map((job) => job.id).toSorted()).toEqual(
      [
        pushQueue.cronJobId({ userId }, "2026-10-02"),
        pushQueue.cronJobId({ userId }, "2026-10-03"),
      ].toSorted(),
    );
  });

  it("keys every user's sync on the fire's UTC date, whatever their local date (time zones)", async () => {
    // The daily fire, 03:30 UTC on 2026-10-02: 17:30 that day at UTC+14, still 2026-10-01 at UTC-10 (17:30)
    // and in New York's summer time (23:30).
    const now = new Date("2026-10-02T03:30:00Z");
    const users = [
      await runner("ok", "Pacific/Kiritimati"),
      await runner("ok", "Pacific/Honolulu"),
      await runner("ok", "America/New_York"),
    ];

    const result = await queueDailySyncs({ now });

    expect(result).toEqual({ connected: 3, queued: 3 });
    const date = "2026-10-02";
    for (const userId of users) {
      const jobs = await syncJobs(userId);
      expect(jobs.map((job) => ({ id: job.id, data: job.data }))).toEqual([
        { id: syncQueue.jobId({ userId, date }), data: { userId, date } },
      ]);
    }
  });

  it.each([
    // A fire delayed to 00:05 EDT, then the next on time at 23:30 EDT the same local day.
    [
      "America/New_York in July, the first fire delayed",
      "America/New_York",
      "2026-07-01T04:05:00Z",
      "2026-07-02T03:30:00Z",
    ],
    // 00:30 ADT before the fall-back, then 23:30 AST the same local day.
    [
      "America/Halifax at the fall-back (DST)",
      "America/Halifax",
      "2026-11-01T03:30:00Z",
      "2026-11-02T03:30:00Z",
    ],
  ])(
    "queues on both days when two daily fires share the user's local date: %s (lost day)",
    async (_case, timezone, firstFire, secondFire) => {
      const userId = await runner("ok", timezone);
      const first = new Date(firstFire);
      const second = new Date(secondFire);
      // The scenario: both fires fall on one local date, so a local-date key would drop the second day.
      expect(localDateOf(first, timezone)).toBe(localDateOf(second, timezone));

      expect(await queueDailySyncs({ now: first })).toEqual({ connected: 1, queued: 1 });
      const firstJob = syncQueue.jobId({ userId, date: utcDate(first) });
      await runQueued(firstJob);
      expect(await queueDailySyncs({ now: second })).toEqual({ connected: 1, queued: 1 });

      const ids = (await syncJobs(userId)).map((job) => job.id);
      expect(ids.toSorted()).toEqual(
        [firstJob, syncQueue.jobId({ userId, date: utcDate(second) })].toSorted(),
      );
    },
  );

  it("queues one job per user on two fires the same UTC day, 03:30Z and a delayed 04:05Z, even after the first has run (double fire)", async () => {
    // 23:30 and 00:05 in New York: a local-date key would queue that user twice.
    const users = [
      await runner("ok", "America/New_York"),
      await runner("ok", "Pacific/Kiritimati"),
    ];

    const first = await queueDailySyncs({ now: new Date("2026-07-01T03:30:00Z") });
    for (const userId of users) await runQueued(syncQueue.jobId({ userId, date: "2026-07-01" }));
    const second = await queueDailySyncs({ now: new Date("2026-07-01T04:05:00Z") });

    expect(first).toEqual({ connected: 2, queued: 2 });
    expect(second).toEqual({ connected: 2, queued: 0 });
    for (const userId of users) {
      expect((await syncJobs(userId)).map((job) => job.id)).toEqual([
        syncQueue.jobId({ userId, date: "2026-07-01" }),
      ]);
    }
  });
});
