import {
  distanceKeySchema,
  personalBestsResponseSchema,
  type DistanceKey,
  type PersonalBest,
  type PersonalBestsResponse,
} from "@running-coach/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { listKey } from "./query-keys";

export const personalBestsKey = listKey("personal-bests");

/**
 * How often the bests are read again while runs still wait for their best efforts. The job fills the list
 * in the background, within minutes of a sync and over about half an hour after the first import, so a
 * faster poll would show nothing sooner and only load the free server.
 */
export const PERSONAL_BESTS_POLL_MS = 15_000;

export function personalBestsPollInterval(
  response: PersonalBestsResponse | undefined,
): number | false {
  return response !== undefined && response.pendingRuns > 0 ? PERSONAL_BESTS_POLL_MS : false;
}

/** GET /api/personal-bests: the runner's bests, Garmin's records and the runs still being checked. */
export function personalBestsQueryOptions() {
  return queryOptions({
    queryKey: personalBestsKey,
    queryFn: ({ signal }) =>
      apiFetch("/api/personal-bests", { schema: personalBestsResponseSchema, signal }),
  });
}

/** The bests, polled while runs wait for their best efforts and not at all once none do. */
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
