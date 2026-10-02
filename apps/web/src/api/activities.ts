import {
  activityWeeksResponseSchema,
  latestActivityResponseSchema,
  type Activity,
  type ActivityWeek,
  type ActivityWeeksResponse,
  type LatestActivityResponse,
} from "@running-coach/shared";
import { queryOptions, useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { detailKey, listKey } from "./query-keys";

/** GET /api/activities/latest: the run with the latest start, or null before the first sync stored one. */
export function latestActivityQueryOptions() {
  return queryOptions({
    queryKey: detailKey("activities", "latest"),
    queryFn: ({ signal }) =>
      apiFetch("/api/activities/latest", { schema: latestActivityResponseSchema, signal }),
  });
}

const selectActivity = (response: LatestActivityResponse): Activity | null => response.activity;

export function useLatestActivity() {
  return useQuery({ ...latestActivityQueryOptions(), select: selectActivity });
}

/** Weeks per page: two months of training at a glance; the API caps it at 26. */
export const WEEKS_PER_PAGE = 8;

function activityWeeksPath(before: string | undefined): string {
  const params = new URLSearchParams({ weeks: String(WEEKS_PER_PAGE) });
  if (before !== undefined) params.set("before", before);
  return `/api/activities?${params.toString()}`;
}

const selectWeeks = (
  data: InfiniteData<ActivityWeeksResponse, string | undefined>,
): ActivityWeek[] => data.pages.flatMap((page) => page.weeks);

/**
 * GET /api/activities: runs by week, newest first, a page of whole weeks at a time, so a week's total is
 * never split. Each page asks for the weeks before the previous page's `nextBefore`; a refetch walks the
 * pages again from the newest, so runs an import or sync adds land in the right week.
 */
export function useActivityWeeks() {
  return useInfiniteQuery({
    queryKey: listKey("activities", "weeks"),
    queryFn: ({ pageParam, signal }) =>
      apiFetch(activityWeeksPath(pageParam), { schema: activityWeeksResponseSchema, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    select: selectWeeks,
  });
}
