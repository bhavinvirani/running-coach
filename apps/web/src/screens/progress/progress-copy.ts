import type { ImportProgress, ImportStatus } from "@running-coach/shared";
import { errorCodeMessage } from "@/lib/errors";
import { formatCount, formatDate, formatMonthYear, formatTime } from "@/lib/format";

/** Every sentence and label on Progress, so the wording is read and changed in one place. */
export const progressCopy = {
  title: "Progress",
  loading: "Loading your runs",
  loadingEarlierWeeks: "Loading earlier weeks",
  /** No runs and no import yet: the sentence carries the one Import history. */
  empty: "No runs yet. Import your Garmin history to see them by week.",
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
      return "The import stopped making progress.";
    case "failed":
      return errorCodeMessage(progress.errorCode);
    case "done":
      return progress.finishedAt === null
        ? `${runs(progress.runsStored)} · history imported`
        : `${runs(progress.runsStored)} · history imported ${formatDate(progress.finishedAt, timeZone)}`;
  }
}
