import {
  ErrorCode,
  activityShoeSchema,
  shoeParamsSchema,
  shoesResponseSchema,
  type ActivityResponse,
  type ActivityShoe,
  type CreateShoeRequest,
  type ShoeInput,
  type ShoesResponse,
} from "@running-coach/shared";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { activityPath } from "./activities";
import { ApiError, apiFetch } from "./client";
import { detailKey, listKey, resourceKey } from "./query-keys";

export const shoesKey = listKey("shoes");

/**
 * GET /api/shoes: every pair with its totals, the active one first, then the pairs in use newest first, then
 * the retired ones. A pair's screen reads its pair from this list, so there is no GET of one pair.
 */
export function shoesQueryOptions() {
  return queryOptions({
    queryKey: shoesKey,
    queryFn: ({ signal }) => apiFetch("/api/shoes", { schema: shoesResponseSchema, signal }),
  });
}

export function useShoes() {
  return useQuery(shoesQueryOptions());
}

/** The API takes only uuids; anything else in the address is a pair that cannot exist. */
function shoePath(id: string, rest = ""): string {
  if (!shoeParamsSchema.safeParse({ id }).success) {
    throw new ApiError({ status: 404, code: ErrorCode.notFound });
  }
  return `/api/shoes/${id}${rest}`;
}

/** Every change of a pair answers with the whole list, which goes into the cache as it is. */
function storeShoes(queryClient: QueryClient, response: ShoesResponse): void {
  queryClient.setQueryData(shoesKey, response);
}

/** POST /api/shoes; `active` makes the new pair the one the sync puts on new runs. */
export function useCreateShoe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateShoeRequest) =>
      apiFetch("/api/shoes", { method: "POST", body, schema: shoesResponseSchema }),
    onSuccess: (response) => storeShoes(queryClient, response),
  });
}

/** PUT /api/shoes/:id: names, colour, retire distance and distance before the app. */
export function useUpdateShoe(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ShoeInput) =>
      apiFetch(shoePath(id), { method: "PUT", body, schema: shoesResponseSchema }),
    onSuccess: (response) => storeShoes(queryClient, response),
  });
}

/**
 * POST /api/shoes/:id/active: the sync puts this pair on new runs from now on. A retired pair comes back
 * in use.
 */
export function useActivateShoe(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(shoePath(id, "/active"), { method: "POST", schema: shoesResponseSchema }),
    onSuccess: (response) => storeShoes(queryClient, response),
  });
}

/** POST /api/shoes/:id/retire: the pair stops being active; its runs keep it. */
export function useRetireShoe(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(shoePath(id, "/retire"), { method: "POST", schema: shoesResponseSchema }),
    onSuccess: (response) => storeShoes(queryClient, response),
  });
}

/** DELETE /api/shoes/:id: the pair's runs stay and lose their pair, so every cached run is read again. */
export function useDeleteShoe(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(shoePath(id), { method: "DELETE", schema: shoesResponseSchema }),
    onSuccess: (response) => {
      storeShoes(queryClient, response);
      void queryClient.invalidateQueries({ queryKey: resourceKey("activities") });
    },
  });
}

/**
 * PUT /api/activities/:id/shoe: the pair the run wore, null for none. The answer goes into the cached run
 * as its shoeId, so the run is not read again; each pair's totals change, so the list is. One run's changes
 * go out one after another (the scope): arrow keys in the choice save at every step, and answers arriving
 * out of order would leave the run showing a pair the server no longer has on it.
 */
export function useSetRunShoe(activityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: `run-shoe-${activityId}` },
    mutationFn: (shoeId: string | null) => {
      const body: ActivityShoe = { shoeId };
      return apiFetch(activityPath(activityId, "/shoe"), {
        method: "PUT",
        body,
        schema: activityShoeSchema,
      });
    },
    onSuccess: ({ shoeId }) => {
      queryClient.setQueryData<ActivityResponse>(detailKey("activities", activityId), (run) =>
        run === undefined ? run : { ...run, shoeId },
      );
      void queryClient.invalidateQueries({ queryKey: resourceKey("shoes") });
    },
  });
}
