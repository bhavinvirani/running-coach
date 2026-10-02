import { syncResponseSchema, type MeResponse, type SyncResponse } from "@running-coach/shared";
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
  type MutationState,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { bootRetry } from "@/app/query-client";
import { apiFetch } from "./client";
import { meQueryOptions } from "./me";
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
    // learn of the best-efforts job the sync queued, which starts their poll, and a run already checked
    // gets its PB chip. Returned, so the sync stays pending until the new run is on screen: no
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

/**
 * Opening the app syncs at most once per this interval. Each sync is a round of Garmin calls, and Garmin
 * answers too many with a 429 that holds for an hour; a runner who opens the app every few minutes gains
 * nothing from more, and the daily cron covers the days the app stays shut. It counts from the last sync
 * and from this device's last attempt, so a failed sync (Garmin outage, 429) is not retried on every open.
 */
export const SYNC_ON_OPEN_INTERVAL_MS = 10 * 60_000;

function attemptStorageKey(userId: string): string {
  return `running-coach:sync-on-open:${userId}`;
}

/**
 * This device's app-open attempts by user id, kept beside localStorage for when it throws (storage blocked
 * or full): one map per QueryClient, which lives as long as the page.
 */
const attemptsInMemory = new WeakMap<QueryClient, Map<string, number>>();

function attemptsFor(queryClient: QueryClient): Map<string, number> {
  let attempts = attemptsInMemory.get(queryClient);
  if (!attempts) {
    attempts = new Map();
    attemptsInMemory.set(queryClient, attempts);
  }
  return attempts;
}

function storedAttempt(userId: string): number | undefined {
  try {
    const stored = localStorage.getItem(attemptStorageKey(userId));
    return stored === null ? undefined : Number(stored);
  } catch {
    // Storage blocked or missing: the copy in memory is the record for this page.
    return undefined;
  }
}

function lastAttemptAt(queryClient: QueryClient, userId: string): number | undefined {
  const times = [attemptsFor(queryClient).get(userId), storedAttempt(userId)].filter(
    (time): time is number => time !== undefined && Number.isFinite(time),
  );
  return times.length > 0 ? Math.max(...times) : undefined;
}

function recordAttempt(queryClient: QueryClient, userId: string, at: number): void {
  attemptsFor(queryClient).set(userId, at);
  try {
    localStorage.setItem(attemptStorageKey(userId), String(at));
  } catch {
    // Storage blocked, missing or full: the copy in memory holds the attempt until the page reloads.
  }
}

/**
 * Either side of now: a clock set back (the device's, or the server's against it) must not hold syncs off
 * until it catches up, and the attempt record still caps them at one per interval.
 */
function isRecent(at: number | undefined, now: number): boolean {
  return at !== undefined && Math.abs(now - at) < SYNC_ON_OPEN_INTERVAL_MS;
}

/**
 * Runs Sync now when the app opens and when it returns to the foreground (the installed PWA resumed), so the
 * newest run is on Today without a tap, its progress and errors shown like Sync now's. It syncs only when
 * Garmin is connected and working, no sync runs, and both the last sync and this device's last attempt are
 * SYNC_ON_OPEN_INTERVAL_MS old. The attempt is recorded before the call, which also keeps StrictMode's second
 * effect from sending another. Back in the foreground it asks /api/me first: the cache may be hours old,
 * and the cron or another device may have synced since. Call it once, in the authenticated layout.
 */
export function useSyncOnOpen() {
  const queryClient = useQueryClient();
  const { mutate } = useSyncNow();

  useEffect(() => {
    let unmounted = false;
    const syncRunning = () => queryClient.isMutating({ mutationKey: syncKey }) > 0;

    const syncIfDue = async (fresh: boolean) => {
      // Within the interval of this device's attempt, or with a sync running, there is nothing to ask.
      const cached = queryClient.getQueryData(meQueryOptions().queryKey);
      if (
        syncRunning() ||
        (cached && isRecent(lastAttemptAt(queryClient, cached.user.id), Date.now()))
      ) {
        return;
      }
      let me: MeResponse;
      try {
        me = fresh
          ? // A server asleep after 15 idle minutes is the usual state on return; ride out its wake.
            await queryClient.fetchQuery({ ...meQueryOptions(), staleTime: 0, ...bootRetry() })
          : // On open the authenticated loader has just cached it.
            await queryClient.ensureQueryData(meQueryOptions());
      } catch {
        // No user, no decision: skip this open. The query cache's onError has sent a 401 to /login.
        return;
      }
      const now = Date.now();
      const due =
        !unmounted &&
        me.garmin.status === "ok" &&
        !syncRunning() &&
        !isRecent(
          me.garmin.lastSyncAt === null ? undefined : Date.parse(me.garmin.lastSyncAt),
          now,
        ) &&
        !isRecent(lastAttemptAt(queryClient, me.user.id), now);
      if (!due) return;
      recordAttempt(queryClient, me.user.id, now);
      mutate();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void syncIfDue(true);
    };

    void syncIfDue(false);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      unmounted = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [queryClient, mutate]);
}
