import {
  moveSessionResponseSchema,
  sessionDetailResponseSchema,
  type CustomSessionInput,
  type MoveSessionRequest,
  type MoveSessionResponse,
  type SessionDetailResponse,
} from "@running-coach/shared";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { pushPollInterval, refreshSessionViews } from "./calendar";
import { apiFetch } from "./client";
import { detailKey } from "./query-keys";

export function sessionKey(id: string) {
  return detailKey("sessions", id);
}

/** GET /api/sessions/:id: the session, the paces its zones read and the push status. */
export function sessionQueryOptions(id: string) {
  return queryOptions({
    queryKey: sessionKey(id),
    queryFn: ({ signal }) =>
      apiFetch(`/api/sessions/${encodeURIComponent(id)}`, {
        schema: sessionDetailResponseSchema,
        signal,
      }),
  });
}

/** One session, read again every few seconds while a push runs, so its Garmin caption follows it. */
export function useSession(id: string) {
  return useQuery({
    ...sessionQueryOptions(id),
    refetchInterval: (query) => pushPollInterval(query.state.data?.garmin),
  });
}

/**
 * Every change answers with the whole session detail, which goes straight into the session's cache; the
 * other views refresh in the background, since the change also queued a push. A move's warning is the
 * mutation's data, not the session's.
 */
function storeSession(
  queryClient: QueryClient,
  { session, paces, garmin }: SessionDetailResponse | MoveSessionResponse,
): void {
  const key = sessionKey(session.id);
  queryClient.setQueryData<SessionDetailResponse>(key, { session, paces, garmin });
  void refreshSessionViews(queryClient, key);
}

/**
 * A read of the session in flight (the poll while a push runs) answers with the session from before the
 * change; landing after it, it would put that one back.
 */
function cancelReads(queryClient: QueryClient, id: string): Promise<void> {
  return queryClient.cancelQueries({ queryKey: sessionKey(id) });
}

/** POST /api/sessions: a workout the runner built. Without an active plan it answers 409 plan_missing. */
export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomSessionInput) =>
      apiFetch("/api/sessions", {
        method: "POST",
        body: input,
        schema: sessionDetailResponseSchema,
      }),
    onSuccess: (response) => storeSession(queryClient, response),
  });
}

/** PUT /api/sessions/:id: a custom workout changed in the builder; plan sessions answer session_locked. */
export function useUpdateSession(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomSessionInput) =>
      apiFetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: input,
        schema: sessionDetailResponseSchema,
      }),
    onMutate: () => cancelReads(queryClient, id),
    onSuccess: (response) => storeSession(queryClient, response),
  });
}

/**
 * POST /api/sessions/:id/move: another day of the session's week from today on. Never refused for its
 * spacing: the answer's warning says when it now sits too close to another hard session.
 */
export function useMoveSession(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => {
      const body: MoveSessionRequest = { date };
      return apiFetch(`/api/sessions/${encodeURIComponent(id)}/move`, {
        method: "POST",
        body,
        schema: moveSessionResponseSchema,
      });
    },
    onMutate: () => cancelReads(queryClient, id),
    onSuccess: (response) => storeSession(queryClient, response),
  });
}

/**
 * DELETE /api/sessions/:id: Skip session for a plan session, Delete workout for a custom one. Either ends
 * skipped, never made up; a custom one then leaves the calendar and the plan.
 */
export function useSkipSession(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        schema: sessionDetailResponseSchema,
      }),
    onMutate: () => cancelReads(queryClient, id),
    onSuccess: (response) => storeSession(queryClient, response),
  });
}
