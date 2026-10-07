import type { PauseReason, ReEntry, SyncResponse } from "@running-coach/shared";
import { formatCount, formatLocalDay, formatPercent } from "@/lib/format";

/** Sentences on Today that depend on data, so the wording is read and changed in one place. */
export const todayCopy = {
  noNewRuns: "No new runs on Garmin.",
  notFeeling: "Not feeling 100%",
  pauseQuestion: "Pause your training? Sessions from today come off your watch until you are back.",
  pauseReason: "Reason",
  pauseTraining: "Pause training",
  keepTraining: "Keep training",
  notMedicalAdvice: "This is not medical advice.",
  imBack: "I'm back",
  /** The paused card's title: "Training paused since Thu 8 Oct". */
  pausedSince: (startDate: string) => `Training paused since ${formatLocalDay(startDate)}`,
} as const;

/** The three ways to say "Not feeling 100%", in the order the runner reads them. */
export const PAUSE_REASON_LABELS: Readonly<Record<PauseReason, string>> = {
  sick: "Sick",
  injured: "Pain or injury",
  break: "Need a break",
};

/**
 * Fixed advice for each reason, never the coach's: a pause asks no model, so illness and injury always get
 * the same rest advice and the same pointer to a doctor or physio.
 */
export const PAUSE_ADVICE: Readonly<Record<PauseReason, string>> = {
  sick: "Rest while you are ill. Run again once you have had no fever for a day and an easy walk feels normal. See a doctor if it lasts more than a week, or straight away for chest pain or trouble breathing.",
  injured:
    "Stop running on it. Pain that changes how you walk or run, swelling, or pain that lasts more than a few days needs a doctor or physio. Come back once you can walk without pain.",
  break: "Take the time you need. When you come back, the plan restarts gently.",
};

/** Sick and injured carry health advice, which says it is not medical advice; a break carries none. */
export function isHealthReason(reason: PauseReason): boolean {
  return reason !== "break";
}

/** The most the plan grows each week on the way back (the engine's 10% rule), for the re-entry line. */
const WEEKLY_BUILD = 0.1;

/**
 * The line after I'm back: how the plan restarts. Eased by days off ("9 days off: the next sessions are
 * eased to 70% and build back up by at most 10% a week. The next 7 days are walk-run."), only walk-run
 * after a short illness or injury, else unchanged. Walk-run covers the 7 days from the return, not the
 * Monday-to-Sunday week, so the line counts days.
 */
export function reEntryLine(reEntry: ReEntry): string {
  if (reEntry.factor < 1) {
    const eased = `${formatCount(reEntry.daysOff, "day", "days")} off: the next sessions are eased to ${formatPercent(reEntry.factor)} and build back up by at most ${formatPercent(WEEKLY_BUILD)} a week.`;
    return reEntry.walkRun ? `${eased} The next 7 days are walk-run.` : eased;
  }
  return reEntry.walkRun
    ? "The next 7 days are walk-run, then the plan carries on."
    : "Your plan carries on as planned.";
}

/**
 * The line under Sync now once a sync ended well: the runs it removed because Garmin no longer lists them,
 * else that it found nothing; null when it brought runs in, which show for themselves. A run deleted on
 * Garmin and one changed there to another sport both leave the list, so the line names neither cause.
 */
export function syncOutcomeLine(result: SyncResponse): string | null {
  if (result.activitiesRemoved > 0) {
    return `Removed ${formatCount(result.activitiesRemoved, "run", "runs")} Garmin no longer lists.`;
  }
  return result.activitiesWritten === 0 ? todayCopy.noNewRuns : null;
}
