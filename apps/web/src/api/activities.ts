import {
  ErrorCode,
  activityParamsSchema,
  activityResponseSchema,
  activityWeeksResponseSchema,
  latestActivityResponseSchema,
  type Activity,
  type ActivityResponse,
  type ActivityWeek,
  type ActivityWeeksResponse,
  type LatestActivityResponse,
} from "@running-coach/shared";
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
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

export const activityWeeksKey = listKey("activities", "weeks");

/**
 * GET /api/activities: runs by week, newest first, a page of whole weeks at a time, so a week's total is
 * never split. Each page asks for the weeks before the previous page's `nextBefore`; a refetch walks the
 * pages again from the newest, so runs an import or sync adds land in the right week.
 */
export function useActivityWeeks() {
  return useInfiniteQuery({
    queryKey: activityWeeksKey,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(activityWeeksPath(pageParam), { schema: activityWeeksResponseSchema, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    select: selectWeeks,
  });
}

/** The API takes only uuids; anything else in the address is a run that cannot exist. */
export function activityPath(id: string, rest = ""): string {
  if (!activityParamsSchema.safeParse({ id }).success) {
    throw new ApiError({ status: 404, code: ErrorCode.notFound });
  }
  return `/api/activities/${id}${rest}`;
}

/**
 * GET /api/activities/:id: the run as stored, with `detail` null until POST .../detail has fetched its laps,
 * samples, route and zones from Garmin. A malformed id fails as not found without a request.
 */
export function activityQueryOptions(id: string) {
  return queryOptions({
    queryKey: detailKey("activities", id),
    queryFn: ({ signal }) => apiFetch(activityPath(id), { schema: activityResponseSchema, signal }),
  });
}

export function useActivity(id: string) {
  return useQuery(activityQueryOptions(id));
}

/**
 * POST /api/activities/:id/detail: fetches the run's detail from Garmin once, stores it and answers with the
 * whole run, which replaces the cached GET, so no second request follows. Never retried, like Sync now: a 429
 * from Garmin must not be repeated, and the runner decides when to try again. Idempotent: once stored, the
 * detail is answered without Garmin, so asking again only reads it back.
 */
export function useFetchActivityDetail(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(activityPath(id, "/detail"), {
        method: "POST",
        schema: activityResponseSchema,
        idempotent: true,
      }),
    onSuccess: (response: ActivityResponse) =>
      queryClient.setQueryData(detailKey("activities", id), response),
  });
}
