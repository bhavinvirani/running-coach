import {
  type CoachFallbackReason,
  coachFallbackReasonSchema,
  isGpsGlitch,
} from "@running-coach/shared";
import type { CoachCardFailure } from "../../client";
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatLocalDate,
  formatPace,
} from "../../format";
import {
  describeSession,
  type InsightActivity,
  type InsightPlan,
  type InsightSettings,
} from "./input";
import type { RunInsight } from "./schema";

// The card shown when there is no usable model output: no key, a refusal, max_tokens, invalid JSON, a
// timeout, Claude being down, a rejected key, a request Claude turned down (no credit left) or a
// rejected plan token. Built from the run's numbers and the next planned session alone, in the same
// shape as the model's. The reason is the shared enum the API stores.

export type RunInsightFallbackReason = CoachFallbackReason;

// Every way callCoach can fail but the plan's usage limit (a wait, never a card) has a stored reason: a
// new failure that is not in the shared enum stops the build here instead of failing the coach_message
// CHECK at run time.
type Assert<T extends true> = T;
type _EveryFailureIsAFallbackReason = Assert<
  [CoachCardFailure] extends [CoachFallbackReason] ? true : false
>;

const WHY: Record<RunInsightFallbackReason, string> = {
  missing_key: "No coach review: add your Claude API key in Settings to get one after each run.",
  key_invalid: "No coach review: Claude rejected your API key. Replace it in Settings.",
  request_rejected:
    "No coach review: Claude turned the request down, often because the account has no credit left. Check billing in the Claude Console, then tap Try again.",
  refusal: "No coach review this time. These are the run's numbers only.",
  max_tokens: "No coach review this time. These are the run's numbers only.",
  invalid_output: "No coach review this time. These are the run's numbers only.",
  timeout: "No coach review: Claude took too long to answer. These are the run's numbers only.",
  unavailable:
    "No coach review: Claude is not answering right now. These are the run's numbers only.",
  // The plan is the owner's alone, who runs the coach service.
  plan_auth_failed:
    "No coach review: Claude rejected the plan token on the coach service. Make a new one with claude setup-token, replace CLAUDE_CODE_OAUTH_TOKEN on the coach service, then tap Try again.",
};

/** Every reason there is a fallback card for; the eval checks each one's card. */
export const RUN_INSIGHT_FALLBACK_REASONS: readonly RunInsightFallbackReason[] =
  coachFallbackReasonSchema.options;

const SAFETY = "Rest or run easy if anything hurts or you feel unwell.";

function nextStepOf(plan: InsightPlan | null, settings: InsightSettings): string {
  // No active plan: there is nothing to follow, so the safe default is an easy run or a rest day.
  if (!plan) return `Keep your next run easy, or take a rest day. ${SAFETY}`;
  if (!plan.next) return `Follow the plan for your next session. ${SAFETY}`;
  const session = describeSession(plan.next, settings.units);
  return `Next planned session: ${formatLocalDate(plan.next.date)}, ${session}. Run it as written. ${SAFETY}`;
}

export function buildRunInsightFallback(
  activity: InsightActivity,
  settings: InsightSettings,
  reason: RunInsightFallbackReason,
  plan: InsightPlan | null,
): RunInsight {
  const { units } = settings;
  const distance = formatDistance(activity.distanceM, units);
  const duration = formatDuration(activity.durationS);
  const pace = isGpsGlitch(activity.distanceM, activity.durationS)
    ? null
    : formatPace(activity.distanceM, activity.durationS, units);

  const facts: string[] = [];
  if (activity.avgHr !== null) {
    const max = activity.maxHr === null ? "" : `, max ${Math.round(activity.maxHr)} bpm`;
    facts.push(`Average heart rate ${Math.round(activity.avgHr)} bpm${max}.`);
  } else {
    facts.push("No heart rate was recorded.");
  }
  if (activity.cadence !== null)
    facts.push(`Cadence ${Math.round(activity.cadence)} steps per minute.`);
  if (activity.elevationGainM !== null) {
    facts.push(`Elevation gain ${formatElevation(activity.elevationGainM, units)}.`);
  }

  return {
    headline: pace ? `${distance} in ${duration} at ${pace}.` : `${distance} in ${duration}.`,
    whatHappened: facts.join(" "),
    whatItMeans: WHY[reason],
    nextStep: nextStepOf(plan, settings),
    caution: "none",
  };
}
