import {
  type CoachFallbackReason,
  coachFallbackReasonSchema,
  type PauseReason,
  SESSION_TYPE_NAMES,
  type SessionType,
  type Units,
} from "@running-coach/shared";
import type { CoachCardFailure } from "../../client";
import { formatDistance, formatDuration, formatLocalDate } from "../../format";
import {
  liveSessions,
  type ReviewPause,
  type ReviewPlan,
  type ReviewPlanSession,
  type ReviewSettings,
  type ReviewWeek,
} from "./input";
import { type WeeklyReview, weeklyReviewSchema } from "./schema";

// The card shown when there is no usable model output: no credential, a refusal, max_tokens, invalid
// output, a timeout, Claude being down, a rejected key, a request Claude turned down (no credit left) or a
// rejected plan token. Built from the week's numbers, its missed sessions and extra runs, any pause and the
// coming week's sessions alone, in the stored card's shape (weeklyReviewSchema). It never proposes a change:
// only the model does. There is no Try again for a review (the next week's is the next try), so no reason
// asks for one. The reason is the shared enum the API stores.

export type WeeklyReviewFallbackReason = CoachFallbackReason;

// Every way callCoach can fail but the plan's usage limit (a wait, never a card) has a stored reason.
type Assert<T extends true> = T;
type _EveryFailureIsAFallbackReason = Assert<
  [CoachCardFailure] extends [WeeklyReviewFallbackReason] ? true : false
>;

const NUMBERS_ONLY = "These are the week's numbers only.";

const WHY: Record<WeeklyReviewFallbackReason, string> = {
  missing_key: "No coach review: add your Claude API key in Settings to get one each week.",
  key_invalid: "No coach review: Claude rejected your API key. Replace it in Settings.",
  request_rejected:
    "No coach review: Claude turned the request down, often because the account has no credit left. Check billing in the Claude Console.",
  refusal: `No coach review this week. ${NUMBERS_ONLY}`,
  max_tokens: `No coach review this week. ${NUMBERS_ONLY}`,
  invalid_output: `No coach review this week. ${NUMBERS_ONLY}`,
  timeout: `No coach review: Claude took too long to answer. ${NUMBERS_ONLY}`,
  unavailable: `No coach review: Claude is not answering right now. ${NUMBERS_ONLY}`,
  // The plan is the owner's alone, who runs the coach service.
  plan_auth_failed:
    "No coach review: Claude rejected the plan token on the coach service. Make a new one with claude setup-token and replace CLAUDE_CODE_OAUTH_TOKEN on the coach service.",
};

/** Every reason there is a fallback card for; the eval checks each one's card. */
export const WEEKLY_REVIEW_FALLBACK_REASONS: readonly WeeklyReviewFallbackReason[] =
  coachFallbackReasonSchema.options;

const SAFETY = "Rest or run easy if anything hurts or you feel unwell.";
const PROFESSIONAL = "See a doctor or physio if it does not get better.";

const PAUSE_WORDS: Record<PauseReason, string> = {
  sick: "for illness",
  injured: "for pain or injury",
  break: "for a break",
};

const WHAT_HAPPENED_MAX = weeklyReviewSchema.shape.whatHappened.maxLength ?? 400;

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** Its title on one line, or its type's name. */
function sessionName(session: { type: SessionType; title: string | null }): string {
  return session.title?.replace(/\s+/g, " ").trim() || SESSION_TYPE_NAMES[session.type];
}

/**
 * "Missed: Tempo on Wednesday 30 September 2026, 9.0 km; and 1 more." within max characters, naming as
 * many items as fit, or only how many there were.
 */
function listSentence(label: string, items: string[], noun: string, max: number): string {
  for (let shown = items.length; shown >= 1; shown -= 1) {
    const rest = items.length - shown;
    const more = rest > 0 ? `; and ${rest} more` : "";
    const text = `${label}: ${items.slice(0, shown).join("; ")}${more}.`;
    if (text.length <= max) return text;
  }
  return `${label}: ${count(items.length, noun)}.`;
}

function headlineOf(week: ReviewWeek, units: Units): string {
  const { summary } = week;
  const paused = summary.paused ? "Paused week: " : "";
  const distance = formatDistance(summary.distanceM, units);
  if (summary.sessionsPlanned > 0) {
    return `${paused}${summary.sessionsDone} of ${count(summary.sessionsPlanned, "session")} done, ${distance} run.`;
  }
  if (summary.runs > 0) {
    return `${paused}${count(summary.runs, "run")}, ${distance} in ${formatDuration(summary.durationS)}.`;
  }
  const none = summary.paused ? "Paused week: no runs" : "No runs";
  return `${none} in the week of ${formatLocalDate(week.weekStart)}.`;
}

function whatHappenedOf(week: ReviewWeek, units: Units): string {
  const { summary } = week;
  const against =
    summary.plannedDistanceM > 0
      ? `, against ${formatDistance(summary.plannedDistanceM, units)} planned`
      : "";
  const sentences = [
    summary.runs > 0
      ? `${count(summary.runs, "run")}, ${formatDistance(summary.distanceM, units)} in ${formatDuration(summary.durationS)}${against}.`
      : `No runs this week${against}.`,
  ];
  const { pause } = week;
  if (pause) {
    const why = PAUSE_WORDS[pause.reason];
    sentences.push(
      pause.endDate === null
        ? `Training has been paused ${why} since ${formatLocalDate(pause.startDate)}.`
        : `Training was paused ${why} from ${formatLocalDate(pause.startDate)} to ${formatLocalDate(pause.endDate)}.`,
    );
  }
  const missed = week.sessions
    .filter((session) => session.status === "missed")
    .map((session) => {
      const distance = session.distanceM > 0 ? `, ${formatDistance(session.distanceM, units)}` : "";
      return `${sessionName(session)} on ${formatLocalDate(session.date)}${distance}`;
    });
  const extra = week.extraRuns.map(
    (run) =>
      `${formatDistance(run.distanceM, units)} on ${formatLocalDate(run.date)}${run.isIndoor ? " (indoor)" : ""}`,
  );
  // Each list gets an even share of what the first sentences leave, plus whatever the other one leaves.
  let left = WHAT_HAPPENED_MAX - sentences.join(" ").length;
  const lists: [string, string[], string][] = [
    ["Missed", missed, "session"],
    ["Runs outside the plan", extra, "run"],
  ];
  const present = lists.filter(([, items]) => items.length > 0);
  present.forEach(([label, items, noun], index) => {
    const share = Math.floor(left / (present.length - index)) - 1;
    const sentence = listSentence(label, items, noun, share);
    sentences.push(sentence);
    left -= sentence.length + 1;
  });
  return sentences.join(" ");
}

function whatItMeansOf(
  week: ReviewWeek,
  plan: ReviewPlan | null,
  units: Units,
  reason: WeeklyReviewFallbackReason,
): string {
  const { summary } = week;
  const sentences = [WHY[reason]];
  if (summary.paused) {
    sentences.push("The week was paused, so its numbers say little about your fitness.");
  } else if (summary.plannedDistanceM > 0) {
    const share = Math.round((100 * summary.distanceM) / summary.plannedDistanceM);
    sentences.push(
      `The week's runs came to ${share}% of the ${formatDistance(summary.plannedDistanceM, units)} planned.`,
    );
  } else if (plan === null) {
    sentences.push("There is no plan to compare the week with.");
  } else {
    sentences.push("Nothing was planned this week.");
  }
  if (week.weekBefore) {
    const { runs, distanceM } = week.weekBefore;
    sentences.push(`The week before: ${count(runs, "run")}, ${formatDistance(distanceM, units)}.`);
  }
  return sentences.join(" ");
}

/** The coming week's key session: the race, or else its longest long run. */
function keySession(sessions: ReviewPlanSession[], units: Units): string {
  const race = sessions.find((session) => session.type === "race");
  if (race) return `, with the race on ${formatLocalDate(race.date)}`;
  const long = sessions
    .filter((session) => session.type === "long")
    .reduce<ReviewPlanSession | null>(
      (longest, session) =>
        longest === null || session.distanceM > longest.distanceM ? session : longest,
      null,
    );
  if (long === null || long.distanceM === 0) return "";
  return `, with the long run of ${formatDistance(long.distanceM, units)} on ${formatLocalDate(long.date)}`;
}

/** The pause open now: one opened after the week, or the week's own while it is still open. */
function pauseNow(week: ReviewWeek): ReviewPause | null {
  return week.openPause ?? (week.pause?.endDate === null ? week.pause : null);
}

function nextWeekOf(week: ReviewWeek, plan: ReviewPlan | null, units: Units): string {
  // The plan's sessions are on hold during an open pause, also one opened after the week: never "run
  // them as planned" while ill, hurt or away.
  const open = pauseNow(week);
  if (open !== null) {
    const since = `Training has been paused since ${formatLocalDate(open.startDate)}.`;
    if (open.reason === "break") {
      return `${since} Tap I'm back on Today when you are ready to train. ${SAFETY}`;
    }
    return `${since} Rest until you feel well, then tap I'm back on Today. ${PROFESSIONAL}`;
  }
  const { pause } = week;
  const unwell = pause !== null && pause.reason !== "break";
  if (plan === null) {
    return `There is no plan for the coming week. Keep your runs easy, or set a goal on Plan to get one. ${SAFETY}`;
  }
  const live = liveSessions(plan.sessions);
  if (live.length === 0) return `Nothing is planned for the coming week. ${SAFETY}`;
  const distanceM = live.reduce((sum, session) => sum + session.distanceM, 0);
  const coming = `Coming week: ${count(live.length, "session")}, ${formatDistance(distanceM, units)}${keySession(live, units)}.`;
  const care = unwell ? `${SAFETY} ${PROFESSIONAL}` : SAFETY;
  return `${coming} Run them as planned; missed sessions are not made up. ${care}`;
}

export function buildWeeklyReviewFallback(
  week: ReviewWeek,
  plan: ReviewPlan | null,
  settings: ReviewSettings,
  reason: WeeklyReviewFallbackReason,
): WeeklyReview {
  const { units } = settings;
  return {
    headline: headlineOf(week, units),
    whatHappened: whatHappenedOf(week, units),
    whatItMeans: whatItMeansOf(week, plan, units, reason),
    nextWeek: nextWeekOf(week, plan, units),
  };
}
