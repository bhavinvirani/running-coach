import { useActivityWeeks } from "@/api/activities";
import { useImportProgress, useStartImport } from "@/api/import";
import { useSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";

/**
 * Everything Progress reads and does: runs by week, the import's progress, and starting or resuming it.
 * The weeks decide the screen's state; the import line has its own load error, shown as an inline alert,
 * so a failed GET /api/import never hides the runs. Units and zone come from /api/me, which the
 * authenticated loader caches before any tab renders.
 */
export function useProgressScreen() {
  const weeks = useActivityWeeks();
  const settings = useSettings();
  const progress = useImportProgress();
  const start = useStartImport();
  const imported = screenState(progress);
  const weeksState = screenState(weeks);

  return {
    ...weeksState,
    settings: settings.data,
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
