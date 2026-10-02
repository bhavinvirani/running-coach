import { isGpsGlitch } from "@running-coach/shared";
import type { CoachFailure } from "../../client";
import { formatDistance, formatDuration, formatElevation, formatPace } from "../../format";
import type { InsightActivity, InsightSettings } from "./input";
import type { RunInsight } from "./schema";

// The card shown when there is no usable model output: no key, a refusal, max_tokens, invalid JSON, a
// timeout or Claude being down. Built from the run's numbers alone, in the same shape as the model's.

export type RunInsightFallbackReason = "missing_key" | CoachFailure;

const WHY: Record<RunInsightFallbackReason, string> = {
  missing_key: "No coach review: add your Claude API key in Settings to get one after each run.",
  key_invalid: "No coach review: Claude rejected your API key. Update it in Settings.",
  refusal: "No coach review this time. These are the run's numbers only.",
  max_tokens: "No coach review this time. These are the run's numbers only.",
  invalid_output: "No coach review this time. These are the run's numbers only.",
  timeout: "No coach review: Claude took too long to answer. These are the run's numbers only.",
  unavailable:
    "No coach review: Claude is not answering right now. These are the run's numbers only.",
};

/** Every reason there is a fallback card for; the eval checks each one's card. */
export const RUN_INSIGHT_FALLBACK_REASONS = Object.keys(WHY) as RunInsightFallbackReason[];

export function buildRunInsightFallback(
  activity: InsightActivity,
  settings: InsightSettings,
  reason: RunInsightFallbackReason,
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
    nextStep:
      "Follow the plan for your next session. Rest or run easy if anything hurts or you feel unwell.",
    caution: "none",
  };
}
