import { useLatestActivity } from "@/api/activities";
import { useSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";
import { useSyncNow } from "@/api/sync";

/**
 * Everything Today reads and does: the latest run, the units to show it in, and Sync now. Units come from
 * /api/me, which the authenticated route's loader caches before any tab renders; until they are known the
 * screen keeps its skeleton rather than flash the wrong unit.
 */
export function useTodayScreen() {
  const latest = useLatestActivity();
  const settings = useSettings();
  const sync = useSyncNow();

  return {
    ...screenState(latest),
    units: settings.data?.units,
    syncing: sync.isPending,
    syncError: sync.error,
    syncNow: () => sync.mutate(),
  };
}
