import { ErrorCode } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { coachMessage, user } from "../../src/db/schema";
import { config } from "../../src/lib/config";
import { analyzeRun } from "../../src/services/insights";
import {
  configureCoachService,
  PLAN_OWNER_EMAIL,
  PLAN_USAGE,
  startFakeCoachService,
  VALID_OUTPUT,
} from "../fake-coach-service";
import { claudeKey, claudeRequests, createLongRun, createUser, setSettings } from "../seed";

// analyzeRun, the analyze-run job's work, on the owner's Claude plan through a fake coach service. The
// key path is in run-insight.test.ts; the job's deferral and retries in test/jobs/analyze-run.test.ts.

const coach = await startFakeCoachService();
let restore: () => void = () => undefined;

beforeEach(() => {
  coach.reset();
  restore = configureCoachService(coach);
});

afterEach(() => {
  restore();
});

afterAll(async () => {
  await coach.close();
});

/** A user who chose the plan, the owner unless another email is given, and their 18 km run. */
async function onPlan({
  email = PLAN_OWNER_EMAIL,
  key,
  units,
}: { email?: string; key?: string; units?: "km" | "mi" } = {}) {
  const userId = await createUser(email);
  await setSettings(userId, {
    coachCredential: "plan",
    ...(key ? { claudeKey: key } : {}),
    ...(units ? { units } : {}),
  });
  const run = await createLongRun(userId);
  return { userId, run };
}

async function cards() {
  return db.select().from(coachMessage);
}

describe("analyzeRun on the Claude plan", () => {
  it("stores the model's card from the plan for the owner who chose it, without a saved key", async () => {
    const { userId, run } = await onPlan();

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: false });

    const [card] = await cards();
    expect(outcome).toEqual({ status: "stored", coachMessageId: card?.id, fallbackReason: null });
    expect(card).toMatchObject({
      kind: "insight",
      activityId: run.id,
      promptVersion: "run-insight/v1",
      model: config.COACH_MODEL,
      content: VALID_OUTPUT,
      usage: PLAN_USAGE,
      fallbackReason: null,
    });
    expect(coach.runs).toHaveLength(1);
  });

  it("uses the plan and never sends the saved key when the owner chose the plan and also saved a key", async () => {
    const key = claudeKey("valid");
    const { userId, run } = await onPlan({ key });

    await analyzeRun(userId, run.id, { lastAttempt: false });

    expect(await claudeRequests(key)).toEqual([]);
    expect(coach.runs).toHaveLength(1);
    expect(JSON.stringify(coach.runs)).not.toContain(key);
  });

  it("sends the run in the user's units and no key, token or email (unit conversion)", async () => {
    const { userId, run } = await onPlan({ units: "mi" });
    const [owner] = await db.select().from(user).where(eq(user.id, userId));

    await analyzeRun(userId, run.id, { lastAttempt: false });

    const sent = JSON.stringify(coach.runs[0]?.body);
    expect(String(coach.runs[0]?.body.input)).toContain("11.2 mi");
    expect(sent).not.toContain(owner?.email);
    expect(sent).not.toMatch(/fixture-token|di_token|v1:|sk-ant/);
  });

  it("stores the plan_auth_failed card at once, on the first attempt, when Claude rejects the plan token (token expiry)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_auth_failed" } });
    const { userId, run } = await onPlan();

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: false });

    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "plan_auth_failed" });
    const [card] = await cards();
    expect(card).toMatchObject({ model: null, usage: null, fallbackReason: "plan_auth_failed" });
    expect((card?.content as { whatItMeans: string }).whatItMeans).toContain("claude setup-token");
    expect(coach.runs).toHaveLength(1);
  });

  it.each([false, true])(
    "throws claude_plan_limited with the seconds to the reset and stores nothing (last attempt: %s) (Claude quota)",
    async (lastAttempt) => {
      coach.use({ run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 5400 } });
      const { userId, run } = await onPlan();

      await expect(analyzeRun(userId, run.id, { lastAttempt })).rejects.toMatchObject({
        code: ErrorCode.claudePlanLimited,
        status: 429,
        retryAfterSeconds: 5400,
      });
      expect(await cards()).toEqual([]);
    },
  );

  it("throws claude_unavailable before the last attempt and stores the unavailable card on the last when the service never wakes (outage)", async () => {
    restore();
    restore = configureCoachService(coach, { COACH_SERVICE_WAKE_MS: 300 });
    coach.use({ wake: { kind: "never" } });
    const { userId, run } = await onPlan();

    await expect(analyzeRun(userId, run.id, { lastAttempt: false })).rejects.toMatchObject({
      code: ErrorCode.claudeUnavailable,
    });
    expect(await cards()).toEqual([]);

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: true });

    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "unavailable" });
    expect(coach.runs).toEqual([]);
  });

  it("stores the invalid_output card at once when the plan's output fails the schema", async () => {
    coach.use({ run: { kind: "schema-invalid" } });
    const { userId, run } = await onPlan();

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: false });

    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "invalid_output" });
    expect(await cards()).toMatchObject([
      { model: null, usage: PLAN_USAGE, fallbackReason: "invalid_output" },
    ]);
  });

  it("falls back to the saved key when the plan is chosen but the coach service is no longer set up (env removed)", async () => {
    restore();
    restore = configureCoachService(coach, { COACH_SERVICE_SECRET: undefined });
    const key = claudeKey("valid");
    const { userId, run } = await onPlan({ key });

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: false });

    expect(outcome).toMatchObject({ status: "stored", fallbackReason: null });
    expect(await claudeRequests(key)).toHaveLength(1);
    expect(coach.runs).toEqual([]);
  });

  it("makes no call for a user who is not the owner, chose the plan and has no key", async () => {
    const { userId, run } = await onPlan({ email: "other@example.com" });

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: true });

    expect(outcome).toEqual({ status: "skipped", reason: "no_key" });
    expect(coach.healthChecks).toEqual([]);
    expect(await cards()).toEqual([]);
  });
});
