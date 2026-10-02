import { syncResponseSchema, type SyncResponse } from "@running-coach/shared";
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
  type MutationState,
} from "@tanstack/react-query";
import { apiFetch } from "./client";
import { actionKey, resourceKey } from "./query-keys";

const syncKey = actionKey("sync");

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
    // Kept until the next sync starts, so Today shows the outcome however long the runner was elsewhere.
    gcTime: Number.POSITIVE_INFINITY,
    onMutate: () => {
      const mutations = queryClient.getMutationCache();
      for (const earlier of mutations.findAll({ mutationKey: syncKey })) {
        if (earlier.state.status !== "pending") mutations.remove(earlier);
      }
    },
    mutationFn: () => apiFetch("/api/sync", { method: "POST", schema: syncResponseSchema }),
    // Also after a failure: a 429 or 502 partway through has already stored the chunks before it. A failed
    // sync can also mark the Garmin login expired, which Settings should show without a reload. The bests
    // learn of the new runs waiting for their best efforts, which starts their poll, and a run already
    // checked gets its PB chip. Returned, so the sync stays pending until the new run is on screen: no
    // flash of the old one.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: resourceKey("activities") }),
        queryClient.invalidateQueries({ queryKey: resourceKey("me") }),
        queryClient.invalidateQueries({ queryKey: resourceKey("personal-bests") }),
      ]),
  });
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
