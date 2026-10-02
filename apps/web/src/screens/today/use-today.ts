import { useLatestActivity } from "@/api/activities";
import { useSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";
import { useLatestSync, useSyncNow } from "@/api/sync";

/**
 * Everything Today reads and does: the latest run, the units to show it in, and Sync now. Units come from
 * /api/me, which the authenticated route's loader caches before any tab renders; until they are known the
 * screen keeps its skeleton rather than flash the wrong unit. The sync's progress and outcome come from
 * the mutation cache, so leaving Today mid-sync and coming back still shows "Syncing…", then its result.
 */
export function useTodayScreen() {
  const latest = useLatestActivity();
  const settings = useSettings();
  const { mutate } = useSyncNow();
  const sync = useLatestSync();

  return {
    ...screenState(latest),
    units: settings.data?.units,
    syncing: sync.syncing,
    syncError: sync.error,
    nothingNew: sync.result?.activitiesWritten === 0,
    syncNow: () => mutate(),
  };
}
