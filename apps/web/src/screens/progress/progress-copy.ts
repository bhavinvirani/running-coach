import type { ImportProgress, ImportStatus, PersonalBestsResponse } from "@running-coach/shared";
import { errorCodeMessage } from "@/lib/errors";
import { formatCount, formatDate, formatMonthYear, formatTime } from "@/lib/format";

/** Every sentence and label on Progress, so the wording is read and changed in one place. */
export const progressCopy = {
  title: "Progress",
  loading: "Loading your runs",
  loadingEarlierWeeks: "Loading earlier weeks",
  /** No runs and no import yet: the sentence carries the one Import history. */
  empty: "Import your Garmin history to see your runs by week.",
  /** No runs while the import line above already says what the import is doing. */
  emptyWithImport: "No runs yet.",
  importRegion: "History import",
  importHistory: "Import history",
  resumeImport: "Resume import",
  importAgain: "Import again",
  showEarlierWeeks: "Show earlier weeks",
  indoor: "Indoor",
  manual: "Manual",
  weekRuns: "Runs",
  personalBests: "Personal bests",
  loadingPersonalBests: "Loading personal bests",
  /** A distance no run has covered yet in one continuous stretch. */
  noRunYet: "No run yet",
  /** On a best set within the last week. */
  newBest: "New",
} as const;

/** The button each import status offers, named for what it does; none while the import moves by itself. */
export function importAction(status: ImportStatus): string | null {
  switch (status) {
    case "not_started":
      return progressCopy.importHistory;
    case "stalled":
    case "failed":
      return progressCopy.resumeImport;
    case "done":
      return progressCopy.importAgain;
    case "running":
    case "paused":
      return null;
  }
}

function runs(count: number): string {
  return formatCount(count, "run", "runs");
}

/** The one line at the top of Progress that says where the import is, with times in the runner's zone. */
export function importLine(progress: ImportProgress, timeZone: string): string {
  switch (progress.status) {
    case "not_started":
      return "Import your full Garmin history.";
    case "running":
      return progress.oldestDate === null
        ? "Importing history · starting"
        : `Importing history · ${runs(progress.runsStored)} · back to ${formatMonthYear(progress.oldestDate)}`;
    case "paused":
      return progress.resumeAt === null
        ? "Garmin is limiting requests. The import continues later."
        : `Garmin is limiting requests. The import continues after ${formatTime(progress.resumeAt, timeZone)}.`;
    case "stalled":
      return "The import stopped. Resume import to carry on where it left off.";
    case "failed":
      return errorCodeMessage(progress.errorCode);
    case "done":
      return progress.finishedAt === null
        ? `${runs(progress.runsStored)} · history imported`
        : `${runs(progress.runsStored)} · history imported ${formatDate(progress.finishedAt, timeZone)}`;
  }
}

/**
 * The line under Personal bests; `stopped` (no run is being checked right now, for a known reason) makes it
 * an error sentence rather than a caption.
 */
export type PendingBestsLine = { text: string; stopped: boolean };

/**
 * The line under Personal bests while runs wait for their best efforts, null once none do. A known reason
 * none are being checked comes first, in the words the import line uses for a failed import, which name
 * what to do ("Reconnect in Settings"): with no job it is why the check stopped, and with a job held back
 * (a 429's hour, a retry's backoff) the failure that holds it, so the line never counts runs that nothing
 * checks for an hour. Otherwise a job counts them as it checks, or, with no job and no reason known, the
 * line says the next sync, which queues the work again, checks them.
 */
export function pendingBestsLine({
  pendingRuns,
  checking,
  errorCode,
}: Pick<PersonalBestsResponse, "pendingRuns" | "checking" | "errorCode">): PendingBestsLine | null {
  if (pendingRuns === 0) return null;
  if (errorCode !== null) return { text: errorCodeMessage(errorCode), stopped: true };
  if (checking) return { text: `Checking ${runs(pendingRuns)} for best efforts`, stopped: false };
  return { text: `The next sync checks ${runs(pendingRuns)} for best efforts.`, stopped: false };
}

/** Garmin's own record for a distance, already formatted, beside the app's: "Garmin 27:05". */
export function garminRecordLine(time: string): string {
  return `Garmin ${time}`;
}
