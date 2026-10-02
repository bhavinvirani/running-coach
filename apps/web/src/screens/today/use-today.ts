import { useMemo } from "react";
import { useLatestActivity } from "@/api/activities";
import { useSettings } from "@/api/me";
import { NO_RUN_BESTS, bestDistancesByRun, usePersonalBests } from "@/api/personal-bests";
import { screenState } from "@/api/screen-state";
import { useLatestSync, useSyncNow } from "@/api/sync";

/**
 * Everything Today reads and does: the latest run, the units to show it in, the bests it holds, and Sync
 * now. Units come from /api/me, which the authenticated route's loader caches before any tab renders;
 * until they are known the screen keeps its skeleton rather than flash the wrong unit. The bests only add
 * the PB chip: the run shows without it while they load, poll after a sync or fail. The sync's progress
 * and outcome come from the mutation cache, so leaving Today mid-sync and coming back still shows
 * "Syncing…", then its result.
 */
export function useTodayScreen() {
  const latest = useLatestActivity();
  const settings = useSettings();
  const bests = usePersonalBests();
  const { mutate } = useSyncNow();
  const sync = useLatestSync();
  const runBests = useMemo(
    () => (bests.data ? bestDistancesByRun(bests.data.bests) : NO_RUN_BESTS),
    [bests.data],
  );

  return {
    ...screenState(latest),
    units: settings.data?.units,
    /** The distances each run holds as bests, by activity id; empty until the bests load. */
    runBests,
    syncing: sync.syncing,
    syncError: sync.error,
    nothingNew: sync.result?.activitiesWritten === 0,
    syncNow: () => mutate(),
  };
}
