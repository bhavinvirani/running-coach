import {
  calendarResponseSchema,
  garminPushResponseSchema,
  type GarminPushStatus,
  type UnscheduleGarminRequest,
} from "@running-coach/shared";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { apiFetch } from "./client";
import { listKey, resourceKey } from "./query-keys";

/**
 * How often a screen reads the push status again while workouts go to Garmin: a week's push is a few
 * paced calls, done in seconds to a minute, and the runner is watching for "On Garmin".
 */
export const GARMIN_PUSH_POLL_MS = 3_000;

/** Polls while a push is queued or running, and not at all otherwise. */
export function pushPollInterval(garmin: GarminPushStatus | undefined): number | false {
  return garmin?.pushing === true ? GARMIN_PUSH_POLL_MS : false;
}

/**
 * Every session change on the server queues a push, which changes the sessions' Garmin state wherever they
 * show: Today's next 7 days, the plan's weeks and each session. `keep` is a key just filled with the
 * server's answer, which needs no second read.
 */
export function refreshSessionViews(queryClient: QueryClient, keep?: QueryKey): Promise<unknown> {
  const kept = keep === undefined ? undefined : JSON.stringify(keep);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: resourceKey("calendar") }),
    queryClient.invalidateQueries({ queryKey: resourceKey("plan") }),
    queryClient.invalidateQueries({
      queryKey: resourceKey("sessions"),
      predicate: (query) => JSON.stringify(query.queryKey) !== kept,
    }),
  ]);
}

export function calendarKey(from: string, to: string) {
  return listKey("calendar", from, to);
}

/** GET /api/calendar: the sessions of each day from `from` to `to`, both local dates and included. */
export function calendarQueryOptions(from: string, to: string) {
  return queryOptions({
    queryKey: calendarKey(from, to),
    queryFn: ({ signal }) =>
      apiFetch(`/api/calendar?${new URLSearchParams({ from, to }).toString()}`, {
        schema: calendarResponseSchema,
        signal,
      }),
  });
}

/**
 * The calendar, read again every few seconds while a push runs, so "Sending" turns into "On Garmin".
 * `enabled` waits for the runner's time zone, which decides the dates.
 */
export function useCalendar(from: string, to: string, enabled = true) {
  return useQuery({
    ...calendarQueryOptions(from, to),
    enabled,
    refetchInterval: (query) => pushPollInterval(query.state.data?.garmin),
  });
}

/**
 * POST /api/calendar/push: Send to Garmin. The API queues the push and answers at once with pushing true;
 * the reads it invalidates learn of it and start their poll. Returned, so the button stays busy until
 * they have. Never retried: a 429 from Garmin must not be repeated, and the runner decides when to try.
 */
export function useSendToGarmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch("/api/calendar/push", { method: "POST", schema: garminPushResponseSchema }),
    onSuccess: () => refreshSessionViews(queryClient),
  });
}

/**
 * POST /api/calendar/unschedule: takes one workout the app did not create off the Garmin calendar; the
 * workout itself stays in the runner's Garmin library. It runs in the request, so it can answer the
 * garmin_* errors; the screen keeps each beside its workout and runs one unschedule at a time.
 */
export function useUnscheduleGarmin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scheduleId: number) => {
      const body: UnscheduleGarminRequest = { scheduleIds: [scheduleId] };
      return apiFetch("/api/calendar/unschedule", {
        method: "POST",
        body,
        schema: garminPushResponseSchema,
      });
    },
    // Returned, so the workout's row stays busy until the calendar read without it lands: no flash back.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: resourceKey("calendar") }),
  });
}
