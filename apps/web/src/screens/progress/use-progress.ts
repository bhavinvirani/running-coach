import { useMemo } from "react";
import { useActivityWeeks } from "@/api/activities";
import { useImportProgress, useStartImport } from "@/api/import";
import { useSettings } from "@/api/me";
import { NO_RUN_BESTS, bestDistancesByRun, usePersonalBests } from "@/api/personal-bests";
import { screenState } from "@/api/screen-state";

/**
 * Everything Progress reads and does: runs by week, the import's progress, and starting or resuming it,
 * and the personal bests. The weeks decide the screen's state; the import line has its own load error,
 * shown as an inline alert, so a failed GET /api/import never hides the runs; the bests load and fail on
 * their own in their section, and the rows get their PB chips once they are in. Neither holds for a first
 * answer this version cannot read: like any first load, it throws to the route's boundary
 * (throwOnFirstLoadMismatch), since only a reload into the server's version can show it. Units and zone
 * come from /api/me, which the authenticated loader caches before any tab renders.
 */
export function useProgressScreen() {
  const weeks = useActivityWeeks();
  const settings = useSettings();
  const progress = useImportProgress();
  const start = useStartImport();
  const bests = usePersonalBests();
  const imported = screenState(progress);
  const weeksState = screenState(weeks);
  const runBests = useMemo(
    () => (bests.data ? bestDistancesByRun(bests.data.bests) : NO_RUN_BESTS),
    [bests.data],
  );

  return {
    ...weeksState,
    settings: settings.data,
    personalBests: screenState(bests),
    /** When the bests were read: "New" is measured from it, which keeps the render pure. */
    bestsCheckedAt: bests.dataUpdatedAt,
    /** The distances each run holds as bests, by activity id; empty while the bests load or fail. */
    runBests,
    importProgress: progress.data,
    importLoading: imported.status === "pending",
    /** The import's first load or a poll failed; the line keeps what it last knew. */
    importError: imported.status === "error" ? imported.error : imported.refetchError,
    /** Reloads whatever failed in the background: the weeks, the import, or both. */
    retryBackground: () => {
      if (weeksState.refetchError) void weeks.refetch();
      if (imported.status !== "success" || imported.refetchError) void progress.refetch();
    },
    startImport: () => start.mutate(),
    starting: start.isPending,
    startError: start.error,
    hasEarlierWeeks: weeks.hasNextPage,
    loadingEarlierWeeks: weeks.isFetchingNextPage,
    earlierWeeksError: weeks.isFetchNextPageError ? weeks.error : null,
    showEarlierWeeks: () => void weeks.fetchNextPage(),
  };
}
