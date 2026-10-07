import { PUSH_WINDOW_DAYS } from "@running-coach/shared";
import { useMemo, useState } from "react";
import { useLatestActivity } from "@/api/activities";
import { useCalendar, useSendToGarmin, useUnscheduleGarmin } from "@/api/calendar";
import { useGarminConnection, useGarminConnectionSeen, useSettings } from "@/api/me";
import { useEndPause, usePause, useStartPause } from "@/api/pause";
import { NO_RUN_BESTS, bestDistancesByRun, usePersonalBests } from "@/api/personal-bests";
import { useLatestReview, useReviewFeedback } from "@/api/reviews";
import { screenState } from "@/api/screen-state";
import { useLatestSync, useSyncNow } from "@/api/sync";
import { addDays, today } from "@/lib/dates";
import type { SendState } from "@/components/garmin-push-line";
import type { UnscheduleState } from "./parts/other-garmin-workouts";
import type { PauseState } from "./parts/use-pause-flow";
import type { WeeklyReviewState } from "./parts/weekly-review";
import { syncOutcomeLine } from "./today-copy";

/**
 * Everything Today reads and does: the latest run, the units to show it in, the bests it holds, Sync now,
 * and whether the Garmin login expired, which turns Sync now into Reconnect Garmin. Units and the login
 * come from /api/me, which the authenticated route's loader caches before any tab renders; until they are
 * known the screen keeps its skeleton rather than flash the wrong unit. The bests only add
 * the PB chip: the run shows without it while they load, poll after a sync or fail, unless their first
 * answer is one this version cannot read, which throws to the route's boundary like any first load
 * (throwOnFirstLoadMismatch), since only a reload into the server's version can show it. The sync's
 * progress and outcome come from the mutation cache, so leaving Today mid-sync and coming back still shows
 * "Syncing…", then its result. The next 7 days come from the calendar, today to six days on in the
 * runner's time zone, with Send to Garmin and Unschedule for the workouts the app did not create. With an
 * active plan (the calendar answers its paces) the open pause is read too, with Pause training and I'm
 * back; a runner without a plan has nothing to pause, so it is never asked for. The coach's weekly review
 * loads beside the run, polls while the coach writes it, and takes thumbs.
 */
export function useTodayScreen() {
  const latest = useLatestActivity();
  const settings = useSettings();
  const garmin = useGarminConnection();
  const bests = usePersonalBests();
  const { mutate } = useSyncNow();
  const sync = useLatestSync();
  const day = settings.data === undefined ? undefined : today(settings.data.timezone);
  const calendar = useCalendar(
    day ?? "",
    day === undefined ? "" : addDays(day, PUSH_WINDOW_DAYS - 1),
    day !== undefined,
  );
  const send = useSendToGarmin();
  const unschedule = useUnscheduleGarmin();
  const pause = usePause(calendar.data !== undefined && calendar.data.paces !== null);
  const startPause = useStartPause();
  const endPause = useEndPause();
  const latestReview = useLatestReview();
  const reviewFeedback = useReviewFeedback();
  // The header's Reconnect Garmin is the only place Today says why its sessions are not on Garmin.
  useGarminConnectionSeen(calendar.data?.garmin.connection);
  // Kept here rather than read from the mutation, which forgets one workout's error when the next starts.
  const [unscheduleFailures, setUnscheduleFailures] = useState<ReadonlyMap<number, Error>>(
    () => new Map(),
  );
  const runBests = useMemo(
    () => (bests.data ? bestDistancesByRun(bests.data.bests) : NO_RUN_BESTS),
    [bests.data],
  );

  return {
    ...screenState(latest),
    units: settings.data?.units,
    /** The distances each run holds as bests, by activity id; empty until the bests load. */
    runBests,
    garminExpired: garmin.data?.status === "expired",
    syncing: sync.syncing,
    syncError: sync.error,
    /** The line a sync that ended well leaves: runs it removed, or that it found nothing. */
    syncOutcome: sync.result === undefined ? null : syncOutcomeLine(sync.result),
    syncNow: () => mutate(),
    /** The runner's local date; undefined until the settings are known. */
    today: day,
    timeZone: settings.data?.timezone,
    calendar: screenState(calendar),
    send: {
      sending: send.isPending,
      error: send.error,
      onSend: () => send.mutate(),
    } satisfies SendState,
    unschedule: {
      pendingId: unschedule.isPending ? unschedule.variables : null,
      failures: unscheduleFailures,
      onUnschedule: (scheduleId: number) => {
        // One at a time: a second call would take over the mutation and hide the first's state.
        if (unschedule.isPending) return;
        setUnscheduleFailures((failures) => withoutKey(failures, scheduleId));
        unschedule.mutate(scheduleId, {
          onError: (error) =>
            setUnscheduleFailures((failures) => new Map(failures).set(scheduleId, error)),
        });
      },
    } satisfies UnscheduleState,
    pause: {
      state: screenState(pause),
      starting: startPause.isPending,
      startError: startPause.error,
      onStart: (reason, onStarted) => {
        // A new pause makes the last I'm back's line stale.
        endPause.reset();
        startPause.mutate(reason, { onSuccess: onStarted });
      },
      onChoose: () => startPause.reset(),
      ending: endPause.isPending,
      endError: endPause.error,
      onEnd: (onEnded) =>
        endPause.mutate(undefined, { onSuccess: (response) => onEnded(response.reEntry) }),
      reEntry: endPause.data?.reEntry ?? null,
    } satisfies PauseState,
    review: {
      state: screenState(latestReview),
      // The owner on the Claude plan has a credential without a saved key.
      hasCredential: settings.data !== undefined && settings.data.coachCredential !== "none",
      setFeedback: (reviewId, feedback) => reviewFeedback.mutate({ reviewId, feedback }),
      feedbackError: reviewFeedback.error,
    } satisfies WeeklyReviewState,
  };
}

function withoutKey<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}
