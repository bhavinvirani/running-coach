import {
  distanceInUnits,
  type ReviewWeekSummary,
  type SessionStatus,
  type Units,
} from "@running-coach/shared";
import {
  formatCountValue,
  formatDayTime,
  formatDistance,
  formatDistanceValue,
  formatDuration,
} from "./format";

/** Every sentence and label of the weekly review, on Today, the review list and a review alike. */
export const reviewCopy = {
  title: "Weekly review",
  listTitle: "Weekly reviews",
  loadingList: "Loading your weekly reviews",
  loadingReview: "Loading the weekly review",
  whatHappened: "What happened",
  whatItMeans: "What it means",
  nextWeek: "Next week",
  changes: "Plan changes",
  comingWeek: "Coming week",
  /** Beside the week's dates when a pause covered any of its days. */
  paused: "Training paused",
  /** The sync that found the week ended queued the review; Today polls until it is written. */
  pending: "The coach is writing your weekly review.",
  /** Claude failed and the job tries again later, like the run's "Coach unavailable, will retry". */
  unavailable: "Coach unavailable, will retry your weekly review.",
  /** The job waits for the owner's Claude plan usage limit to reset; `when` in the runner's zone. */
  planLimit: (when: string) =>
    `Your Claude plan's usage limit is reached. The coach writes your weekly review ${when}.`,
  empty: "No weekly reviews yet: the coach writes one after each week ends.",
  openPlan: "Open plan",
  /** Opens the list of reviews, newest week first: from Today's card, Plan and a review that is gone. */
  openList: "Open weekly reviews",
} as const;

/** The plan-limit line with the reset as "Mon 12 Oct, 14:00" in the runner's time zone. */
export function planLimitLine(resumesAt: string, timeZone: string): string {
  return reviewCopy.planLimit(formatDayTime(resumesAt, timeZone));
}

export type WeekStat = { label: string; value: string; unit?: string };

/**
 * The three numbers of a reviewed week, in the runner's unit: Distance run of planned ("31.4", "of 38.0
 * km"), Sessions done of planned ("4", "of 5") and Time ("3:04:12"). A week with nothing planned (no plan
 * yet, or only rest) counts its runs instead of "0 of 0" sessions, and its distance stands alone.
 */
export function weekStats(summary: ReviewWeekSummary, units: Units): WeekStat[] {
  const distance = formatDistanceValue(distanceInUnits(summary.distanceM, units));
  const planned =
    summary.plannedDistanceM > 0
      ? `of ${formatDistance(distanceInUnits(summary.plannedDistanceM, units), units)}`
      : units;
  const sessions: WeekStat =
    summary.sessionsPlanned > 0
      ? {
          label: "Sessions",
          value: formatCountValue(summary.sessionsDone),
          unit: `of ${formatCountValue(summary.sessionsPlanned)}`,
        }
      : { label: "Runs", value: formatCountValue(summary.runs) };
  return [
    { label: "Distance", value: distance, unit: planned },
    sessions,
    { label: "Time", value: formatDuration(summary.durationS) },
  ];
}

const STATUS_WORDS: Partial<Record<SessionStatus, string>> = {
  done: "Done",
  missed: "Missed",
  skipped: "Skipped",
};

/** What happened to a session of the coming week, for its preview row; null while it is still to come. */
export function comingSessionState(status: SessionStatus): string | null {
  return STATUS_WORDS[status] ?? null;
}
