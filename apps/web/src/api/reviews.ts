import {
  ErrorCode,
  latestReviewResponseSchema,
  reviewListResponseSchema,
  reviewParamsSchema,
  reviewResponseSchema,
  type CoachFeedback,
  type LatestReviewResponse,
  type ReviewFeedbackRequest,
  type ReviewResponse,
} from "@running-coach/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import { INSIGHT_PENDING_POLL_MS, INSIGHT_RETRYING_POLL_MS } from "./insights";
import { detailKey, listKey } from "./query-keys";

/** The review Today shows: the newest one while its coming week holds today, or where it stands. */
export const latestReviewKey = detailKey("reviews", "latest");
export const reviewListKey = listKey("reviews");

export function reviewKey(id: string) {
  return detailKey("reviews", id);
}

/**
 * The sync that found the week ended queued the review, and the runner is on Today: read again every few
 * seconds while the coach writes, like the run's card.
 */
export const REVIEW_PENDING_POLL_MS = INSIGHT_PENDING_POLL_MS;
/** Claude failed and the job tries again over about an hour: a minute between reads is plenty. */
export const REVIEW_RETRYING_POLL_MS = INSIGHT_RETRYING_POLL_MS;

/** Polls while the coach writes or will retry, and not at all once there is a review, or none coming. */
export function latestReviewPollInterval(
  response: LatestReviewResponse | undefined,
): number | false {
  if (response?.state === "pending") return REVIEW_PENDING_POLL_MS;
  if (response?.state === "retrying") return REVIEW_RETRYING_POLL_MS;
  return false;
}

/** GET /api/reviews/latest: the review for Today, or whether one is being written. */
export function latestReviewQueryOptions() {
  return queryOptions({
    queryKey: latestReviewKey,
    queryFn: ({ signal }) =>
      apiFetch("/api/reviews/latest", { schema: latestReviewResponseSchema, signal }),
  });
}

/** Today's review, read again while the coach writes it or waits to retry. */
export function useLatestReview() {
  return useQuery({
    ...latestReviewQueryOptions(),
    refetchInterval: (query) => latestReviewPollInterval(query.state.data),
  });
}

/** GET /api/reviews: every review the coach wrote for the runner, newest week first. */
export function reviewListQueryOptions() {
  return queryOptions({
    queryKey: reviewListKey,
    queryFn: ({ signal }) => apiFetch("/api/reviews", { schema: reviewListResponseSchema, signal }),
  });
}

export function useReviews() {
  return useQuery(reviewListQueryOptions());
}

/** The API takes only uuids; anything else in the address is a review that cannot exist. */
function reviewPath(id: string): string {
  if (!reviewParamsSchema.safeParse({ id }).success) {
    throw new ApiError({ status: 404, code: ErrorCode.notFound });
  }
  return `/api/reviews/${id}`;
}

/** GET /api/reviews/:id: one review with its coming week as it stands now; 404 when not the runner's. */
export function reviewQueryOptions(id: string) {
  return queryOptions({
    queryKey: reviewKey(id),
    queryFn: ({ signal }) => apiFetch(reviewPath(id), { schema: reviewResponseSchema, signal }),
  });
}

export function useReview(id: string) {
  return useQuery(reviewQueryOptions(id));
}

type FeedbackChange = { reviewId: string; feedback: CoachFeedback | null };

const feedbackMutationKey = ["review-feedback"] as const;

function detailWithFeedback(
  response: ReviewResponse | undefined,
  feedback: CoachFeedback | null,
): ReviewResponse | undefined {
  return response === undefined ? undefined : { review: { ...response.review, feedback } };
}

/** Today's review with the new thumb, when it is the review tapped; anything else as it is. */
function latestWithReview(
  latest: LatestReviewResponse | undefined,
  reviewId: string,
  change: (review: ReviewResponse["review"]) => ReviewResponse["review"],
): LatestReviewResponse | undefined {
  if (latest?.state !== "ready" || latest.review.id !== reviewId) return latest;
  return { state: "ready", review: change(latest.review) };
}

/**
 * PUT /api/reviews/:id/feedback: thumbs up, down, or null to clear, from Today or the review screen. Shown
 * at once on the review's detail and on Today's card when it is the same review; taps go out one after
 * another in the order they were made. As with a run's card (useInsightFeedback), only the last tap still
 * saving for the review settles the cache: its answer becomes the detail and Today's card. When the last
 * fails, a lone tap puts back what was shown before it, and both are read again either way. The list
 * shows no thumbs but is read again after a saved one, so it never holds a review older than the detail.
 */
export function useReviewFeedback() {
  const queryClient = useQueryClient();
  // This mutation is pending while its own callbacks run, and so is every queued tap after it.
  const othersPending = (reviewId: string) =>
    queryClient.isMutating({
      mutationKey: feedbackMutationKey,
      predicate: (mutation) =>
        (mutation.state.variables as FeedbackChange | undefined)?.reviewId === reviewId,
    }) > 1;
  return useMutation({
    mutationKey: feedbackMutationKey,
    scope: { id: "review-feedback" },
    mutationFn: ({ reviewId, feedback }: FeedbackChange) => {
      const body: ReviewFeedbackRequest = { feedback };
      return apiFetch(`${reviewPath(reviewId)}/feedback`, {
        method: "PUT",
        body,
        schema: reviewResponseSchema,
      });
    },
    onMutate: async ({ reviewId, feedback }) => {
      // Counted before the await, while no later tap can have joined.
      const alone = !othersPending(reviewId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: reviewKey(reviewId) }),
        queryClient.cancelQueries({ queryKey: latestReviewKey }),
      ]);
      const previousDetail = queryClient.getQueryData<ReviewResponse>(reviewKey(reviewId));
      const previousLatest = queryClient.getQueryData<LatestReviewResponse>(latestReviewKey);
      queryClient.setQueryData<ReviewResponse>(reviewKey(reviewId), (detail) =>
        detailWithFeedback(detail, feedback),
      );
      queryClient.setQueryData<LatestReviewResponse>(latestReviewKey, (latest) =>
        latestWithReview(latest, reviewId, (review) => ({ ...review, feedback })),
      );
      return alone ? { previousDetail, previousLatest } : {};
    },
    onError: (_error, { reviewId }, context) => {
      if (othersPending(reviewId)) return;
      if (context?.previousDetail !== undefined) {
        queryClient.setQueryData(reviewKey(reviewId), context.previousDetail);
      }
      if (context?.previousLatest !== undefined) {
        queryClient.setQueryData(latestReviewKey, context.previousLatest);
      }
      void queryClient.invalidateQueries({ queryKey: reviewKey(reviewId) });
      void queryClient.invalidateQueries({ queryKey: latestReviewKey });
    },
    onSuccess: (response, { reviewId }) => {
      void queryClient.invalidateQueries({ queryKey: reviewListKey });
      if (othersPending(reviewId)) return;
      queryClient.setQueryData(reviewKey(reviewId), response);
      queryClient.setQueryData<LatestReviewResponse>(latestReviewKey, (latest) =>
        latestWithReview(latest, reviewId, () => response.review),
      );
    },
  });
}
