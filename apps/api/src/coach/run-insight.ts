import { type CoachCallCredential, callCoach, type CoachUsage, INSIGHT_MAX_TOKENS } from "./client";
import {
  buildRunInsightFallback,
  type RunInsightFallbackReason,
} from "./prompts/run-insight/fallback";
import {
  buildRunInsightInput,
  type InsightActivity,
  type InsightContext,
  type InsightPlan,
  type InsightSettings,
} from "./prompts/run-insight/input";
import {
  type CoachAdjustment,
  type RunInsight,
  runInsightOutputSchema,
} from "./prompts/run-insight/schema";

// The coach's card for one run, and since v2 the change it proposes for the next session, which the
// service hands to the engine. The prompt file in use is prompts/run-insight/<RUN_INSIGHT_VERSION>.md;
// a change to a shipped prompt adds the next version and moves this constant.

export const RUN_INSIGHT_PROMPT = "run-insight";
export const RUN_INSIGHT_VERSION = "v2";

export interface RunInsightInput {
  /** The user's decrypted Claude key or the owner's Claude plan; null means no call and the fallback card. */
  credential: CoachCallCredential | null;
  activity: InsightActivity;
  settings: InsightSettings;
  /** The sessions planned that day and next; null when the user has no active plan. */
  plan: InsightPlan | null;
  /** The previous run, an open pause and whether a plan change is allowed. */
  context: InsightContext;
}

export interface RunInsightResult {
  limited: false;
  /** The card, its nextStep the next session as written; the service swaps in the adjustment's. */
  content: RunInsight;
  /** The model's proposed change to the next session; null for the fallback card, which never has one. */
  adjustment: CoachAdjustment | null;
  fallback: boolean;
  fallbackReason: RunInsightFallbackReason | null;
  /** Tokens billed, or null when no model answered. */
  usage: CoachUsage | null;
  /** The model that wrote content; null for the fallback card. */
  model: string | null;
  /** "run-insight/v2" */
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
  context,
}: RunInsightInput): Promise<RunInsightResult | RunInsightLimited> {
  const promptVersion = `${RUN_INSIGHT_PROMPT}/${RUN_INSIGHT_VERSION}`;
  const fallback = (
    reason: RunInsightFallbackReason,
    usage: CoachUsage | null,
    requestId: string | null,
  ): RunInsightResult => ({
    limited: false,
    content: buildRunInsightFallback(activity, settings, reason, plan, context.pause),
    adjustment: null,
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
    input: buildRunInsightInput(activity, settings, plan, context),
    schema: runInsightOutputSchema,
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
  const { adjustment, ...content } = result.output;
  return {
    limited: false,
    content,
    adjustment,
    fallback: false,
    fallbackReason: null,
    usage: result.usage,
    model: result.model,
    promptVersion,
    requestId: result.requestId,
  };
}
