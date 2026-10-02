import {
  latestActivityResponseSchema,
  type Activity,
  type LatestActivityResponse,
} from "@running-coach/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { detailKey } from "./query-keys";

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
