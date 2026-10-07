import {
  endPauseResponseSchema,
  pauseResponseSchema,
  type PauseReason,
  type PauseResponse,
  type StartPauseRequest,
} from "@running-coach/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { refreshSessionViews } from "./calendar";
import { apiFetch } from "./client";
import { detailKey } from "./query-keys";

export function pauseKey() {
  return detailKey("pause");
}

/** GET /api/pause: the runner's open pause, null while training runs. */
export function pauseQueryOptions() {
  return queryOptions({
    queryKey: pauseKey(),
    queryFn: ({ signal }) => apiFetch("/api/pause", { schema: pauseResponseSchema, signal }),
  });
}

/** The open pause. `enabled` waits for an active plan: without one there is nothing to pause. */
export function usePause(enabled = true) {
  return useQuery({ ...pauseQueryOptions(), enabled });
}

/**
 * POST /api/pause ("Not feeling 100%"): a pause from today, answered with the open pause. Its sessions now
 * read paused and leave the watch, so every view of them is read again first, and the pause goes into its
 * cache once they have: Pause training stays busy until then, and the paused card arrives with the week
 * already paused instead of above sessions that still read as planned.
 */
export function useStartPause() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: PauseReason) => {
      const body: StartPauseRequest = { reason };
      return apiFetch("/api/pause", { method: "POST", body, schema: pauseResponseSchema });
    },
    onSuccess: async (response) => {
      await refreshSessionViews(queryClient);
      queryClient.setQueryData<PauseResponse>(pauseKey(), response);
    },
  });
}

/**
 * POST /api/pause/end ("I'm back"): the sessions left in the pause are skipped and the ones after it eased,
 * so the views of them are read again before the pause closes in the cache, like a start. The answer's
 * reEntry is the mutation's data, for the screen that asked to say how the plan restarts; the pause is
 * closed either way, also when a second tap finds none open.
 */
export function useEndPause() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch("/api/pause/end", { method: "POST", schema: endPauseResponseSchema }),
    onSuccess: async () => {
      await refreshSessionViews(queryClient);
      queryClient.setQueryData<PauseResponse>(pauseKey(), { pause: null });
    },
  });
}
