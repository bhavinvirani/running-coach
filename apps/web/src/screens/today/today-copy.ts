import type { SyncResponse } from "@running-coach/shared";
import { formatCount } from "@/lib/format";

/** Sentences on Today that depend on data, so the wording is read and changed in one place. */
export const todayCopy = {
  noNewRuns: "No new runs on Garmin.",
} as const;

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
