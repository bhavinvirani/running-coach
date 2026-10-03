import {
  ErrorCode,
  insightParamsSchema,
  insightResponseSchema,
  type CoachFeedback,
  type InsightFeedbackRequest,
  type InsightResponse,
} from "@running-coach/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, isApiError } from "./client";
import { detailKey } from "./query-keys";

/** The coach writes a card in a few seconds to half a minute, and the runner is watching for it. */
export const INSIGHT_PENDING_POLL_MS = 3_000;
/** Claude failed and the job tries again over about an hour: a minute between reads is plenty. */
export const INSIGHT_RETRYING_POLL_MS = 60_000;

/** Polls while the coach writes or will retry, and not at all once there is a card, or none coming. */
export function insightPollInterval(response: InsightResponse | undefined): number | false {
  if (response?.state === "pending") return INSIGHT_PENDING_POLL_MS;
  if (response?.state === "retrying") return INSIGHT_RETRYING_POLL_MS;
  return false;
}

export function insightKey(activityId: string) {
  return detailKey("insights", activityId);
}

/** The API takes only uuids; anything else in the address is a run that cannot exist. */
function insightPath(activityId: string): string {
  if (!insightParamsSchema.safeParse({ id: activityId }).success) {
    throw new ApiError({ status: 404, code: ErrorCode.notFound });
  }
  return `/api/activities/${activityId}/insight`;
}

/** GET /api/activities/:id/insight: the run's coach card, or where it stands. */
export function insightQueryOptions(activityId: string) {
  return queryOptions({
    queryKey: insightKey(activityId),
    queryFn: ({ signal }) =>
      apiFetch(insightPath(activityId), { schema: insightResponseSchema, signal }),
  });
}

/** The run's coach card, read again while the coach writes it or waits to retry. */
export function useInsight(activityId: string) {
  return useQuery({
    ...insightQueryOptions(activityId),
    refetchInterval: (query) => insightPollInterval(query.state.data),
  });
}

/**
 * POST /api/activities/:id/insight: Ask the coach, or Try again after a fallback card. Answers pending (the
 * poll above takes over), or ready when the model's card already exists; 409 claude_key_missing without a
 * key. Never retried: the runner taps again, and the API limits the rate.
 */
export function useAskCoach(activityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(insightPath(activityId), { method: "POST", schema: insightResponseSchema }),
    // A read in flight answers with the card from before the ask; landing after it, it would put that back.
    onMutate: () => queryClient.cancelQueries({ queryKey: insightKey(activityId) }),
    onSuccess: (response) => queryClient.setQueryData(insightKey(activityId), response),
    onError: (error) => {
      // The key was removed on another device: read the card again, which answers no_key and swaps the
      // button that cannot work for Add Claude key.
      if (isApiError(error) && error.code === ErrorCode.claudeKeyMissing) {
        void queryClient.invalidateQueries({ queryKey: insightKey(activityId) });
      }
    },
  });
}

type FeedbackChange = { insightId: string; feedback: CoachFeedback | null };

function withFeedback(
  response: InsightResponse | undefined,
  feedback: CoachFeedback | null,
): InsightResponse | undefined {
  if (response?.state !== "ready") return response;
  return { state: "ready", insight: { ...response.insight, feedback } };
}

function feedbackMutationKey(activityId: string) {
  return ["insight-feedback", activityId] as const;
}

/**
 * PUT /api/insights/:id/feedback: thumbs up, down, or null to clear. Shown at once; one scope per run, so
 * quick taps reach the API in the order they were made. Only the last tap still saving settles the cache:
 * an earlier answer landing would flicker back to that tap, and an earlier failure says nothing about the
 * last one. When the last fails, a lone tap puts back the card from before it, and the card is read again
 * either way, since after several taps no snapshot is the server's (the one before the last tap is the
 * tap before it, maybe never saved).
 */
export function useInsightFeedback(activityId: string) {
  const queryClient = useQueryClient();
  const key = insightKey(activityId);
  const mutationKey = feedbackMutationKey(activityId);
  // This mutation is pending while its own callbacks run, and so is every queued tap after it.
  const othersPending = () => queryClient.isMutating({ mutationKey }) > 1;
  return useMutation({
    mutationKey,
    scope: { id: `insight-feedback:${activityId}` },
    mutationFn: ({ insightId, feedback }: FeedbackChange) => {
      const body: InsightFeedbackRequest = { feedback };
      return apiFetch(`/api/insights/${encodeURIComponent(insightId)}/feedback`, {
        method: "PUT",
        body,
        schema: insightResponseSchema,
      });
    },
    onMutate: async ({ feedback }) => {
      // Counted before the await, while no later tap can have joined.
      const alone = !othersPending();
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InsightResponse>(key);
      queryClient.setQueryData<InsightResponse>(key, withFeedback(previous, feedback));
      return { previous: alone ? previous : undefined };
    },
    onError: (_error, _change, context) => {
      if (othersPending()) return;
      if (context?.previous !== undefined) queryClient.setQueryData(key, context.previous);
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onSuccess: (response) => {
      if (othersPending()) return;
      queryClient.setQueryData(key, response);
    },
  });
}
