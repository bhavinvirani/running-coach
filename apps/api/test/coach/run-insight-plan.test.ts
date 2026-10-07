import { ErrorCode } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { coachMessage, user } from "../../src/db/schema";
import { config } from "../../src/lib/config";
import { analyzeRun } from "../../src/services/insights";
import {
  CHANGE_OUTPUT,
  cardOf,
  configureCoachService,
  PLAN_OWNER_EMAIL,
  PLAN_USAGE,
  startFakeCoachService,
  VALID_CARD,
} from "../fake-coach-service";
import {
  claudeKey,
  claudeRequests,
  createLongRun,
  createPlan,
  createRunOn,
  createSession,
  createUser,
  setSettings,
  storedSession,
} from "../seed";
import { storedAdjustments } from "../seed-adaptation";

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
      promptVersion: "run-insight/v2",
      model: config.COACH_MODEL,
      content: VALID_CARD,
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

describe("the plan change on the Claude plan (run-insight v2)", () => {
  // Wednesday 2026-10-14 in UTC: this morning's run is the newest, an easy 8 km is planned Thursday.
  const NOW = new Date("2026-10-14T10:00:00Z");

  async function ownerWithPlan() {
    const userId = await createUser(PLAN_OWNER_EMAIL);
    await setSettings(userId, { coachCredential: "plan" });
    const active = await createPlan(userId);
    const run = await createRunOn(userId, "2026-10-14");
    const session = await createSession(userId, active.id, { date: "2026-10-15" });
    return { userId, run, session };
  }

  it("stores the plan's output with a change: the next session scaled in place, logged against the card, the card's next step the change's", async () => {
    coach.use({ run: { kind: "valid", fixture: "adjust-scale" } });
    const { userId, run, session } = await ownerWithPlan();

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: false, now: NOW });

    const [card] = await cards();
    expect(outcome).toEqual({ status: "stored", coachMessageId: card?.id, fallbackReason: null });
    expect(card).toMatchObject({
      promptVersion: "run-insight/v2",
      usage: PLAN_USAGE,
      content: { ...cardOf(CHANGE_OUTPUT), nextStep: CHANGE_OUTPUT.adjustment.nextStep },
    });
    expect((await storedSession(session.id)).target.distanceM).toBe(6400);
    expect(await storedAdjustments(userId)).toEqual([
      expect.objectContaining({
        source: "coach",
        kind: "scale",
        outcome: "applied",
        planSessionId: session.id,
        coachMessageId: card?.id,
      }),
    ]);
    expect(String(coach.runs[0]?.body.input)).toMatch(
      /^Plan change for the next session: allowed$/m,
    );
    expect(coach.runs[0]?.body.jsonSchema).toMatchObject({
      required: expect.arrayContaining(["adjustment"]) as unknown,
    });
  });

  it("stores the plan_auth_failed card and changes nothing when Claude rejects the plan token (token expiry)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_auth_failed" } });
    const { userId, run, session } = await ownerWithPlan();

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: false, now: NOW });

    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "plan_auth_failed" });
    expect(await storedSession(session.id)).toEqual(session);
    expect(await storedAdjustments(userId)).toEqual([]);
  });

  it("stores nothing and changes nothing while the plan's usage limit defers the run (Claude quota)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 5400 } });
    const { userId, run, session } = await ownerWithPlan();

    await expect(analyzeRun(userId, run.id, { lastAttempt: true, now: NOW })).rejects.toMatchObject(
      { code: ErrorCode.claudePlanLimited, retryAfterSeconds: 5400 },
    );

    expect(await cards()).toEqual([]);
    expect(await storedSession(session.id)).toEqual(session);
    expect(await storedAdjustments(userId)).toEqual([]);
  });
});
