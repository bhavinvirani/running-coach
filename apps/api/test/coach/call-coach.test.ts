import { describe, expect, it, vi } from "vitest";
import { callCoach, INSIGHT_MAX_TOKENS } from "../../src/coach/client";
import { runInsightSchema } from "../../src/coach/prompts/run-insight/schema";
import { config } from "../../src/lib/config";
import type * as loggerModule from "../../src/lib/logger";
import { claudeKey } from "../seed";

// callCoach against the fake Claude, with the coach module's logger replaced by spies: tests log at
// "silent", so what callCoach logs is only visible here.

const coachLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("../../src/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof loggerModule>();
  const logger = Object.create(actual.logger) as typeof actual.logger;
  logger.child = ((bindings: Record<string, unknown>) =>
    bindings.module === "coach" ? coachLog : actual.logger.child(bindings)) as typeof logger.child;
  return { ...actual, logger };
});

describe("callCoach", () => {
  it("answers unavailable and logs a configuration error when the fallback model is missing (404) after an overloaded primary", async () => {
    const apiKey = claudeKey("fallback-model-missing");

    const result = await callCoach({
      apiKey,
      prompt: "run-insight",
      version: "v1",
      input: "Run: 5.0 km",
      schema: runInsightSchema,
      maxTokens: INSIGHT_MAX_TOKENS,
    });

    expect(result).toEqual({
      ok: false,
      failure: "unavailable",
      usage: null,
      requestId: "req_fake_2",
    });
    expect(coachLog.error).toHaveBeenCalledTimes(1);
    const [fields, message] = coachLog.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      promptVersion: "run-insight/v1",
      model: config.COACH_FALLBACK_MODEL,
      status: 404,
      claudeRequestId: "req_fake_2",
      errorType: "not_found_error",
    });
    expect(message).toContain("COACH_FALLBACK_MODEL");
    expect(JSON.stringify(coachLog.error.mock.calls)).not.toContain(apiKey);
  });

  it("logs Claude's error type and message when it rejects the request, so a credit problem says why", async () => {
    const apiKey = claudeKey("request-rejected");
    coachLog.warn.mockClear();

    const result = await callCoach({
      apiKey,
      prompt: "run-insight",
      version: "v1",
      input: "Run: 5.0 km",
      schema: runInsightSchema,
      maxTokens: INSIGHT_MAX_TOKENS,
    });

    expect(result).toMatchObject({ ok: false, failure: "request_rejected" });
    const failed = coachLog.warn.mock.calls.find((call) => call[1] === "coach call failed");
    expect(failed?.[0]).toMatchObject({
      status: 400,
      errorType: "invalid_request_error",
      errorMessage: expect.stringContaining("credit balance is too low") as unknown,
      failure: "request_rejected",
    });
    expect(JSON.stringify(coachLog.warn.mock.calls)).not.toContain(apiKey);
  });
});
