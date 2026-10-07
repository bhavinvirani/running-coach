import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Job, JobWithMetadata } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startJobs, stopJobs } from "../../src/jobs";
import * as analyzeRunJob from "../../src/jobs/analyze-run";
import * as bestEffortsJob from "../../src/jobs/best-efforts";
import { getBoss } from "../../src/jobs/boss";
import * as pushJob from "../../src/jobs/push-workouts";
import * as syncJob from "../../src/jobs/sync-garmin";
import * as reviewJob from "../../src/jobs/weekly-review";
import { enqueueWeeklyReview, singletonKey } from "../../src/jobs/weekly-review-queue";
import { config } from "../../src/lib/config";
import { queueDailySyncs } from "../../src/services/daily-sync";
import { syncGarmin } from "../../src/services/garmin-sync";
import { latestReview, queueWeeklyReview } from "../../src/services/weekly-review";
import {
  configureCoachService,
  PLAN_OWNER_EMAIL,
  startFakeCoachService,
} from "../fake-coach-service";
import {
  claudeKey,
  claudeRequests,
  connectGarmin,
  createRunOn,
  createUser,
  setSettings,
} from "../seed";
import { storedReviews } from "../seed-weekly-review";

// The weekly-review job on pg-boss with the sync and review workers running, against the fake Claude, and
// against a fake coach service for the owner's Claude plan. Retries wait minutes, so a test that needs an
// attempt's outcome calls `handle` with the retry count pg-boss would give it. Today is Monday 2026-10-12
// in UTC unless a test moves the jobs' clock; the last ended week starts 2026-10-05.

const coach = await startFakeCoachService();
const NOW = new Date("2026-10-12T10:00:00Z");
const WEEK = "2026-10-05";
let jobClock = NOW;

beforeAll(async () => {
  await startJobs({ pollingIntervalSeconds: 0.5, clock: () => jobClock });
  // A sync queues these too; their workers would call Claude or Garmin beside the review under test.
  for (const name of [analyzeRunJob.name, bestEffortsJob.name, pushJob.name]) {
    await getBoss().offWork(name, { wait: true });
  }
});

afterAll(async () => {
  await stopJobs();
  await coach.close();
});

afterEach(() => {
  jobClock = NOW;
});

async function waitForJob(
  name: string,
  id: string | null,
  states: JobWithMetadata["state"][] = ["completed", "failed"],
): Promise<JobWithMetadata> {
  if (!id) throw new Error("no job id");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [job] = await getBoss().findJobs<object>(name, { id });
    if (job && states.includes(job.state)) return job;
    await sleep(100);
  }
  throw new Error(`job ${id} did not reach ${states.join(" or ")}`);
}

async function weekJobs(userId: string, weekStart = WEEK): Promise<JobWithMetadata[]> {
  const jobs = await getBoss().findJobs<object>(reviewJob.name, {
    key: singletonKey({ userId, weekStart }),
  });
  return jobs.sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime());
}

/** A job as the worker hands it to the handler, on the given attempt. */
function runningJob(userId: string, retryCount: number): Job<unknown> & { retryLimit: number } {
  return {
    id: randomUUID(),
    name: reviewJob.name,
    data: { userId, weekStart: WEEK },
    signal: new AbortController().signal,
    expireInSeconds: reviewJob.jobOptions.expireInSeconds,
    heartbeatSeconds: null,
    retryCount,
    retryLimit: reviewJob.jobOptions.retryLimit,
  };
}

/** A runner on the fixture's key with a run in the reviewed week. */
async function runnerWithKey(fixture: string) {
  const userId = await createUser();
  const key = claudeKey(fixture);
  await setSettings(userId, { claudeKey: key });
  await createRunOn(userId, "2026-10-07");
  return { userId, key };
}

describe("weekly-review job", () => {
  it("retries like analyze-run and expires a minute after the longest coach call", () => {
    expect(reviewJob.jobOptions).toEqual(analyzeRunJob.jobOptions);
  });

  it("stores the week's review and completes", async () => {
    const { userId } = await runnerWithKey("weekly-review-valid");

    const job = await waitForJob(
      reviewJob.name,
      await enqueueWeeklyReview({ userId, weekStart: WEEK }),
    );

    const [review] = await storedReviews(userId);
    expect(job).toMatchObject({
      state: "completed",
      output: { status: "stored", coachMessageId: review?.id, fallbackReason: null },
    });
    expect(review).toMatchObject({ weekStart: WEEK, model: config.COACH_MODEL });
  });

  it("runs once per runner and week however often it is queued, also after it ran (runs once per user per week)", async () => {
    const { userId, key } = await runnerWithKey("weekly-review-valid");

    const first = await enqueueWeeklyReview({ userId, weekStart: WEEK });
    expect(first).toBe(reviewJob.jobId({ userId, weekStart: WEEK }));
    expect(await enqueueWeeklyReview({ userId, weekStart: WEEK })).toBeNull();
    expect((await waitForJob(reviewJob.name, first)).state).toBe("completed");
    expect(await enqueueWeeklyReview({ userId, weekStart: WEEK })).toBeNull();

    expect(await weekJobs(userId)).toHaveLength(1);
    expect(await storedReviews(userId)).toHaveLength(1);
    expect(await claudeRequests(key)).toHaveLength(1);
  });

  it("makes one review when the daily cron fires twice: one sync job queues the review, and later syncs queue nothing (a daily job firing twice)", async () => {
    // The fixture runs end on Sunday 2026-09-27; the cron fires on the Monday after.
    jobClock = new Date("2026-09-28T03:30:00Z");
    const userId = await createUser();
    const key = claudeKey("weekly-review-valid");
    await setSettings(userId, { claudeKey: key });
    await connectGarmin(userId);

    expect(await queueDailySyncs({ now: jobClock })).toEqual({ connected: 1, queued: 1 });
    expect(await queueDailySyncs({ now: jobClock })).toEqual({ connected: 1, queued: 0 });
    const sync = await waitForJob(syncJob.name, syncJob.jobId({ userId, date: "2026-09-28" }));
    expect(sync.state).toBe("completed");
    const review = await waitForJob(
      reviewJob.name,
      reviewJob.jobId({ userId, weekStart: "2026-09-21" }),
    );
    expect(review.output).toMatchObject({ status: "stored" });

    // App open later that day, and the next day's cron: the review is stored, nothing is queued.
    await syncGarmin({ userId, now: jobClock });
    expect(await queueWeeklyReview(userId, new Date("2026-09-29T03:30:00Z"))).toBe(false);
    expect(await storedReviews(userId)).toMatchObject([{ weekStart: "2026-09-21" }]);
    expect(await weekJobs(userId, "2026-09-21")).toHaveLength(1);
    expect(await claudeRequests(key)).toHaveLength(1);
  });

  it("throws before the last attempt when Claude times out, so pg-boss retries, and stores the fallback card on the last (Claude timeout)", async () => {
    const { userId } = await runnerWithKey("timeout");

    await expect(
      reviewJob.handle(getBoss(), runningJob(userId, 0), () => NOW),
    ).rejects.toMatchObject({ code: "claude_unavailable" });
    expect(await storedReviews(userId)).toEqual([]);

    const outcome = await reviewJob.handle(
      getBoss(),
      runningJob(userId, reviewJob.jobOptions.retryLimit),
      () => NOW,
    );

    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "timeout" });
  });

  it("reads retrying on Today while a failed attempt waits to run again", async () => {
    const { userId } = await runnerWithKey("unavailable");

    const job = await waitForJob(
      reviewJob.name,
      await enqueueWeeklyReview({ userId, weekStart: WEEK }),
      ["retry", "failed", "completed"],
    );

    expect(job).toMatchObject({ state: "retry" });
    expect(await latestReview(userId, NOW)).toEqual({ state: "retrying" });
  });

  it("completes with the key_invalid card at once, without a retry (invalid Claude key)", async () => {
    const { userId } = await runnerWithKey("key-invalid");

    const job = await waitForJob(
      reviewJob.name,
      await enqueueWeeklyReview({ userId, weekStart: WEEK }),
    );

    expect(job).toMatchObject({
      state: "completed",
      retryCount: 0,
      output: { status: "stored", fallbackReason: "key_invalid" },
    });
  });
});

describe("weekly-review job on the Claude plan", () => {
  let restore: () => void = () => undefined;

  beforeEach(() => {
    coach.reset();
    restore = configureCoachService(coach);
  });

  afterEach(() => {
    restore();
  });

  async function ownerOnPlan() {
    const userId = await createUser(PLAN_OWNER_EMAIL);
    await setSettings(userId, { coachCredential: "plan" });
    await createRunOn(userId, "2026-10-07");
    return userId;
  }

  it("defers the week's job to the plan's reset without a failed attempt, while Today reads retrying (Claude quota)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 5400 } });
    const userId = await ownerOnPlan();

    const first = await waitForJob(
      reviewJob.name,
      await enqueueWeeklyReview({ userId, weekStart: WEEK }),
      ["completed", "retry", "failed"],
    );

    expect(first).toMatchObject({ state: "completed", retryCount: 0 });
    const output = first.output as { status: string; rescheduledJobIds: string[] };
    expect(output).toMatchObject({ status: "deferred", retryAfterSeconds: 5400 });
    const successor = (await weekJobs(userId)).find((job) => job.id !== first.id);
    expect(output.rescheduledJobIds).toEqual([successor?.id]);
    expect(successor).toMatchObject({
      state: "created",
      retryCount: 0,
      singletonKey: singletonKey({ userId, weekStart: WEEK }),
      data: { userId, weekStart: WEEK },
    });
    const waitS = ((successor?.startAfter.getTime() ?? 0) - Date.now()) / 1000;
    expect(waitS).toBeGreaterThan(5400 - 30);
    expect(waitS).toBeLessThanOrEqual(5400);
    expect(await storedReviews(userId)).toEqual([]);
    expect(await latestReview(userId, NOW)).toEqual({
      state: "retrying",
      resumesAt: successor?.startAfter.toISOString(),
    });
    expect(coach.runs).toHaveLength(1);
  });

  it("defers on the last attempt too, instead of storing the fallback card (Claude quota)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 900 } });
    const userId = await ownerOnPlan();

    const outcome = await reviewJob.handle(
      getBoss(),
      runningJob(userId, reviewJob.jobOptions.retryLimit),
      () => NOW,
    );

    expect(outcome).toMatchObject({ status: "deferred", retryAfterSeconds: 900 });
    expect(await weekJobs(userId)).toMatchObject([{ state: "created", retryCount: 0 }]);
    expect(await storedReviews(userId)).toEqual([]);
  });
});
