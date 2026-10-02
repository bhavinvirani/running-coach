import {
  distanceKeySchema,
  personalBestsResponseSchema,
  type DistanceKey,
  type PersonalBest,
  type PersonalBestsResponse,
} from "@running-coach/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { IMPORT_POLL_PAUSED_MS } from "./import";
import { listKey } from "./query-keys";

export const personalBestsKey = listKey("personal-bests");

/**
 * How often the bests are read again while a best-efforts job is waiting or running. The job fills the
 * list in the background, within minutes of a sync and over about half an hour after the first import, so
 * a faster poll would show nothing sooner and only load the free server.
 */
export const PERSONAL_BESTS_POLL_MS = 15_000;

/**
 * How often the bests are read while their job is held back (a 429's hour, a retry's backoff): nothing
 * changes for minutes, as with an import paused by Garmin, so the same rate.
 */
export const PERSONAL_BESTS_HELD_POLL_MS = IMPORT_POLL_PAUSED_MS;

/**
 * Polls on `checking`, not on pending runs: runs can stay pending with no job to check them (an expired
 * Garmin login, a failed pass), and reading every 15 s then would change nothing. A sync or an import page
 * invalidates the bests, and that read learns of the job they queued and starts the poll again. A job with
 * an `errorCode` is held back by that failure, so it is read rarely until it runs again.
 */
export function personalBestsPollInterval(
  response: PersonalBestsResponse | undefined,
): number | false {
  if (response?.checking !== true) return false;
  return response.errorCode === null ? PERSONAL_BESTS_POLL_MS : PERSONAL_BESTS_HELD_POLL_MS;
}

/** GET /api/personal-bests: the runner's bests and the runs still waiting to be checked. */
export function personalBestsQueryOptions() {
  return queryOptions({
    queryKey: personalBestsKey,
    queryFn: ({ signal }) =>
      apiFetch("/api/personal-bests", { schema: personalBestsResponseSchema, signal }),
  });
}

/** The bests, polled while a best-efforts job is waiting, held or running and not at all otherwise. */
export function usePersonalBests() {
  return useQuery({
    ...personalBestsQueryOptions(),
    refetchInterval: (query) => personalBestsPollInterval(query.state.data),
  });
}

/** The distances one run holds as current bests, shortest first. */
export type RunBests = ReadonlyMap<string, readonly DistanceKey[]>;

/** One shared empty list, so a run without a best keeps the same props from render to render. */
export const NO_BESTS: readonly DistanceKey[] = [];

export const NO_RUN_BESTS: RunBests = new Map();

/**
 * The distances each run holds as current bests, by activity id, for the PB chip on run rows and Today.
 * Walks the distances in the contract's order, so the chip reads "PB 5K, 10K" however the list is sorted.
 */
export function bestDistancesByRun(bests: readonly PersonalBest[]): RunBests {
  const runByDistance = new Map(bests.map((best) => [best.distanceKey, best.activityId]));
  const byRun = new Map<string, DistanceKey[]>();
  for (const key of distanceKeySchema.options) {
    const activityId = runByDistance.get(key);
    if (activityId === undefined) continue;
    byRun.set(activityId, [...(byRun.get(activityId) ?? []), key]);
  }
  return byRun;
}
