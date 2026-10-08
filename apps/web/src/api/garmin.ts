import {
  ErrorCode,
  disconnectGarminQuerySchema,
  disconnectGarminResponseSchema,
  garminLoginConnectedSchema,
  startGarminLoginResponseSchema,
  type DisconnectGarminQuery,
  type FinishGarminLoginRequest,
  type GarminStatus,
  type MeResponse,
  type StartGarminLoginRequest,
} from "@running-coach/shared";
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
  type MutationStatus,
  type QueryClient,
} from "@tanstack/react-query";
import { refreshSessionViews } from "./calendar";
import { apiFetch, isApiError } from "./client";
import { actionKey, detailKey, resourceKey } from "./query-keys";
import { useSyncNow } from "./sync";

const loginKey = actionKey("garmin-login");
const startKey = [...loginKey, "start"] as const;
const codeKey = [...loginKey, "code"] as const;
const disconnectKey = actionKey("garmin-disconnect");

/**
 * One change to the Garmin connection at a time, in the order the runner asked for them: a Disconnect
 * tapped while a reconnect runs waits for it, so the login it forgets is the new one.
 */
const connectionScope = { id: "garmin-connection" };

/** How long the Garmin service keeps a login waiting for its code: "within 5 minutes" on the code step. */
export const LOGIN_WAITS_MS = 5 * 60 * 1000;

/**
 * Carries a Garmin password or code to its one request and lets go of it there. TanStack Query keeps a
 * mutation's variables in the mutation cache for minutes after it ends, where devtools show them, and the
 * login's attempts stay there on purpose (useGarminLogin), so the login's variables are this holder, empty
 * from the moment the request is sent.
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
 * retried: a 429 from Garmin must not be repeated, and Garmin counts every failed sign-in. Read whether it
 * runs and what it answered with useGarminLogin, which outlives the screen that sent it (a sign-in can take
 * minutes).
 */
export function useStartGarminLogin() {
  const queryClient = useQueryClient();
  const { mutate: syncNow } = useSyncNow();
  return useMutation({
    mutationKey: startKey,
    scope: connectionScope,
    // Kept at least while Garmin may wait for the code, so the screen opened again finds the code step.
    gcTime: LOGIN_WAITS_MS,
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
 * POST /api/garmin/login/code: the two-factor code for the login the runner started. Whether the Garmin
 * service still holds that login after a failure is codeFailureKeepsLogin's call. Never retried, like the
 * start.
 */
export function useFinishGarminLogin() {
  const queryClient = useQueryClient();
  const { mutate: syncNow } = useSyncNow();
  return useMutation({
    mutationKey: codeKey,
    scope: connectionScope,
    gcTime: LOGIN_WAITS_MS,
    mutationFn: (request: SentOnce<FinishGarminLoginRequest>) =>
      apiFetch("/api/garmin/login/code", {
        method: "POST",
        body: request.take(),
        schema: garminLoginConnectedSchema,
      }),
    onSuccess: () => connected(queryClient, () => syncNow()),
  });
}

/** The failures of a code after which the login may still be held (codeFailureKeepsLogin). */
const CODE_FAILURES_THAT_KEEP: readonly ErrorCode[] = [
  ErrorCode.garminMfaRejected,
  ErrorCode.garminUnavailable,
  ErrorCode.rateLimited,
];

/**
 * Whether the Garmin service may still hold the login after its code failed, so another code can go to it:
 * Garmin turned the code down (garmin_mfa_rejected); the service could not reach Garmin
 * (garmin_unavailable: it answers garmin_login_lost whenever it dropped the login); no answer came back; or
 * the app's own limit refused the code before Garmin was called (rate_limited). Anything else needs a new
 * sign-in: Garmin's 429 (the service always drops the login on one), a lost login, or the API's proof of
 * the new login failing after the code.
 */
export function codeFailureKeepsLogin(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return error.network || CODE_FAILURES_THAT_KEEP.includes(error.code);
}

/** A login Garmin may still wait for the code of: the start that answered code_needed, and when it went out. */
export type WaitingLogin = { id: number; sentAt: number };

type LoginAttempt = {
  id: number;
  step: "start" | "code";
  status: MutationStatus;
  codeNeeded: boolean;
  error: Error | null;
  sentAt: number;
};

/**
 * The newest start, if it answered code_needed and no code after it connected or lost the login. Wrong
 * codes and codes still out leave it waiting.
 */
function waitingLogin(attempts: readonly LoginAttempt[]): WaitingLogin | null {
  for (const attempt of attempts.toReversed()) {
    if (attempt.step === "code") {
      if (attempt.status === "success") return null;
      if (attempt.status === "error" && !codeFailureKeepsLogin(attempt.error)) return null;
      continue;
    }
    return attempt.status === "success" && attempt.codeNeeded
      ? { id: attempt.id, sentAt: attempt.sentAt }
      : null;
  }
  return null;
}

/** Whether Garmin still waits for this login's code: it keeps one 5 min from the start. */
export function stillWaits(login: WaitingLogin, now = Date.now()): boolean {
  return now - login.sentAt < LOGIN_WAITS_MS;
}

/**
 * The Garmin login as the mutation cache holds it rather than one screen's hooks, so the Garmin screen
 * opened again picks it up where it was: whether a start or a code is out, and the login waiting for its
 * code. forget drops the attempts that ended (Start again), so the screen no longer opens on the code step.
 */
export function useGarminLogin() {
  const queryClient = useQueryClient();
  const pending = useIsMutating({ mutationKey: loginKey }) > 0;
  const attempts = useMutationState<LoginAttempt>({
    filters: { mutationKey: loginKey },
    select: (mutation) => ({
      id: mutation.mutationId,
      step: mutation.options.mutationKey?.[1] === "code" ? "code" : "start",
      status: mutation.state.status,
      codeNeeded:
        startGarminLoginResponseSchema.safeParse(mutation.state.data).data?.status ===
        "code_needed",
      error: mutation.state.error,
      sentAt: mutation.state.submittedAt,
    }),
  });
  return {
    pending,
    waiting: waitingLogin(attempts),
    forget: () => {
      const mutations = queryClient.getMutationCache();
      for (const attempt of mutations.findAll({ mutationKey: loginKey })) {
        if (attempt.state.status !== "pending") mutations.remove(attempt);
      }
    },
  };
}

/**
 * DELETE /api/garmin/connection?workouts=remove|keep. remove first takes the app's upcoming workouts (from
 * today on) off Garmin and needs a working login; keep only forgets the login. Runs and plans stay. Read
 * whether it runs with useGarminDisconnecting.
 */
export function useDisconnectGarmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: disconnectKey,
    scope: connectionScope,
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

/**
 * Whether a disconnect runs, and whether it removes the app's workouts (a paced Garmin call each), from the
 * mutation cache, so the Garmin screen opened again while one runs shows it and sends no second.
 */
export function useGarminDisconnecting() {
  const pending = useIsMutating({ mutationKey: disconnectKey }) > 0;
  const running = useMutationState({
    filters: { mutationKey: disconnectKey, status: "pending" },
    select: (mutation) => disconnectGarminQuerySchema.safeParse(mutation.state.variables).data,
  });
  return { pending, removing: running.some((query) => query?.workouts === "remove") };
}
