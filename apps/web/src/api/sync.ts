import { syncResponseSchema } from "@running-coach/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { resourceKey } from "./query-keys";

/**
 * POST /api/sync: Sync now. The API answers when the sync is done (up to about a minute), and apiFetch sets
 * no timeout of its own, so a slow Garmin never looks like a failure here. Never retried: a 429 from
 * Garmin must not be repeated, and the runner decides when to try again.
 */
export function useSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/api/sync", { method: "POST", schema: syncResponseSchema }),
    // Returned, so the mutation stays pending until the new run is on screen: no flash of the old one.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: resourceKey("activities") }),
        queryClient.invalidateQueries({ queryKey: resourceKey("me") }),
      ]),
    // A failed sync can mark the Garmin login expired on the server; Settings should show it without a reload.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: resourceKey("me") });
    },
  });
}
