import { z } from "zod";

/** easy_next: the next run should be easy. rest_and_check: rest, and see a professional if it persists. */
export const runInsightCautionSchema = z.enum(["none", "easy_next", "rest_and_check"]);
export type RunInsightCaution = z.infer<typeof runInsightCautionSchema>;

/**
 * The coach's card for one run, written by Claude or built as the fallback card in the same shape. Small
 * and flat so structured outputs can hold it; the SDK drops the length limits from the JSON Schema it
 * sends, so the API checks them after the model answers.
 */
export const runInsightSchema = z
  .object({
    /** One sentence with the run's main number. */
    headline: z.string().min(1).max(120),
    whatHappened: z.string().min(1).max(400),
    whatItMeans: z.string().min(1).max(400),
    nextStep: z.string().min(1).max(400),
    caution: runInsightCautionSchema,
  })
  .strict();
export type RunInsight = z.infer<typeof runInsightSchema>;

/**
 * Why a card was built without the model. missing_key is never stored, because no key queues no job, but
 * its card exists for callers without a key. timeout and unavailable are worth another try later;
 * request_rejected is Claude turning the request down for good (no credit left, no access to the model).
 * plan_auth_failed: Claude rejected the owner's plan token on the coach service (expired or revoked).
 */
export const coachFallbackReasonSchema = z.enum([
  "missing_key",
  "key_invalid",
  "refusal",
  "max_tokens",
  "invalid_output",
  "timeout",
  "unavailable",
  "request_rejected",
  "plan_auth_failed",
]);
export type CoachFallbackReason = z.infer<typeof coachFallbackReasonSchema>;

export const coachFeedbackSchema = z.enum(["up", "down"]);
export type CoachFeedback = z.infer<typeof coachFeedbackSchema>;

/**
 * PUT /api/me/claude-key: the API checks the key with Claude (a free call) and stores it encrypted, or
 * answers 422 claude_key_invalid and stores nothing; responds with meResponseSchema. DELETE removes it.
 */
export const claudeKeyRequestSchema = z
  .object({
    // Visible ASCII only: a space, line break or NUL inside a key would make the HTTP client throw an
    // error that quotes the header, key and all.
    key: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7E]+$/, "A Claude key has no spaces or line breaks"),
  })
  .strict();
export type ClaudeKeyRequest = z.infer<typeof claudeKeyRequestSchema>;

/** A stored insight card. */
export const runInsightCardSchema = z
  .object({
    id: z.uuid(),
    content: runInsightSchema,
    /** Null when the model wrote the card. */
    fallbackReason: coachFallbackReasonSchema.nullable(),
    feedback: coachFeedbackSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type RunInsightCard = z.infer<typeof runInsightCardSchema>;

/**
 * GET /api/activities/:id/insight, and POST (ask the coach) for a run with no card or a fallback card.
 * ready: a stored card, the model's or a fallback. pending: the coach is writing one. retrying: Claude
 * failed and the job will try again later; resumesAt when the job waits for the Claude plan's usage limit
 * to reset (POST pulls it forward). none: a key is set but this run has no card (an imported or
 * older run). no_key: no card and no Claude key.
 */
export const insightResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), insight: runInsightCardSchema }).strict(),
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("retrying"), resumesAt: z.iso.datetime().optional() }).strict(),
  z.object({ state: z.literal("none") }).strict(),
  z.object({ state: z.literal("no_key") }).strict(),
]);
export type InsightResponse = z.infer<typeof insightResponseSchema>;
export type InsightState = InsightResponse["state"];

export const insightParamsSchema = z.object({ id: z.uuid() }).strict();
export type InsightParams = z.infer<typeof insightParamsSchema>;

/** PUT /api/insights/:id/feedback: thumbs up, down, or null to clear; responds with insightResponseSchema. */
export const insightFeedbackRequestSchema = z
  .object({ feedback: coachFeedbackSchema.nullable() })
  .strict();
export type InsightFeedbackRequest = z.infer<typeof insightFeedbackRequestSchema>;
