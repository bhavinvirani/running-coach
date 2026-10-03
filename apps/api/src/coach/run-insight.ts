import { type CoachCallCredential, callCoach, type CoachUsage, INSIGHT_MAX_TOKENS } from "./client";
import {
  buildRunInsightFallback,
  type RunInsightFallbackReason,
} from "./prompts/run-insight/fallback";
import {
  buildRunInsightInput,
  type InsightActivity,
  type InsightPlan,
  type InsightSettings,
} from "./prompts/run-insight/input";
import { type RunInsight, runInsightSchema } from "./prompts/run-insight/schema";

// The coach's card for one run. The prompt file in use is prompts/run-insight/<RUN_INSIGHT_VERSION>.md;
// a change to a shipped prompt adds the next version and moves this constant.

export const RUN_INSIGHT_PROMPT = "run-insight";
export const RUN_INSIGHT_VERSION = "v1";

export interface RunInsightInput {
  /** The user's decrypted Claude key or the owner's Claude plan; null means no call and the fallback card. */
  credential: CoachCallCredential | null;
  activity: InsightActivity;
  settings: InsightSettings;
  /** The sessions planned that day and next; null when the user has no active plan. */
  plan: InsightPlan | null;
}

export interface RunInsightResult {
  limited: false;
  content: RunInsight;
  fallback: boolean;
  fallbackReason: RunInsightFallbackReason | null;
  /** Tokens billed, or null when no model answered. */
  usage: CoachUsage | null;
  /** The model that wrote content; null for the fallback card. */
  model: string | null;
  /** "run-insight/v1" */
  promptVersion: string;
  /** Claude's request-id, for the log line beside the stored message. */
  requestId: string | null;
}

/**
 * The plan's usage limit: no card, because the coach can still write one once the limit resets in
 * retryAfterSeconds, so the job waits for it instead.
 */
export interface RunInsightLimited {
  limited: true;
  retryAfterSeconds: number;
  usage: CoachUsage | null;
  promptVersion: string;
  requestId: string | null;
}

export async function runInsight({
  credential,
  activity,
  settings,
  plan,
}: RunInsightInput): Promise<RunInsightResult | RunInsightLimited> {
  const promptVersion = `${RUN_INSIGHT_PROMPT}/${RUN_INSIGHT_VERSION}`;
  const fallback = (
    reason: RunInsightFallbackReason,
    usage: CoachUsage | null,
    requestId: string | null,
  ): RunInsightResult => ({
    limited: false,
    content: buildRunInsightFallback(activity, settings, reason, plan),
    fallback: true,
    fallbackReason: reason,
    usage,
    model: null,
    promptVersion,
    requestId,
  });

  if (!credential) return fallback("missing_key", null, null);

  const result = await callCoach({
    credential,
    prompt: RUN_INSIGHT_PROMPT,
    version: RUN_INSIGHT_VERSION,
    input: buildRunInsightInput(activity, settings, plan),
    schema: runInsightSchema,
    maxTokens: INSIGHT_MAX_TOKENS,
  });
  if (!result.ok) {
    if (result.failure === "plan_limited") {
      return {
        limited: true,
        retryAfterSeconds: result.retryAfterSeconds,
        usage: result.usage,
        promptVersion,
        requestId: result.requestId,
      };
    }
    return fallback(result.failure, result.usage, result.requestId);
  }
  return {
    limited: false,
    content: result.output,
    fallback: false,
    fallbackReason: null,
    usage: result.usage,
    model: result.model,
    promptVersion,
    requestId: result.requestId,
  };
}
