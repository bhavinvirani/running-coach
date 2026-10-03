import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { classifyRun, newObservation, observe, retryAfterSeconds } from "./outcome";

// Frames trimmed to the fields the classifier reads, shaped like Claude Code 2.1.288's.

const NOW_MS = Date.UTC(2026, 9, 3, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const CONTEXT = { nowMs: NOW_MS, requestedModel: "claude-opus-5-5" };

const frame = (value: Record<string, unknown>) => value as unknown as SDKMessage;

function assistant(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return frame({ type: "assistant", message: { content: [], ...message }, ...extra });
}

function result(fields: Record<string, unknown>) {
  return frame({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    stop_reason: "tool_use",
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    ...fields,
  });
}

function rateLimit(info: Record<string, unknown>) {
  return frame({ type: "rate_limit_event", rate_limit_info: info });
}

function classify(...messages: SDKMessage[]) {
  const observation = newObservation();
  for (const message of messages) observe(observation, message);
  return classifyRun(observation, CONTEXT);
}

const opusUsage = (input: number, output: number) => ({
  "claude-opus-5-5": {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
});

describe("retryAfterSeconds", () => {
  it("counts seconds to resetsAt, which is Unix seconds", () => {
    expect(retryAfterSeconds({ status: "rejected", resetsAt: NOW_S + 5400 }, NOW_MS)).toBe(5400);
  });

  it("usage limit without a reset time: retries in an hour", () => {
    expect(retryAfterSeconds({ status: "rejected" }, NOW_MS)).toBe(3600);
  });

  it("usage limit resetting within a minute or already past: waits 60 s", () => {
    expect(retryAfterSeconds({ status: "rejected", resetsAt: NOW_S + 5 }, NOW_MS)).toBe(60);
    expect(retryAfterSeconds({ status: "rejected", resetsAt: NOW_S - 300 }, NOW_MS)).toBe(60);
  });

  it("a reset beyond the longest plan window (a misread unit): capped at 8 days", () => {
    expect(retryAfterSeconds({ status: "rejected", resetsAt: NOW_MS + 60_000 }, NOW_MS)).toBe(
      8 * 24 * 3600,
    );
  });
});

describe("classifyRun", () => {
  it("success with structured output: ok with the answering model and usage including cache tokens", () => {
    const response = classify(
      assistant({ model: "claude-opus-5-5", stop_reason: null }, { request_id: "req_1" }),
      result({
        structured_output: { headline: "x" },
        modelUsage: {
          "claude-opus-5-5": {
            inputTokens: 2,
            outputTokens: 372,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 1239,
          },
        },
      }),
    );

    expect(response).toEqual({
      ok: true,
      output: { headline: "x" },
      model: "claude-opus-5-5",
      usage: { inputTokens: 1251, outputTokens: 372 },
      claudeRequestId: "req_1",
    });
  });

  it("success result with is_error true is never ok: classified by the preceding assistant error", () => {
    const response = classify(
      assistant(
        { model: "<synthetic>", stop_reason: "stop_sequence" },
        { error: "authentication_failed" },
      ),
      result({ is_error: true, api_error_status: 401, structured_output: { stale: true } }),
    );

    expect(response).toMatchObject({ ok: false, failure: "plan_auth_failed", usage: null });
  });

  it("synthetic error frames never name the model", () => {
    const response = classify(
      assistant({ model: "claude-sonnet-5-5", stop_reason: null }),
      assistant({ model: "<synthetic>" }, { error: "overloaded" }),
      result({ structured_output: { a: 1 }, modelUsage: opusUsage(5, 5) }),
    );

    expect(response.ok && response.model).toBe("claude-sonnet-5-5");
  });

  it("no assistant model: the model with the most output in modelUsage", () => {
    const response = classify(result({ structured_output: { a: 1 }, modelUsage: opusUsage(5, 9) }));

    expect(response.ok && response.model).toBe("claude-opus-5-5");
  });

  it("oauth_org_not_allowed: plan_auth_failed", () => {
    const response = classify(
      assistant({ model: "<synthetic>" }, { error: "oauth_org_not_allowed" }),
      result({ is_error: true, api_error_status: 403 }),
    );

    expect(response).toMatchObject({ ok: false, failure: "plan_auth_failed" });
  });

  it("rejected plan limit with a rate_limit error: plan_limited with retryAfterSeconds", () => {
    const response = classify(
      rateLimit({ status: "rejected", resetsAt: NOW_S + 900, rateLimitType: "five_hour" }),
      assistant({ model: "<synthetic>" }, { error: "rate_limit" }),
      result({ is_error: true, api_error_status: 429 }),
    );

    expect(response).toEqual({
      ok: false,
      failure: "plan_limited",
      retryAfterSeconds: 900,
      usage: null,
      claudeRequestId: null,
    });
  });

  it("rate_limit error without a rejected plan event: unavailable, not plan_limited", () => {
    const response = classify(
      rateLimit({ status: "allowed_warning", resetsAt: NOW_S + 900 }),
      assistant({ model: "<synthetic>" }, { error: "rate_limit" }),
      result({ is_error: true, api_error_status: 429 }),
    );

    expect(response).toMatchObject({ ok: false, failure: "unavailable" });
    expect(response.ok || response.retryAfterSeconds).toBeUndefined();
  });

  it("a rejected limit followed by a success (overage): ok", () => {
    const response = classify(
      rateLimit({ status: "rejected", resetsAt: NOW_S + 900 }),
      assistant({ model: "claude-opus-5-5" }),
      result({ structured_output: { a: 1 }, modelUsage: opusUsage(1, 1) }),
    );

    expect(response.ok).toBe(true);
  });

  it("refusal arrives as an invalid_request frame with stop reason refusal: refusal, not request_rejected", () => {
    const response = classify(
      assistant({ model: "<synthetic>", stop_reason: "refusal" }, { error: "invalid_request" }),
      result({ is_error: true, stop_reason: "refusal", modelUsage: opusUsage(12, 3) }),
    );

    expect(response).toMatchObject({
      ok: false,
      failure: "refusal",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it("model_refusal_no_fallback: refusal", () => {
    const response = classify(
      frame({ type: "system", subtype: "model_refusal_no_fallback", original_model: "x" }),
      result({ is_error: true }),
    );

    expect(response).toMatchObject({ ok: false, failure: "refusal" });
  });

  it("max tokens by stop reason or by the max_output_tokens error: max_tokens", () => {
    expect(
      classify(assistant({ model: "claude-opus-5-5", stop_reason: "max_tokens" }), result({})),
    ).toMatchObject({ ok: false, failure: "max_tokens" });
    expect(
      classify(
        assistant({ model: "<synthetic>" }, { error: "max_output_tokens" }),
        result({ is_error: true }),
      ),
    ).toMatchObject({ ok: false, failure: "max_tokens" });
  });

  it.each(["overloaded", "server_error", "unknown"])("%s: unavailable", (error) => {
    const response = classify(
      assistant({ model: "<synthetic>" }, { error }),
      result({ is_error: true, api_error_status: 529 }),
    );

    expect(response).toMatchObject({ ok: false, failure: "unavailable" });
  });

  it.each([
    "billing_error",
    "account_on_hold",
    "verification_required",
    "invalid_request",
    "model_not_found",
  ])("%s: request_rejected", (error) => {
    const response = classify(
      assistant({ model: "<synthetic>" }, { error }),
      result({ is_error: true, api_error_status: 400 }),
    );

    expect(response).toMatchObject({ ok: false, failure: "request_rejected" });
  });

  it.each(["error_max_structured_output_retries", "error_max_turns"])(
    "%s: invalid_output",
    (subtype) => {
      const response = classify(result({ subtype, is_error: true, modelUsage: opusUsage(9, 9) }));

      expect(response).toMatchObject({ ok: false, failure: "invalid_output" });
    },
  );

  it("success without structured output: invalid_output", () => {
    const response = classify(result({ modelUsage: opusUsage(9, 9) }));

    expect(response).toMatchObject({ ok: false, failure: "invalid_output" });
  });

  it("an error result without an assistant error reads the HTTP status", () => {
    expect(classify(result({ is_error: true, api_error_status: 401 }))).toMatchObject({
      failure: "plan_auth_failed",
    });
    expect(classify(result({ is_error: true, api_error_status: 400 }))).toMatchObject({
      failure: "request_rejected",
    });
    expect(classify(result({ is_error: true, api_error_status: 429 }))).toMatchObject({
      failure: "unavailable",
    });
    expect(classify(result({ is_error: true, api_error_status: null }))).toMatchObject({
      failure: "unavailable",
    });
  });

  it("no result (the CLI crashed or never started): unavailable", () => {
    expect(classify(assistant({ model: "claude-opus-5-5" }))).toMatchObject({
      ok: false,
      failure: "unavailable",
      usage: null,
    });
  });

  it("error_during_execution: unavailable", () => {
    expect(classify(result({ subtype: "error_during_execution", is_error: true }))).toMatchObject({
      failure: "unavailable",
    });
  });
});
