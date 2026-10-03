import { describe, expect, it } from "vitest";
import { coachRunRequestSchema, coachRunResponseSchema } from "./coach-service";

const request = {
  system: "You are a running coach.",
  input: "Run: 10.0 km in 52:00.",
  jsonSchema: { type: "object", properties: {} },
  model: "claude-opus-5-5",
  fallbackModel: "claude-sonnet-5-5",
  maxTokens: 4096,
};

describe("coachRunRequestSchema", () => {
  it("accepts a run request", () => {
    expect(coachRunRequestSchema.safeParse(request).success).toBe(true);
  });

  it("rejects anything beyond the prompt, schema and models", () => {
    expect(coachRunRequestSchema.safeParse({ ...request, token: "x" }).success).toBe(false);
  });
});

describe("coachRunResponseSchema", () => {
  it("accepts an output and each failure", () => {
    const usage = { inputTokens: 900, outputTokens: 210 };
    const ok = { ok: true, output: { headline: "x" }, model: "claude-opus-5-5", usage };
    expect(coachRunResponseSchema.safeParse({ ...ok, claudeRequestId: "req_1" }).success).toBe(
      true,
    );
    const limited = {
      ok: false,
      failure: "plan_limited",
      retryAfterSeconds: 3600,
      usage: null,
      claudeRequestId: null,
    };
    expect(coachRunResponseSchema.safeParse(limited).success).toBe(true);
  });

  it("rejects a reset further out than the plan's longest window", () => {
    const limited = {
      ok: false,
      failure: "plan_limited",
      retryAfterSeconds: 9 * 24 * 60 * 60,
      usage: null,
      claudeRequestId: null,
    };
    expect(coachRunResponseSchema.safeParse(limited).success).toBe(false);
  });

  it("rejects a reset already passed", () => {
    const limited = {
      ok: false,
      failure: "plan_limited",
      retryAfterSeconds: 0,
      usage: null,
      claudeRequestId: null,
    };
    expect(coachRunResponseSchema.safeParse(limited).success).toBe(false);
  });
});
