import { createServer } from "node:net";
import type { CoachRunFailure } from "@running-coach/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callCoach, INSIGHT_MAX_TOKENS } from "../../src/coach/client";
import { PLAN_LIMIT_DEFAULT_RETRY_S } from "../../src/coach/plan-client";
import { runInsightSchema } from "../../src/coach/prompts/run-insight/schema";
import { config } from "../../src/lib/config";
import type * as loggerModule from "../../src/lib/logger";
import { withRequestId } from "../../src/lib/logger";
import {
  configureCoachService,
  FAKE_COACH_SECRET,
  PLAN_USAGE,
  startFakeCoachService,
  VALID_OUTPUT,
} from "../fake-coach-service";

// callCoach on the owner's Claude plan, against a fake coach service, with the coach module's logger
// replaced by spies: tests log at "silent", so what the plan path logs is only visible here.

const coachLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("../../src/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof loggerModule>();
  const logger = Object.create(actual.logger) as typeof actual.logger;
  logger.child = ((bindings: Record<string, unknown>) =>
    bindings.module === "coach" ? coachLog : actual.logger.child(bindings)) as typeof logger.child;
  return { ...actual, logger };
});

const coach = await startFakeCoachService();
let restore: () => void = () => undefined;

beforeEach(() => {
  coach.reset();
  restore = configureCoachService(coach);
  for (const spy of Object.values(coachLog)) spy.mockClear();
});

afterEach(() => {
  restore();
});

afterAll(async () => {
  await coach.close();
});

const INPUT = "Run: 5.0 km in 25:00 at 5:00 /km. Detail level: short";

function callPlan() {
  return callCoach({
    credential: { kind: "plan" },
    prompt: "run-insight",
    version: "v1",
    input: INPUT,
    schema: runInsightSchema,
    maxTokens: INSIGHT_MAX_TOKENS,
  });
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function logged(): string {
  return JSON.stringify([
    coachLog.info.mock.calls,
    coachLog.warn.mock.calls,
    coachLog.error.mock.calls,
  ]);
}

describe("callCoach on the Claude plan", () => {
  it("sends the system prompt, the input, a draft-07 JSON schema, both models and max tokens with the secret and request id, and never an API key", async () => {
    const result = await withRequestId("req-plan-test", callPlan);

    expect(result).toEqual({
      ok: true,
      output: VALID_OUTPUT,
      model: config.COACH_MODEL,
      usage: PLAN_USAGE,
      requestId: "req_plan_1",
    });
    expect(coach.runs).toHaveLength(1);
    const [run] = coach.runs;
    expect(run?.headers["x-coach-secret"]).toBe(FAKE_COACH_SECRET);
    expect(run?.headers["x-request-id"]).toBe("req-plan-test");
    expect(run?.headers).not.toHaveProperty("x-api-key");
    expect(run?.headers).not.toHaveProperty("authorization");
    expect(Object.keys(run?.body ?? {}).sort()).toEqual([
      "fallbackModel",
      "input",
      "jsonSchema",
      "maxTokens",
      "model",
      "system",
    ]);
    expect(run?.body).toMatchObject({
      input: INPUT,
      model: config.COACH_MODEL,
      fallbackModel: config.COACH_FALLBACK_MODEL,
      maxTokens: INSIGHT_MAX_TOKENS,
      jsonSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        required: ["headline", "whatHappened", "whatItMeans", "nextStep", "caution"],
        additionalProperties: false,
      },
    });
    expect(String(run?.body.system)).toContain("# Voice");
    expect(String(run?.body.system)).toContain("# Safety");
    expect(coach.healthChecks.map((headers) => headers["x-request-id"])).toEqual(["req-plan-test"]);
    expect(JSON.stringify(coach.runs)).not.toMatch(/sk-ant|test-valid|apiKey|v1:/);
  });

  it("names the fallback model as the card's model when Claude Code switched to it (overloaded)", async () => {
    coach.use({ run: { kind: "valid", by: "fallbackModel" } });

    expect(await callPlan()).toMatchObject({ ok: true, model: config.COACH_FALLBACK_MODEL });
  });

  it("wakes a booting service that answers 503 three times, then runs the call (cold start)", async () => {
    coach.use({ wake: { kind: "booting", failures: 3, status: 503 } });

    const result = await callPlan();

    expect(result).toMatchObject({ ok: true, output: VALID_OUTPUT });
    expect(coach.healthChecks).toHaveLength(4);
    expect(coach.runs).toHaveLength(1);
  });

  it("wakes a service that answers 502 while Render routes to a starting instance (cold start)", async () => {
    coach.use({ wake: { kind: "booting", failures: 2, status: 502 } });

    expect(await callPlan()).toMatchObject({ ok: true });
    expect(coach.healthChecks).toHaveLength(3);
  });

  it("waits out a /health that Render holds while the service starts, then runs the call (cold start)", async () => {
    coach.use({ wake: { kind: "held", holdMs: 600 } });

    const result = await callPlan();

    expect(result).toMatchObject({ ok: true });
    expect(coach.healthChecks).toHaveLength(1);
    const [fields] = coachLog.info.mock.calls.at(-1) as [Record<string, unknown>];
    expect(fields.wakeMs).toBeGreaterThanOrEqual(500);
  });

  it("answers unavailable without a run when the service never wakes within COACH_SERVICE_WAKE_MS (outage)", async () => {
    restore();
    restore = configureCoachService(coach, { COACH_SERVICE_WAKE_MS: 400 });
    coach.use({ wake: { kind: "never" } });

    const result = await callPlan();

    expect(result).toEqual({ ok: false, failure: "unavailable", usage: null, requestId: null });
    expect(coach.runs).toEqual([]);
    expect(coach.healthChecks.length).toBeGreaterThan(1);
    const warned = coachLog.warn.mock.calls.find(
      (call) => call[1] === "coach service did not wake",
    );
    expect((warned?.[0] as { wakeMs: number }).wakeMs).toBeGreaterThanOrEqual(400);
  });

  it("answers unavailable when nothing listens at COACH_SERVICE_URL (outage)", async () => {
    restore();
    restore = configureCoachService(
      { url: `http://127.0.0.1:${await closedPort()}`, secret: FAKE_COACH_SECRET },
      { COACH_SERVICE_WAKE_MS: 300 },
    );

    expect(await callPlan()).toEqual({
      ok: false,
      failure: "unavailable",
      usage: null,
      requestId: null,
    });
  });

  it("answers timeout after one try when the service takes longer than COACH_SERVICE_TIMEOUT_MS (Claude timeout)", async () => {
    restore();
    restore = configureCoachService(coach, { COACH_SERVICE_TIMEOUT_MS: 400 });
    coach.use({ run: { kind: "slow", delayMs: 2000 } });

    const result = await callPlan();

    expect(result).toEqual({ ok: false, failure: "timeout", usage: null, requestId: null });
    expect(coach.runs).toHaveLength(1);
  });

  it.each([
    ["refusal", true],
    ["max_tokens", true],
    ["invalid_output", true],
    ["timeout", false],
    ["unavailable", false],
    ["request_rejected", false],
    ["plan_auth_failed", false],
  ] as const)(
    "maps the service's %s to the same failure, with the billed usage when a model answered (refusal, max_tokens, token expiry)",
    async (failure: Exclude<CoachRunFailure, "plan_limited">, billed) => {
      coach.use({ run: { kind: "failure", failure, billed } });

      const result = await callPlan();

      expect(result).toEqual({
        ok: false,
        failure,
        usage: billed ? PLAN_USAGE : null,
        requestId: "req_plan_1",
      });
      expect(coach.runs).toHaveLength(1);
    },
  );

  it("logs a rejected plan token as an error that says to make a new one (token expiry)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_auth_failed" } });

    await callPlan();

    expect(coachLog.error).toHaveBeenCalledTimes(1);
    expect(String(coachLog.error.mock.calls[0]?.[1])).toContain("claude setup-token");
  });

  it("answers plan_limited with the seconds to the plan's reset (Claude quota)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_limited", retryAfterSeconds: 5400 } });

    expect(await callPlan()).toEqual({
      ok: false,
      failure: "plan_limited",
      retryAfterSeconds: 5400,
      usage: null,
      requestId: "req_plan_1",
    });
  });

  it("waits an hour for the plan's reset when the service names no time (Claude quota)", async () => {
    coach.use({ run: { kind: "failure", failure: "plan_limited" } });

    expect(await callPlan()).toMatchObject({
      failure: "plan_limited",
      retryAfterSeconds: PLAN_LIMIT_DEFAULT_RETRY_S,
    });
    expect(PLAN_LIMIT_DEFAULT_RETRY_S).toBe(3600);
  });

  it("answers invalid_output and logs the issue paths, never the text, when the output fails its schema", async () => {
    coach.use({ run: { kind: "schema-invalid" } });

    const result = await callPlan();

    expect(result).toEqual({
      ok: false,
      failure: "invalid_output",
      usage: PLAN_USAGE,
      requestId: "req_plan_1",
    });
    const warned = coachLog.warn.mock.calls.find(
      (call) => call[1] === "coach output failed its schema",
    );
    expect((warned?.[0] as { issues: string[] }).issues).toEqual(
      expect.arrayContaining(["whatHappened", "caution"]),
    );
    expect(logged()).not.toContain("Nice run");
  });

  it("answers unavailable and logs the secret mismatch, never either secret, when the service refuses x-coach-secret (401)", async () => {
    const wrongSecret = "test-only-a-different-coach-secret-9876543210";
    restore();
    restore = configureCoachService({ url: coach.url, secret: wrongSecret });

    const result = await callPlan();

    expect(result).toEqual({ ok: false, failure: "unavailable", usage: null, requestId: null });
    expect(coachLog.error).toHaveBeenCalledTimes(1);
    const [fields, message] = coachLog.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ status: 401, promptVersion: "run-insight/v1" });
    expect(message).toContain("COACH_SERVICE_SECRET");
    expect(logged()).not.toContain(wrongSecret);
    expect(logged()).not.toContain(FAKE_COACH_SECRET);
  });

  it.each([
    ["a 500 from the service", { kind: "error", status: 500 }],
    ["a 400 from the service", { kind: "error", status: 400 }],
    ["a dropped connection", { kind: "drop" }],
    ["an answer outside the contract", { kind: "garbage" }],
  ] as const)("answers unavailable on %s (outage)", async (_case, run) => {
    coach.use({ run });

    expect(await callPlan()).toEqual({
      ok: false,
      failure: "unavailable",
      usage: null,
      requestId: null,
    });
    expect(coach.runs).toHaveLength(1);
  });

  it("answers unavailable without a request when the coach service is not set up (env removed)", async () => {
    restore();
    restore = configureCoachService(coach, { COACH_SERVICE_URL: undefined });

    expect(await callPlan()).toMatchObject({ ok: false, failure: "unavailable" });
    expect(coach.healthChecks).toEqual([]);
    expect(coach.runs).toEqual([]);
  });

  it("logs prompt version, model, durations, Claude's request id and usage, never the input, output or secret", async () => {
    await callPlan();

    expect(coachLog.info).toHaveBeenCalledWith(
      {
        promptVersion: "run-insight/v1",
        model: config.COACH_MODEL,
        durationMs: expect.any(Number) as unknown,
        wakeMs: expect.any(Number) as unknown,
        claudeRequestId: "req_plan_1",
        usage: PLAN_USAGE,
      },
      "coach answered",
    );
    const text = logged();
    expect(text).not.toContain("5.0 km in 25:00");
    expect(text).not.toContain((VALID_OUTPUT as { headline: string }).headline);
    expect(text).not.toContain(FAKE_COACH_SECRET);
  });
});
