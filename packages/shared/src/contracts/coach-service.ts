import { z } from "zod";

// Between the API and the coach service (services/coach), which runs one prompt on the owner's Claude plan
// through Claude Code. The API owns the prompts, the output schemas and the fallback cards; the service
// only runs what it is sent, so it never sees a user, a key or a database.

/** POST /v1/run, with the shared secret in x-coach-secret. */
export const coachRunRequestSchema = z
  .object({
    /** The system prompt, from the prompt's versioned file. */
    system: z.string().min(1).max(100_000),
    /** The user message, from the prompt's input.ts. */
    input: z.string().min(1).max(100_000),
    /** JSON Schema (draft-07) of the output, built from the prompt's zod schema. */
    jsonSchema: z.record(z.string(), z.unknown()),
    model: z.string().min(1).max(100),
    /** Claude Code switches to it when the model is overloaded. */
    fallbackModel: z.string().min(1).max(100),
    maxTokens: z.number().int().min(1).max(64_000),
  })
  .strict();
export type CoachRunRequest = z.infer<typeof coachRunRequestSchema>;

/**
 * Why a run gave no usable output. plan_auth_failed: Claude rejected the plan token. plan_limited: the
 * plan's usage limit, with retryAfterSeconds until it resets. timeout: no answer within the service's
 * budget. unavailable: Claude overloaded or down after Claude Code's own retries. request_rejected: Claude
 * turned the request down for good (billing, model access). The rest are the model's answer, unusable.
 */
export const coachRunFailureSchema = z.enum([
  "refusal",
  "max_tokens",
  "invalid_output",
  "timeout",
  "unavailable",
  "request_rejected",
  "plan_auth_failed",
  "plan_limited",
]);
export type CoachRunFailure = z.infer<typeof coachRunFailureSchema>;

/** Tokens of the run, stored in coach_message.usage as for an API-key call. */
export const coachRunUsageSchema = z
  .object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) })
  .strict();
export type CoachRunUsage = z.infer<typeof coachRunUsageSchema>;

/**
 * The run's outcome, 200 either way: a failure here is Claude's answer about the prompt, while the
 * service's own errors (wrong secret 401, invalid body 400, internal 500) are problem+json. The output is
 * the model's structured output, unparsed: the API parses it with the prompt's zod schema.
 */
export const coachRunResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      output: z.unknown(),
      /** The model that wrote the output: the fallback model when Claude Code switched to it. */
      model: z.string().min(1),
      usage: coachRunUsageSchema,
      /** Claude's request id, for the log line beside the stored card. */
      claudeRequestId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      failure: coachRunFailureSchema,
      /** Seconds until the plan's limit resets; set with plan_limited only. */
      retryAfterSeconds: z.number().int().min(1).optional(),
      /** Set when a model answered, unusably. */
      usage: coachRunUsageSchema.nullable(),
      claudeRequestId: z.string().nullable(),
    })
    .strict(),
]);
export type CoachRunResponse = z.infer<typeof coachRunResponseSchema>;
