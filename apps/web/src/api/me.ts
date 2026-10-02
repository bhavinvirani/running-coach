import {
  meResponseSchema,
  type MeResponse,
  type Settings,
  type UpdateSettingsRequest,
} from "@running-coach/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { detailKey } from "./query-keys";

/** GET /api/me. Shared by the hooks below and the authenticated route loader. */
export function meQueryOptions() {
  return queryOptions({
    queryKey: detailKey("me"),
    queryFn: ({ signal }) => apiFetch("/api/me", { schema: meResponseSchema, signal }),
    staleTime: 60_000,
  });
}

export function useMe() {
  return useQuery(meQueryOptions());
}

const selectSettings = (me: MeResponse): Settings => me.settings;

/** The user's units, time zone and coach detail, for converting and formatting values. */
export function useSettings() {
  return useQuery({ ...meQueryOptions(), select: selectSettings });
}

const selectGarmin = (me: MeResponse): MeResponse["garmin"] => me.garmin;

/** The Garmin connection's status and last sync. */
export function useGarminConnection() {
  return useQuery({ ...meQueryOptions(), select: selectGarmin });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: UpdateSettingsRequest) =>
      apiFetch("/api/me/settings", { method: "PATCH", body: changes, schema: meResponseSchema }),
    // PATCH answers with the whole MeResponse, so the cache takes it as is: no second GET.
    onSuccess: (me) => queryClient.setQueryData(detailKey("me"), me),
  });
}
