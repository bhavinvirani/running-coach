import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ErrorCode } from "@running-coach/shared";
import type { Job, JobWithMetadata } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { coachMessage } from "../../src/db/schema";
import { enqueueAnalyzeRun, startJobs, stopJobs } from "../../src/jobs";
import * as analyzeRunJob from "../../src/jobs/analyze-run";
import { getBoss } from "../../src/jobs/boss";
import { COACH_CALL_BUDGET_MS, config } from "../../src/lib/config";
import { askCoach, getInsight } from "../../src/services/insights";
import {
  configureCoachService,
  PLAN_OWNER_EMAIL,
  startFakeCoachService,
} from "../fake-coach-service";
import { claudeKey, claudeRequests, createLongRun, createUser, setSettings } from "../seed";

// The analyze-run job on pg-boss with every worker running, against the fake Claude, and against a fake
// coach service for the owner's Claude plan. Retries wait minutes, so a test that needs the last attempt
// calls `handle` with the retry count pg-boss would give it.

const coach = await startFakeCoachService();

beforeAll(async () => {
  await startJobs({ pollingIntervalSeconds: 0.5 });
});

afterAll(async () => {
  await stopJobs();
  await coach.close();
});

async function runWithKey(fixture: string | null) {
  const userId = await createUser();
  const key = fixture ? claudeKey(fixture) : undefined;
  if (key) await setSettings(userId, { claudeKey: key });
  const run = await createLongRun(userId);
  return { userId, key, run };
}

async function runJobs(activityId: string): Promise<JobWithMetadata[]> {
  const jobs = await getBoss().findJobs<object>(analyzeRunJob.name, { key: activityId });
  return jobs.sort((a, b) => a.createdOn.getTime() - b.createdOn.getTime());
}

async function waitForJobState(
  id: string | null,
  states: JobWithMetadata["state"][],
): Promise<JobWithMetadata> {
  if (!id) throw new Error("no job id");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [job] = await getBoss().findJobs<object>(analyzeRunJob.name, { id });
    if (job && states.includes(job.state)) return job;
    await sleep(100);
  }
  throw new Error(`job ${id} did not reach ${states.join(" or ")}`);
}

/** A job as the worker hands it to the handler, on the given attempt. */
function runningJob(
  userId: string,
  activityId: string,
  retryCount: number,
): Job<unknown> & {
  retryLimit: number;
} {
  return {
    id: randomUUID(),
    name: analyzeRunJob.name,
    data: { userId, activityId },
    signal: new AbortController().signal,
    expireInSeconds: analyzeRunJob.jobOptions.expireInSeconds,
    heartbeatSeconds: null,
    retryCount,
    retryLimit: analyzeRunJob.jobOptions.retryLimit,
  };
}

describe("analyze-run job", () => {
  it("expires a job only a minute after the longest coach call boot allows, so pg-boss never runs it again mid-call (wake plus Claude Code's start-up inside the timeout)", () => {
    expect(analyzeRunJob.jobOptions.expireInSeconds).toBe(600);
    expect(analyzeRunJob.jobOptions.expireInSeconds * 1000).toBe(COACH_CALL_BUDGET_MS + 60_000);
    expect(config.COACH_SERVICE_WAKE_MS + config.COACH_SERVICE_TIMEOUT_MS).toBeLessThanOrEqual(
      COACH_CALL_BUDGET_MS,
    );
    expect(2 * config.CLAUDE_TIMEOUT_MS).toBeLessThanOrEqual(COACH_CALL_BUDGET_MS);
  });

  it("stores the coach's card for the run and completes", async () => {
    const { userId, run } = await runWithKey("valid");

    const job = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
      "failed",
    ]);

    expect(job.state).toBe("completed");
    const cards = await db.select().from(coachMessage);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      activityId: run.id,
      promptVersion: "run-insight/v1",
      model: config.COACH_MODEL,
      usage: { inputTokens: 1180, outputTokens: 164 },
    });
    expect(job.output).toEqual({
      status: "stored",
      coachMessageId: cards[0]?.id,
      fallbackReason: null,
    });
    expect(await getInsight(userId, run.id)).toMatchObject({ state: "ready" });
  });

  it("makes one Claude call and one card when the run is queued twice, and again after it ran (a job firing twice)", async () => {
    const { userId, key, run } = await runWithKey("valid");

    const first = await enqueueAnalyzeRun({ userId, activityId: run.id });
    const second = await enqueueAnalyzeRun({ userId, activityId: run.id });
    await waitForJobState(first, ["completed"]);
    if (second) await waitForJobState(second, ["completed"]);
    const third = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
    ]);

    expect(third.output).toEqual({ status: "skipped", reason: "has_card" });
    expect(await claudeRequests(key!)).toHaveLength(1);
    expect(await db.select().from(coachMessage)).toHaveLength(1);
  });

  it("retries a Claude quota error later with backoff, storing nothing, while the run reads retrying (Claude quota or timeout)", async () => {
    const { userId, run } = await runWithKey("rate-limited");

    const id = await enqueueAnalyzeRun({ userId, activityId: run.id });
    const job = await waitForJobState(id, ["retry", "failed"]);

    expect(job).toMatchObject({ state: "retry", retryLimit: 4, retryBackoff: true });
    // The first retry waits between retryDelay and twice it.
    const waitS = (job.startAfter.getTime() - Date.now()) / 1000;
    expect(waitS).toBeGreaterThan(analyzeRunJob.jobOptions.retryDelay - 10);
    expect(waitS).toBeLessThanOrEqual(analyzeRunJob.jobOptions.retryDelay * 2);
    expect(await db.select().from(coachMessage)).toEqual([]);
    expect(await getInsight(userId, run.id)).toEqual({ state: "retrying" });
  });

  it("throws on a timeout before the last attempt, then stores the timeout card on the last (Claude quota or timeout)", async () => {
    const { userId, run } = await runWithKey("timeout");

    await expect(
      analyzeRunJob.handle(getBoss(), runningJob(userId, run.id, 3)),
    ).rejects.toMatchObject({
      code: ErrorCode.claudeUnavailable,
    });
    expect(await db.select().from(coachMessage)).toEqual([]);

    const outcome = await analyzeRunJob.handle(getBoss(), runningJob(userId, run.id, 4));

    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "timeout" });
    const cards = await db.select().from(coachMessage);
    expect(cards).toMatchObject([{ model: null, fallbackReason: "timeout" }]);
    expect(await getInsight(userId, run.id)).toMatchObject({
      state: "ready",
      insight: { fallbackReason: "timeout" },
    });
  });

  it("stores the fallback card at once on a refusal, without a retry (refusal)", async () => {
    const { userId, run } = await runWithKey("refusal");

    const job = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
      "retry",
      "failed",
    ]);

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(await db.select().from(coachMessage)).toMatchObject([
      { model: null, fallbackReason: "refusal" },
    ]);
  });

  it("stores the request_rejected card on the first attempt, without a retry and with one Claude call, when Claude turns the request down (Claude quota or timeout)", async () => {
    const { userId, key, run } = await runWithKey("request-rejected");

    const job = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
      "retry",
      "failed",
    ]);

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(job.output).toMatchObject({ status: "stored", fallbackReason: "request_rejected" });
    expect(await claudeRequests(key!)).toHaveLength(1);
    expect(await db.select().from(coachMessage)).toMatchObject([
      { model: null, fallbackReason: "request_rejected" },
    ]);
    expect(await getInsight(userId, run.id)).toMatchObject({
      state: "ready",
      insight: { fallbackReason: "request_rejected" },
    });
  });

  it("completes and stores nothing when the key was removed after the run was queued", async () => {
    const { userId, key, run } = await runWithKey("valid");
    await setSettings(userId, { claudeKeyEnc: null });

    const job = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
      "failed",
    ]);

    expect(job.output).toEqual({ status: "skipped", reason: "no_key" });
    expect(await claudeRequests(key!)).toEqual([]);
    expect(await db.select().from(coachMessage)).toEqual([]);
    expect(await getInsight(userId, run.id)).toEqual({ state: "no_key" });
  });

  it("queues with the run as singleton key and no job id, so Try again can queue after a finished job", async () => {
    const { userId, run } = await runWithKey("key-invalid");
    const first = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
    ]);

    const second = await enqueueAnalyzeRun({ userId, activityId: run.id });

    expect(second).not.toBeNull();
    expect(second).not.toBe(first.id);
    await waitForJobState(second, ["completed"]);
    expect((await runJobs(run.id)).map((job) => job.singletonKey)).toEqual([run.id, run.id]);
  });
});

describe("analyze-run job on the Claude plan", () => {
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
    const run = await createLongRun(userId);
    return { userId, run };
  }

  it("stores the model's card from the plan and completes", async () => {
    const { userId, run } = await ownerOnPlan();

    const job = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
      "failed",
    ]);

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(await db.select().from(coachMessage)).toMatchObject([
      { activityId: run.id, model: config.COACH_MODEL, fallbackReason: null },
    ]);
    expect(coach.runs).toHaveLength(1);
  });

  it("defers the job to the plan's reset without a failed attempt, while the run reads retrying (Claude quota)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 5400 } });
    const { userId, run } = await ownerOnPlan();

    const first = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
      "retry",
      "failed",
    ]);

    expect(first).toMatchObject({ state: "completed", retryCount: 0 });
    const output = first.output as { status: string; rescheduledJobIds: string[] };
    expect(output).toMatchObject({ status: "deferred", retryAfterSeconds: 5400 });
    const successor = (await runJobs(run.id)).find((job) => job.id !== first.id);
    expect(output.rescheduledJobIds).toEqual([successor?.id]);
    expect(successor).toMatchObject({ state: "created", retryCount: 0, singletonKey: run.id });
    const waitS = ((successor?.startAfter.getTime() ?? 0) - Date.now()) / 1000;
    expect(waitS).toBeGreaterThan(5400 - 30);
    expect(waitS).toBeLessThanOrEqual(5400);
    expect(await db.select().from(coachMessage)).toEqual([]);
    expect(await getInsight(userId, run.id)).toEqual({
      state: "retrying",
      resumesAt: successor?.startAfter.toISOString(),
    });
    expect(coach.runs).toHaveLength(1);
  });

  it("runs a run deferred to the plan's reset on the API key once the owner switched Settings and tapped Try again (Claude quota)", async () => {
    coach.use({
      run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 6 * 24 * 3600 },
    });
    const { userId, run } = await ownerOnPlan();
    const first = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
      "retry",
      "failed",
    ]);
    const [held] = (await runJobs(run.id)).filter((job) => job.id !== first.id);
    expect(await getInsight(userId, run.id)).toMatchObject({
      state: "retrying",
      resumesAt: held?.startAfter.toISOString(),
    });
    const key = claudeKey("valid");
    await setSettings(userId, { claudeKey: key, coachCredential: "key" });

    expect(await askCoach(userId, run.id)).toEqual({ state: "pending" });

    const job = await waitForJobState(held?.id ?? null, ["completed", "retry", "failed"]);
    expect(job).toMatchObject({ state: "completed", output: { status: "stored" } });
    expect(await db.select().from(coachMessage)).toMatchObject([
      { activityId: run.id, model: config.COACH_MODEL, fallbackReason: null },
    ]);
    expect(await claudeRequests(key)).toHaveLength(1);
    expect(coach.runs).toHaveLength(1);
  });

  it("defers on the last attempt too, instead of storing the fallback card (Claude quota)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 900 } });
    const { userId, run } = await ownerOnPlan();

    const outcome = await analyzeRunJob.handle(
      getBoss(),
      runningJob(userId, run.id, analyzeRunJob.jobOptions.retryLimit),
    );

    expect(outcome).toMatchObject({ status: "deferred", retryAfterSeconds: 900 });
    const [successor] = await runJobs(run.id);
    expect(successor).toMatchObject({ state: "created", retryCount: 0 });
    expect(await db.select().from(coachMessage)).toEqual([]);
    expect(await getInsight(userId, run.id)).toEqual({
      state: "retrying",
      resumesAt: successor?.startAfter.toISOString(),
    });
  });

  it("stores the plan_auth_failed card at once, without a retry (token expiry)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_auth_failed" } });
    const { userId, run } = await ownerOnPlan();

    const job = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "completed",
      "retry",
      "failed",
    ]);

    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    expect(await getInsight(userId, run.id)).toMatchObject({
      state: "ready",
      insight: { fallbackReason: "plan_auth_failed" },
    });
  });

  it("retries later with backoff when the coach service fails, as on a key, while the run reads retrying (outage)", async () => {
    coach.use({ run: { kind: "error", status: 500 } });
    const { userId, run } = await ownerOnPlan();

    const job = await waitForJobState(await enqueueAnalyzeRun({ userId, activityId: run.id }), [
      "retry",
      "failed",
    ]);

    expect(job).toMatchObject({ state: "retry", retryLimit: 4, retryBackoff: true });
    expect(await db.select().from(coachMessage)).toEqual([]);
    expect(await getInsight(userId, run.id)).toEqual({ state: "retrying" });
  });
});
