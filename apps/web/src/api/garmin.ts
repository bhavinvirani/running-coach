import {
  disconnectGarminResponseSchema,
  garminLoginConnectedSchema,
  startGarminLoginResponseSchema,
  type DisconnectGarminQuery,
  type FinishGarminLoginRequest,
  type GarminStatus,
  type MeResponse,
  type StartGarminLoginRequest,
} from "@running-coach/shared";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { refreshSessionViews } from "./calendar";
import { apiFetch } from "./client";
import { detailKey, resourceKey } from "./query-keys";
import { useSyncNow } from "./sync";

/**
 * Carries a Garmin password or code to its one request and lets go of it there. TanStack Query keeps a
 * mutation's variables in the mutation cache for minutes after it ends, where devtools show them, so the
 * login's variables are this holder, empty from the moment the request is sent.
 */
export class SentOnce<T> {
  #value: T | undefined;

  constructor(value: T) {
    this.#value = value;
  }

  take(): T {
    const value = this.#value;
    if (value === undefined) throw new Error("A Garmin sign-in is sent once.");
    this.#value = undefined;
    return value;
  }
}

/** The cached /api/me with another Garmin status, shown at once while the API's own answer is read again. */
function setGarminStatus(queryClient: QueryClient, status: GarminStatus): void {
  queryClient.setQueryData<MeResponse>(
    detailKey("me"),
    (me) => me && { ...me, garmin: { ...me.garmin, status } },
  );
}

/**
 * A login that connected. The status turns ok in the cache before the sync starts, so
 * useForgetSyncOutcomeOnReconnect, which sees the move a render later, drops only the earlier syncs'
 * outcomes ("Garmin login expired"): this one is still pending then, since a sync stays pending until the
 * reads after it return. The sync is Sync now's own request, so Today shows its progress and outcome: its scope queues
 * it behind a sync already running in this tab, and the API's single-flight sync joins one running on the
 * server. The connection queued a push, which every session view shows, and /api/me is read for the
 * API's own word.
 */
function connected(queryClient: QueryClient, syncNow: () => void): void {
  setGarminStatus(queryClient, "ok");
  syncNow();
  void queryClient.invalidateQueries({ queryKey: resourceKey("me") });
  void refreshSessionViews(queryClient);
}

/**
 * POST /api/garmin/login: the Garmin account's email and password, passed once to Garmin and never stored.
 * Answers code_needed when Garmin sent a two-factor code (useFinishGarminLogin), or connected. Never
 * retried: a 429 from Garmin must not be repeated, and Garmin counts every failed sign-in.
 */
export function useStartGarminLogin() {
  const queryClient = useQueryClient();
  const { mutate: syncNow } = useSyncNow();
  return useMutation({
    mutationFn: (request: SentOnce<StartGarminLoginRequest>) =>
      apiFetch("/api/garmin/login", {
        method: "POST",
        body: request.take(),
        schema: startGarminLoginResponseSchema,
      }),
    onSuccess: (answer) => {
      if (answer.status === "connected") connected(queryClient, () => syncNow());
    },
  });
}

/**
 * POST /api/garmin/login/code: the two-factor code for the login the runner started. 422
 * garmin_mfa_rejected keeps that login for another code; 409 garmin_login_lost means it is gone (5 min, a
 * restart, too many wrong codes) and the runner starts again. Never retried, like the start.
 */
export function useFinishGarminLogin() {
  const queryClient = useQueryClient();
  const { mutate: syncNow } = useSyncNow();
  return useMutation({
    mutationFn: (request: SentOnce<FinishGarminLoginRequest>) =>
      apiFetch("/api/garmin/login/code", {
        method: "POST",
        body: request.take(),
        schema: garminLoginConnectedSchema,
      }),
    onSuccess: () => connected(queryClient, () => syncNow()),
  });
}

/**
 * DELETE /api/garmin/connection?workouts=remove|keep. remove first takes the app's workouts from today on
 * off Garmin and needs a working login; keep only forgets the login. Runs and plans stay.
 */
export function useDisconnectGarmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (query: DisconnectGarminQuery) =>
      apiFetch(`/api/garmin/connection?${new URLSearchParams(query).toString()}`, {
        method: "DELETE",
        schema: disconnectGarminResponseSchema,
      }),
    onSuccess: () => setGarminStatus(queryClient, "not_connected"),
    // Also after a failure: a removal Garmin turned down marks the login expired, which leaves keep as the
    // only way out, and one that failed partway already took some workouts off the watch. Not returned, so
    // the screen shows the outcome without waiting for these reads.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: resourceKey("me") });
      void refreshSessionViews(queryClient);
    },
  });
}
