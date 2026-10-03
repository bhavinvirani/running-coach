import {
  meResponseSchema,
  type ClaudeKeyRequest,
  type GarminStatus,
  type MeResponse,
  type Settings,
  type UpdateSettingsRequest,
} from "@running-coach/shared";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { apiFetch } from "./client";
import { detailKey, resourceKey } from "./query-keys";

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

/**
 * Reads /api/me again when another response (the calendar, polled while a push runs) reports a Garmin
 * connection other than the cached one, which can be up to a minute old: the login expired, or came back.
 * Once per disagreement, so an /api/me that still disagrees is not read in a loop.
 */
export function useGarminConnectionSeen(seen: GarminStatus | undefined) {
  const queryClient = useQueryClient();
  const cached = useGarminConnection().data?.status;
  useEffect(() => {
    if (seen === undefined || cached === undefined || seen === cached) return;
    void queryClient.invalidateQueries({ queryKey: detailKey("me") });
  }, [seen, cached, queryClient]);
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

/**
 * Saving or removing the Claude key answers with the whole MeResponse. Every run's coach state turns on the
 * key (no_key or none, a fallback card's action), so the cached ones are read again.
 */
function storeKeyChange(queryClient: QueryClient, me: MeResponse): void {
  queryClient.setQueryData(detailKey("me"), me);
  void queryClient.invalidateQueries({ queryKey: resourceKey("insights") });
}

/**
 * PUT /api/me/claude-key: the API checks the key with Claude and stores it encrypted, or answers 422
 * claude_key_invalid (rejected) or 502 claude_unavailable (no answer) and stores nothing. Never retried:
 * the check is rate limited, and the runner decides when to try again.
 */
export function useSaveClaudeKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => {
      const body: ClaudeKeyRequest = { key: key.trim() };
      return apiFetch("/api/me/claude-key", { method: "PUT", body, schema: meResponseSchema });
    },
    onSuccess: (me) => storeKeyChange(queryClient, me),
  });
}

/** DELETE /api/me/claude-key: the coach stops until a key is saved again. */
export function useRemoveClaudeKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch("/api/me/claude-key", { method: "DELETE", schema: meResponseSchema }),
    onSuccess: (me) => storeKeyChange(queryClient, me),
  });
}
