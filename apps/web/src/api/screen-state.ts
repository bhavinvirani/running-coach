import type { UseQueryResult } from "@tanstack/react-query";

type Refetch<T> = UseQueryResult<T>["refetch"];

/**
 * A query reduced to what a screen renders from, as a union so `status` narrows `data`. "error" means the
 * first load failed and there is nothing to show. Once data has loaded, a failed background refetch keeps
 * "success" and the data, and sets `refetchError` so the screen can add a quiet Retry above it.
 */
export type ScreenState<T> =
  | { status: "pending"; data: undefined; error: null; refetchError: null; refetch: Refetch<T> }
  | { status: "error"; data: undefined; error: Error; refetchError: null; refetch: Refetch<T> }
  | { status: "success"; data: T; error: null; refetchError: Error | null; refetch: Refetch<T> };

export function screenState<T>(query: UseQueryResult<T>): ScreenState<T> {
  const { refetch } = query;
  if (query.isPending) {
    return { status: "pending", data: undefined, error: null, refetchError: null, refetch };
  }
  if (query.isLoadingError) {
    return { status: "error", data: undefined, error: query.error, refetchError: null, refetch };
  }
  return {
    status: "success",
    data: query.data,
    error: null,
    refetchError: query.isRefetchError ? query.error : null,
    refetch,
  };
}
