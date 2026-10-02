import type { MeResponse } from "@running-coach/shared";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { bootRetry } from "@/app/query-client";
import { meQueryOptions } from "./me";
import { isSyncRunning, useSyncNow } from "./sync";

/**
 * Opening the app syncs at most once per this interval. Each sync is a round of Garmin calls, and Garmin
 * answers too many with a 429 that holds for an hour; a runner who opens the app every few minutes gains
 * nothing from more, and the daily cron covers the days the app stays shut. It counts from the last sync
 * and from this device's last attempt, so a failed sync (Garmin outage, 429) is not retried on every open.
 */
export const SYNC_ON_OPEN_INTERVAL_MS = 10 * 60_000;

/** Where this device keeps its last app-open attempt; exported so e2e can open the app without a sync. */
export function attemptStorageKey(userId: string): string {
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

    const syncIfDue = async (fresh: boolean) => {
      // Within the interval of this device's attempt, or with a sync running, there is nothing to ask. Unless
      // the cached login does not work: a reconnect from the laptop since then only shows in a fresh /api/me,
      // which Today needs to swap Reconnect Garmin back for Sync now. That read costs no Garmin call.
      const cached = queryClient.getQueryData(meQueryOptions().queryKey);
      if (
        isSyncRunning(queryClient) ||
        (cached?.garmin.status === "ok" &&
          isRecent(lastAttemptAt(queryClient, cached.user.id), Date.now()))
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
        !isSyncRunning(queryClient) &&
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
