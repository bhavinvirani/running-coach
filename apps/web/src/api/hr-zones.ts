import { hrZonesResponseSchema, type HrZones, type HrZonesResponse } from "@running-coach/shared";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { apiFetch } from "./client";
import { detailKey, resourceKey } from "./query-keys";

export const hrZonesKey = detailKey("hr-zones");

/** GET /api/hr-zones: the zones in use and where they come from; none before any run has a max HR. */
export function hrZonesQueryOptions() {
  return queryOptions({
    queryKey: hrZonesKey,
    queryFn: ({ signal }) => apiFetch("/api/hr-zones", { schema: hrZonesResponseSchema, signal }),
  });
}

export function useHrZones() {
  return useQuery(hrZonesQueryOptions());
}

/**
 * Both writes answer with the zones now in use, which go into the cache as they are. Run detail counts
 * each run's time in zone from the zones in use, so every run is read again.
 */
function storeZones(queryClient: QueryClient, response: HrZonesResponse): void {
  queryClient.setQueryData(hrZonesKey, response);
  void queryClient.invalidateQueries({ queryKey: resourceKey("activities") });
}

/** PUT /api/hr-zones: saves the runner's own zones; 400 validation when they break the contract. */
export function useSaveHrZones() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (zones: HrZones) =>
      apiFetch("/api/hr-zones", { method: "PUT", body: zones, schema: hrZonesResponseSchema }),
    onSuccess: (response) => storeZones(queryClient, response),
  });
}

/** DELETE /api/hr-zones (Reset to Garmin's): forgets the runner's zones, so Garmin's are used again. */
export function useResetHrZones() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch("/api/hr-zones", { method: "DELETE", schema: hrZonesResponseSchema }),
    onSuccess: (response) => storeZones(queryClient, response),
  });
}
