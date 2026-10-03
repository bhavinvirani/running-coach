import { syncResponseSchema, type SyncResponse } from "@running-coach/shared";
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
  type MutationState,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { apiFetch } from "./client";
import { useGarminConnection } from "./me";
import { actionKey, resourceKey } from "./query-keys";

const syncKey = actionKey("sync");

/** Drops the outcome of every sync that has ended; a running sync stays, and so does its outcome later. */
function forgetSyncOutcome(queryClient: QueryClient): void {
  const mutations = queryClient.getMutationCache();
  for (const sync of mutations.findAll({ mutationKey: syncKey })) {
    if (sync.state.status !== "pending") mutations.remove(sync);
  }
}

/**
 * POST /api/sync: Sync now. The API answers when the sync is done (up to about a minute), and apiFetch sets
 * no timeout of its own, so a slow Garmin never looks like a failure here. Never retried: a 429 from
 * Garmin must not be repeated, and the runner decides when to try again. Read its progress and outcome
 * with useLatestSync, which outlives the screen that started it.
 */
export function useSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: syncKey,
    // One sync at a time: a tap from a remounted screen waits for the running one instead of racing it.
    scope: { id: "sync" },
    // Kept until the next sync starts or Garmin is reconnected (useForgetSyncOutcomeOnReconnect), so Today
    // shows the outcome however long the runner was elsewhere.
    gcTime: Number.POSITIVE_INFINITY,
    onMutate: () => forgetSyncOutcome(queryClient),
    mutationFn: () => apiFetch("/api/sync", { method: "POST", schema: syncResponseSchema }),
    // Also after a failure: a 429 or 502 partway through has already stored the chunks before it. A failed
    // sync can also mark the Garmin login expired, which Settings should show without a reload. The bests
    // learn of the best-efforts job the sync queued, which starts their poll, and a run already checked
    // gets its PB chip. Returned, so the sync stays pending until the new run is on screen: no
    // flash of the old one. A sync that removed runs deleted on Garmin also unlinked them from the plan's
    // sessions, so the plan and each session are read again too.
    onSettled: (result) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: resourceKey("activities") }),
        queryClient.invalidateQueries({ queryKey: resourceKey("me") }),
        queryClient.invalidateQueries({ queryKey: resourceKey("personal-bests") }),
        ...(result !== undefined && result.activitiesRemoved > 0
          ? [
              queryClient.invalidateQueries({ queryKey: resourceKey("plan") }),
              queryClient.invalidateQueries({ queryKey: resourceKey("sessions") }),
            ]
          : []),
      ]),
  });
}

/** Whether a sync runs now, for code outside React (useSyncOnOpen's decision). */
export function isSyncRunning(queryClient: QueryClient): boolean {
  return queryClient.isMutating({ mutationKey: syncKey }) > 0;
}

type SyncState = MutationState<SyncResponse, Error>;

/** Whether a sync runs, and how the newest one ended, from the mutation cache rather than one screen's hook. */
export function useLatestSync() {
  const syncing = useIsMutating({ mutationKey: syncKey }) > 0;
  const newest = useMutationState<SyncState>({
    filters: { mutationKey: syncKey },
    select: (mutation) => mutation.state,
  }).at(-1);
  return {
    syncing,
    error: newest?.status === "error" ? newest.error : null,
    result: newest?.status === "success" ? newest.data : undefined,
  };
}

/**
 * Forgets the ended syncs' outcomes once /api/me's Garmin status moves from expired or not connected to ok,
 * which only a reconnect or a first connect from the laptop does: after it, an earlier sync's "Garmin login
 * expired" or "not connected" is false, and Today shows Sync now. A first rejected login answers
 * garmin_auth_expired while the status stays ok, so its error stays, as does any outcome when /api/me is
 * read again unchanged. The status of the first render (page load) is no move, and a running sync stays.
 * Call it once, in the tab shell, which stays mounted while Today comes and goes.
 */
export function useForgetSyncOutcomeOnReconnect() {
  const queryClient = useQueryClient();
  const status = useGarminConnection().data?.status;
  const previous = useRef(status);

  useEffect(() => {
    const before = previous.current;
    previous.current = status;
    if (status === "ok" && before !== undefined && before !== "ok") forgetSyncOutcome(queryClient);
  }, [queryClient, status]);
}
