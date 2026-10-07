import { type CoachCallCredential, callCoach, type CoachUsage, INSIGHT_MAX_TOKENS } from "./client";
import {
  buildWeeklyReviewFallback,
  type WeeklyReviewFallbackReason,
} from "./prompts/weekly-review/fallback";
import {
  buildWeeklyReviewInput,
  type ReviewPlan,
  type ReviewSettings,
  type ReviewWeek,
} from "./prompts/weekly-review/input";
import {
  type ReviewChangeProposal,
  type WeeklyReview,
  weeklyReviewOutputSchema,
} from "./prompts/weekly-review/schema";

// The coach's review of the Monday-to-Sunday week that just ended, and the changes it proposes for the
// coming week's sessions, which the service hands to the engine. The prompt file in use is
// prompts/weekly-review/<WEEKLY_REVIEW_VERSION>.md; a change to a shipped prompt adds the next version and
// moves this constant.

export const WEEKLY_REVIEW_PROMPT = "weekly-review";
export const WEEKLY_REVIEW_VERSION = "v1";

export interface WeeklyReviewInput {
  /** The user's decrypted Claude key or the owner's Claude plan; null means no call and the fallback card. */
  credential: CoachCallCredential | null;
  /** The week that just ended. */
  week: ReviewWeek;
  /** The goal and the coming week's labelled sessions; null when the user has no active plan. */
  plan: ReviewPlan | null;
  settings: ReviewSettings;
}

export interface WeeklyReviewResult {
  limited: false;
  /** The card, its nextWeek the coming week as planned, true whatever the engine does with the changes. */
  content: WeeklyReview;
  /** The changes the model proposes, by session label, for the engine to accept, clamp or reject; empty for the fallback card. */
  changes: ReviewChangeProposal[];
  fallback: boolean;
  fallbackReason: WeeklyReviewFallbackReason | null;
  /** Tokens billed, or null when no model answered. */
  usage: CoachUsage | null;
  /** The model that wrote content; null for the fallback card. */
  model: string | null;
  /** "weekly-review/v1" */
  promptVersion: string;
  /** Claude's request-id, for the log line beside the stored message. */
  requestId: string | null;
}

/**
 * The plan's usage limit: no card, because the coach can still write one once the limit resets in
 * retryAfterSeconds, so the job waits for it instead.
 */
export interface WeeklyReviewLimited {
  limited: true;
  retryAfterSeconds: number;
  usage: CoachUsage | null;
  promptVersion: string;
  requestId: string | null;
}

export async function weeklyReview({
  credential,
  week,
  plan,
  settings,
}: WeeklyReviewInput): Promise<WeeklyReviewResult | WeeklyReviewLimited> {
  const promptVersion = `${WEEKLY_REVIEW_PROMPT}/${WEEKLY_REVIEW_VERSION}`;
  const fallback = (
    reason: WeeklyReviewFallbackReason,
    usage: CoachUsage | null,
    requestId: string | null,
  ): WeeklyReviewResult => ({
    limited: false,
    content: buildWeeklyReviewFallback(week, plan, settings, reason),
    changes: [],
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
    prompt: WEEKLY_REVIEW_PROMPT,
    version: WEEKLY_REVIEW_VERSION,
    input: buildWeeklyReviewInput(week, plan, settings),
    schema: weeklyReviewOutputSchema,
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
  const { changes, ...content } = result.output;
  return {
    limited: false,
    content,
    changes,
    fallback: false,
    fallbackReason: null,
    usage: result.usage,
    model: result.model,
    promptVersion,
    requestId: result.requestId,
  };
}
