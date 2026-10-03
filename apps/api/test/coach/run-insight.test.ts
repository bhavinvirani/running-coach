import { readFileSync } from "node:fs";
import path from "node:path";
import { ErrorCode } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInsight } from "../../src/coach/run-insight";
import { db } from "../../src/db/client";
import { activity, coachMessage, user } from "../../src/db/schema";
import { config } from "../../src/lib/config";
import { analyzeRun } from "../../src/services/insights";
import {
  claudeKey,
  claudeRequests,
  createLongRun,
  createPlan,
  createRun,
  createSession,
  createUser,
  setSettings,
  TEMPO_STEPS,
} from "../seed";

// The coach end to end against the fake Claude (global-setup.ts): the key names the fixture it replays.
// analyzeRun is the analyze-run job's work; the job's retries are in test/jobs/analyze-run.test.ts.

const validFixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../fixtures/claude/valid.json"), "utf8"),
) as { responses: [{ body: { content: [{ json: unknown }] } }] };
const validOutput = validFixture.responses[0].body.content[0].json;

async function userWithKey(fixture: string | null, settings: { units?: "km" | "mi" } = {}) {
  const userId = await createUser();
  const key = fixture ? claudeKey(fixture) : undefined;
  const changes = { ...settings, ...(key ? { claudeKey: key } : {}) };
  if (Object.keys(changes).length > 0) await setSettings(userId, changes);
  return { userId, key };
}

async function analyze(
  fixture: string | null,
  { lastAttempt = false, units }: { lastAttempt?: boolean; units?: "km" | "mi" } = {},
) {
  const { userId, key } = await userWithKey(fixture, units ? { units } : {});
  const run = await createLongRun(userId);
  const outcome = await analyzeRun(userId, run.id, { lastAttempt });
  return { userId, key, run, outcome, requests: key ? await claudeRequests(key) : [] };
}

async function cards() {
  return db.select().from(coachMessage);
}

async function onlyCard() {
  const rows = await cards();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** The user message the fake Claude received in the key's first request. */
async function sentMessage(key: string): Promise<string> {
  const [request] = await claudeRequests(key);
  const messages = request?.body.messages as { content: string }[] | undefined;
  return messages?.[0]?.content ?? "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Noon UTC on the plan tests' run day, Wednesday 7 October 2026: today is the run's date. */
const RUN_DAY_NOON = new Date("2026-10-07T12:00:00Z");

describe("analyzeRun", () => {
  it("stores the coach's card with prompt_version, model and usage", async () => {
    const { outcome, run, requests } = await analyze("valid");

    const card = await onlyCard();
    expect(outcome).toEqual({ status: "stored", coachMessageId: card.id, fallbackReason: null });
    expect(card).toMatchObject({
      kind: "insight",
      activityId: run.id,
      promptVersion: "run-insight/v1",
      model: config.COACH_MODEL,
      content: validOutput,
      usage: { inputTokens: 1180, outputTokens: 164 },
      fallbackReason: null,
      feedback: null,
    });

    expect(requests).toHaveLength(1);
    const body = requests[0]?.body;
    expect(body).toMatchObject({
      model: config.COACH_MODEL,
      max_tokens: 4096,
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(String(body?.system)).toContain("# Voice");
    expect(String(body?.system)).toContain("# Safety");
  });

  it("sends numbers in the user's units and no key, token or email (unit conversion)", async () => {
    const { key, userId } = await analyze("valid", { units: "mi" });
    const [owner] = await db.select().from(user).where(eq(user.id, userId));

    const sent = JSON.stringify((await claudeRequests(key!))[0]?.body);
    expect(sent).toContain("11.2 mi");
    expect(sent).not.toContain(key);
    expect(sent).not.toContain(owner?.email);
    expect(sent).not.toMatch(/fixture-token|di_token|v1:/);
  });

  it.each([
    ["max-tokens", "max_tokens"],
    ["refusal", "refusal"],
    ["invalid-json", "invalid_output"],
    ["schema-invalid", "invalid_output"],
  ] as const)(
    "stores the fallback card at once, with the billed usage, when the answer is %s (refusal, max_tokens)",
    async (fixture, reason) => {
      const { outcome, requests } = await analyze(fixture, { lastAttempt: false });

      const card = await onlyCard();
      expect(outcome).toMatchObject({ status: "stored", fallbackReason: reason });
      expect(card).toMatchObject({ model: null, fallbackReason: reason });
      expect(card.usage).toMatchObject({ inputTokens: 1180 });
      expect(card.content).toMatchObject({
        headline: "18.0 km in 1:42:00 at 5:40 /km.",
        caution: "none",
      });
      expect(requests).toHaveLength(1);
    },
  );

  it("stores the replace-key card at once, without retrying, when Claude rejects the key (invalid or expired key)", async () => {
    const { outcome, requests } = await analyze("key-invalid", { lastAttempt: false });

    expect(requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "key_invalid" });
    const card = await onlyCard();
    expect(card).toMatchObject({ model: null, usage: null, fallbackReason: "key_invalid" });
    expect((card.content as { whatItMeans: string }).whatItMeans).toContain(
      "Replace it in Settings",
    );
  });

  it("stores the request_rejected card on the first attempt with one Claude call, without throwing, when Claude turns the request down for lack of credit (Claude quota or timeout)", async () => {
    const { outcome, requests } = await analyze("request-rejected", { lastAttempt: false });

    expect(requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "request_rejected" });
    const card = await onlyCard();
    expect(card).toMatchObject({ model: null, usage: null, fallbackReason: "request_rejected" });
    expect((card.content as { whatItMeans: string }).whatItMeans).toContain(
      "Check billing in the Claude Console, then tap Try again.",
    );
  });

  it.each([
    [400, "invalid_request_error", "request_rejected", 1],
    [404, "not_found_error", "request_rejected", 1],
    [413, "request_too_large", "request_rejected", 1],
    [408, "timeout_error", "unavailable", 2],
    [409, "conflict_error", "unavailable", 2],
  ] as const)(
    "turns a %i from Claude into %s and retries only a transient status, on the fallback model",
    async (status, type, reason, calls) => {
      const { userId } = await userWithKey("valid");
      const run = await createLongRun(userId);
      const claude = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ type: "error", error: { type, message: "refused" } }), {
            status,
            headers: { "content-type": "application/json", "request-id": "req_fake_status" },
          }),
        ),
      );

      const outcome = await analyzeRun(userId, run.id, { lastAttempt: true });

      expect(outcome).toMatchObject({ status: "stored", fallbackReason: reason });
      expect(claude).toHaveBeenCalledTimes(calls);
      expect(await onlyCard()).toMatchObject({ model: null, fallbackReason: reason });
    },
  );

  it.each([
    ["timeout", 1],
    ["unavailable", 2],
    ["rate-limited", 2],
  ] as const)(
    "throws claude_unavailable and stores nothing on a %s before the last attempt, so the job retries (Claude quota or timeout)",
    async (fixture, calls) => {
      const { userId, key } = await userWithKey(fixture);
      const run = await createLongRun(userId);

      await expect(analyzeRun(userId, run.id, { lastAttempt: false })).rejects.toMatchObject({
        code: ErrorCode.claudeUnavailable,
        status: 502,
      });

      expect(await cards()).toEqual([]);
      // callCoach's one retry on the fallback model, never on a timeout.
      expect(await claudeRequests(key!)).toHaveLength(calls);
    },
  );

  it.each([
    ["timeout", "timeout"],
    ["unavailable", "unavailable"],
    ["rate-limited", "unavailable"],
  ] as const)(
    "stores the fallback card with its reason on a %s at the last attempt",
    async (fixture, reason) => {
      const { outcome } = await analyze(fixture, { lastAttempt: true });

      expect(outcome).toMatchObject({ status: "stored", fallbackReason: reason });
      const card = await onlyCard();
      expect(card).toMatchObject({ model: null, usage: null, fallbackReason: reason });
    },
  );

  it("retries an overloaded call once, on the fallback model", async () => {
    const { requests } = await analyze("overloaded");

    expect(requests.map((request) => request.body.model)).toEqual([
      config.COACH_MODEL,
      config.COACH_FALLBACK_MODEL,
    ]);
    expect(await onlyCard()).toMatchObject({
      model: config.COACH_FALLBACK_MODEL,
      content: validOutput,
    });
  });

  it("throws claude_unavailable and stores nothing when the fallback model is missing (404) after an overloaded primary, so the job retries instead of storing the billing card", async () => {
    const { userId, key } = await userWithKey("fallback-model-missing");
    const run = await createLongRun(userId);

    await expect(analyzeRun(userId, run.id, { lastAttempt: false })).rejects.toMatchObject({
      code: ErrorCode.claudeUnavailable,
      status: 502,
    });

    expect(await cards()).toEqual([]);
    expect((await claudeRequests(key!)).map((request) => request.body.model)).toEqual([
      config.COACH_MODEL,
      config.COACH_FALLBACK_MODEL,
    ]);
  });

  it("stores the unavailable card, not request_rejected, at the last attempt when the fallback model is missing after an overloaded primary", async () => {
    const { outcome } = await analyze("fallback-model-missing", { lastAttempt: true });

    expect(outcome).toMatchObject({ status: "stored", fallbackReason: "unavailable" });
    expect(await onlyCard()).toMatchObject({
      model: null,
      usage: null,
      fallbackReason: "unavailable",
    });
  });

  it("makes no call and stores nothing when the key was removed after the job was queued", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const userId = await createUser();
    const run = await createLongRun(userId);

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: true });

    expect(outcome).toEqual({ status: "skipped", reason: "no_key" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await cards()).toEqual([]);
  });

  it("does nothing for a run that is gone or belongs to another user", async () => {
    const { userId, key } = await userWithKey("valid");
    const otherId = await createUser("other@example.com");
    const othersRun = await createLongRun(otherId);

    expect(await analyzeRun(userId, othersRun.id, { lastAttempt: false })).toEqual({
      status: "skipped",
      reason: "run_missing",
    });
    expect(await cards()).toEqual([]);
    expect(await claudeRequests(key!)).toEqual([]);
  });

  it("makes no second call when the coach's card exists (a job firing twice, duplicate run)", async () => {
    const { userId, key } = await userWithKey("valid");
    const run = await createLongRun(userId);
    await analyzeRun(userId, run.id, { lastAttempt: false });
    const first = await onlyCard();

    const again = await analyzeRun(userId, run.id, { lastAttempt: false });

    expect(again).toEqual({ status: "skipped", reason: "has_card" });
    expect(await claudeRequests(key!)).toHaveLength(1);
    expect(await onlyCard()).toEqual(first);
  });

  it("replaces a fallback card with the coach's card and clears its thumbs (Try again after a key fix)", async () => {
    const userId = await createUser();
    await setSettings(userId, { claudeKey: claudeKey("key-invalid") });
    const run = await createLongRun(userId);
    await analyzeRun(userId, run.id, { lastAttempt: false });
    const fallback = await onlyCard();
    await db.update(coachMessage).set({ feedback: "down" }).where(eq(coachMessage.id, fallback.id));
    await setSettings(userId, { claudeKey: claudeKey("valid") });

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: false });

    const card = await onlyCard();
    expect(outcome).toEqual({
      status: "stored",
      coachMessageId: fallback.id,
      fallbackReason: null,
    });
    expect(card).toMatchObject({
      id: fallback.id,
      model: config.COACH_MODEL,
      content: validOutput,
      fallbackReason: null,
      feedback: null,
    });
    expect(card.createdAt.getTime()).toBeGreaterThanOrEqual(fallback.createdAt.getTime());
  });

  it("keeps the coach's card when another job stored it while Claude answered with a refusal (a job firing twice)", async () => {
    const userId = await createUser();
    await setSettings(userId, { claudeKey: claudeKey("refusal") });
    const run = await createLongRun(userId);
    const passThrough = globalThis.fetch;
    // The other job's card lands after this one checked for a card and before it stores its own.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      await db.insert(coachMessage).values({
        userId,
        kind: "insight",
        activityId: run.id,
        promptVersion: "run-insight/v1",
        model: config.COACH_MODEL,
        content: validOutput,
      });
      return passThrough(input, init);
    });

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: false });

    expect(outcome).toEqual({ status: "skipped", reason: "has_card" });
    expect(await onlyCard()).toMatchObject({
      model: config.COACH_MODEL,
      content: validOutput,
      fallbackReason: null,
    });
  });

  it("stores nothing when the run is deleted while Claude answers (a run deleted on Garmin)", async () => {
    const userId = await createUser();
    await setSettings(userId, { claudeKey: claudeKey("valid") });
    const run = await createLongRun(userId);
    const passThrough = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      await db.delete(activity).where(eq(activity.id, run.id));
      return passThrough(input, init);
    });

    const outcome = await analyzeRun(userId, run.id, { lastAttempt: false });

    expect(outcome).toEqual({ status: "skipped", reason: "run_missing" });
    expect(await cards()).toEqual([]);
  });

  it("tells the coach about no plan when the user has none", async () => {
    const { userId, key } = await userWithKey("valid");
    const run = await createLongRun(userId);

    await analyzeRun(userId, run.id, { lastAttempt: false });

    expect(await sentMessage(key!)).toContain("Plan: none");
  });

  it("sends the session planned on the run's local date, not its UTC date, and the next one (time zones)", async () => {
    const { userId, key } = await userWithKey("valid");
    await setSettings(userId, { timezone: "America/Los_Angeles" });
    const active = await createPlan(userId);
    // 23:30 on Wednesday in Los Angeles is 06:30 on Thursday in UTC.
    const run = await createRun(userId, {
      startUtc: new Date("2026-10-08T06:30:00Z"),
      startLocal: "2026-10-07 23:30:00",
      tz: "America/Los_Angeles",
    });
    await createSession(userId, active.id, {
      date: "2026-10-07",
      type: "tempo",
      steps: TEMPO_STEPS,
    });
    await createSession(userId, active.id, { date: "2026-10-08", type: "long" });

    await analyzeRun(userId, run.id, { lastAttempt: false, now: RUN_DAY_NOON });

    const message = await sentMessage(key!);
    expect(message).toMatch(/^Planned that day: Tempo \(tempo\)[^;\n]*$/m);
    expect(message).toMatch(/^Next planned session: Thursday 8 October 2026, Long run \(long\)/m);
  });

  it("takes the day's plan sessions and custom workouts, not skipped or old-plan ones, and the next planned or moved session", async () => {
    const { userId, key } = await userWithKey("valid");
    const superseded = await createPlan(userId, { status: "superseded" });
    const active = await createPlan(userId, { version: 2 });
    const run = await createRun(userId, {
      startUtc: new Date("2026-10-07T06:00:00Z"),
      startLocal: "2026-10-07 08:00:00",
    });
    await createSession(userId, null, { date: "2026-10-07", title: "Hill sprints" });
    await createSession(userId, active.id, {
      date: "2026-10-07",
      type: "tempo",
      steps: TEMPO_STEPS,
    });
    await createSession(userId, active.id, { date: "2026-10-07", status: "skipped" });
    await createSession(userId, superseded.id, { date: "2026-10-07", type: "long" });
    await createSession(userId, active.id, { date: "2026-10-08", status: "skipped" });
    await createSession(userId, superseded.id, { date: "2026-10-08", type: "long" });
    await createSession(userId, active.id, {
      date: "2026-10-09",
      type: "intervals",
      status: "moved",
    });

    await analyzeRun(userId, run.id, { lastAttempt: false, now: RUN_DAY_NOON });

    const message = await sentMessage(key!);
    expect(message).toMatch(
      /^Planned that day: Tempo \(tempo\), [^;\n]+; Hill sprints \(easy\)[^;\n]*$/m,
    );
    expect(message).toMatch(
      /^Next planned session: Friday 9 October 2026, Intervals \(intervals\)/m,
    );
  });

  it("names nothing planned that day when the active plan has no session on the run's date", async () => {
    const { userId, key } = await userWithKey("valid");
    await createPlan(userId);
    const run = await createRun(userId, {
      startUtc: new Date("2026-10-07T06:00:00Z"),
      startLocal: "2026-10-07 08:00:00",
    });

    await analyzeRun(userId, run.id, { lastAttempt: false, now: RUN_DAY_NOON });

    const message = await sentMessage(key!);
    expect(message).toContain("Planned that day: nothing");
    expect(message).toContain("Next planned session: none");
  });

  it("names the next session from the user's today, not a past session still marked planned (missed or moved sessions, time zones)", async () => {
    const { userId, key } = await userWithKey("valid");
    await setSettings(userId, { timezone: "Pacific/Auckland" });
    const active = await createPlan(userId);
    const run = await createRun(userId, {
      startUtc: new Date("2026-10-07T06:00:00Z"),
      startLocal: "2026-10-07 08:00:00",
    });
    await createSession(userId, active.id, { date: "2026-10-08", type: "tempo" });
    await createSession(userId, active.id, { date: "2026-10-09", type: "long" });
    await createSession(userId, active.id, { date: "2026-10-10", type: "intervals" });

    // 13:00 UTC on Friday 9 October is 02:00 on Saturday 10 October in Auckland (NZDT, UTC+13).
    await analyzeRun(userId, run.id, {
      lastAttempt: false,
      now: new Date("2026-10-09T13:00:00Z"),
    });

    expect(await sentMessage(key!)).toMatch(
      /^Next planned session: Saturday 10 October 2026, Intervals \(intervals\)/m,
    );
  });

  it("tells the coach Plan: none for a run from before the active plan started", async () => {
    const { userId, key } = await userWithKey("valid");
    const active = await createPlan(userId, { startDate: "2026-09-28" });
    const run = await createLongRun(userId);
    await createSession(userId, null, { date: "2026-09-27", title: "Hill sprints" });
    await createSession(userId, active.id, { date: "2026-09-29", type: "tempo" });

    await analyzeRun(userId, run.id, { lastAttempt: false, now: new Date("2026-09-27T12:00:00Z") });

    const message = await sentMessage(key!);
    expect(message).toContain("Plan: none");
    expect(message).not.toContain("Planned that day");
    expect(message).not.toContain("Next planned session");
  });
});

describe("runInsight", () => {
  it("makes no call and returns the missing_key fallback when the key is null", async () => {
    const result = await runInsight({
      apiKey: null,
      activity: await createLongRun(await createUser()),
      settings: { units: "km", coachDetail: "short" },
      plan: null,
    });

    expect(result).toMatchObject({
      fallback: true,
      fallbackReason: "missing_key",
      model: null,
      usage: null,
    });
  });
});
