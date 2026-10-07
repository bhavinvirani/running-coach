import { ErrorCode, type LatestReviewResponse, type ReviewResponse } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, never, problem, stubFetch } from "@/test/fake-api";
import {
  REVIEW_ID,
  latestReviewReadyFixture,
  reviewListFixture,
  reviewResponseFixture,
  weeklyReviewCardFixture,
} from "@/test/fixtures-weekly-review";
import { holdPolls } from "@/test/held-polls";
import { testQueryClient } from "@/test/render";
import {
  REVIEW_PENDING_POLL_MS,
  REVIEW_RETRYING_POLL_MS,
  latestReviewKey,
  reviewKey,
  reviewListKey,
  useLatestReview,
  useReview,
  useReviewFeedback,
  useReviews,
} from "./reviews";

const polls = holdPolls();

function wrapper() {
  const queryClient = testQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

const withFeedback = (feedback: "up" | "down" | null) =>
  reviewResponseFixture(weeklyReviewCardFixture({ feedback }));

const latestFeedback = (data: LatestReviewResponse | undefined) =>
  data?.state === "ready" ? data.review.feedback : undefined;

const detailFeedback = (data: ReviewResponse | undefined) => data?.review.feedback;

describe("review query keys", () => {
  it("are [reviews, detail, latest], [reviews, list] and [reviews, detail, id]", () => {
    expect(latestReviewKey).toEqual(["reviews", "detail", "latest"]);
    expect(reviewListKey).toEqual(["reviews", "list"]);
    expect(reviewKey(REVIEW_ID)).toEqual(["reviews", "detail", REVIEW_ID]);
  });
});

describe("useLatestReview", () => {
  it("reads Today's review from /api/reviews/latest and does not poll a ready one", async () => {
    const calls = stubFetch(() => json(latestReviewReadyFixture()));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useLatestReview(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/reviews/latest" });
    expect(queryClient.getQueryData(latestReviewKey)).toEqual(latestReviewReadyFixture());
    expect(polls.delays()).toEqual([]);
  });

  it("reads again every 3 s while the coach writes and stops once the review is ready (pending)", async () => {
    let answer: LatestReviewResponse = { state: "pending" };
    stubFetch(() => json(answer));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useLatestReview(), { wrapper: Wrapper });

    await waitFor(() => expect(polls.delays()).toEqual([REVIEW_PENDING_POLL_MS]));
    expect(REVIEW_PENDING_POLL_MS).toBe(3_000);
    answer = latestReviewReadyFixture();
    act(() => polls.fire());

    await waitFor(() => expect(result.current.data?.state).toBe("ready"));
    await waitFor(() => expect(polls.delays()).toEqual([]));
  });

  it("reads again every minute while Claude is down and the job will retry (retrying)", async () => {
    stubFetch(() => json({ state: "retrying" }));
    const { Wrapper } = wrapper();
    renderHook(() => useLatestReview(), { wrapper: Wrapper });

    await waitFor(() => expect(polls.delays()).toEqual([REVIEW_RETRYING_POLL_MS]));
    expect(REVIEW_RETRYING_POLL_MS).toBe(60_000);
  });

  it("does not poll when there is no review to show (none)", async () => {
    stubFetch(() => json({ state: "none" }));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useLatestReview(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(polls.delays()).toEqual([]);
  });
});

describe("useReviews", () => {
  it("reads the past reviews from /api/reviews under the list key (past reviews visible)", async () => {
    const calls = stubFetch(() => json(reviewListFixture()));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useReviews(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/reviews" });
    expect(queryClient.getQueryData(reviewListKey)).toEqual(reviewListFixture());
  });
});

describe("useReview", () => {
  it("reads one review from /api/reviews/:id under its detail key", async () => {
    const calls = stubFetch(() => json(reviewResponseFixture()));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useReview(REVIEW_ID), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toMatchObject({ method: "GET", path: `/api/reviews/${REVIEW_ID}` });
    expect(queryClient.getQueryData(reviewKey(REVIEW_ID))).toEqual(reviewResponseFixture());
  });

  it("fails as not found for a malformed id without asking the API", async () => {
    const calls = stubFetch(() => json(reviewResponseFixture()));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useReview("not-a-review"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toMatchObject({ code: "not_found" }));
    expect(calls).toEqual([]);
  });
});

describe("useReviewFeedback", () => {
  it("shows the thumb at once on the detail and on Today, puts it to the review's address and caches the answer (thumbs stored)", async () => {
    let answer!: (response: Response) => void;
    const calls = stubFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(reviewKey(REVIEW_ID), reviewResponseFixture());
    queryClient.setQueryData(latestReviewKey, latestReviewReadyFixture());
    queryClient.setQueryData(reviewListKey, reviewListFixture());
    const { result } = renderHook(() => useReviewFeedback(), { wrapper: Wrapper });

    act(() => result.current.mutate({ reviewId: REVIEW_ID, feedback: "up" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(detailFeedback(queryClient.getQueryData(reviewKey(REVIEW_ID)))).toBe("up");
    expect(latestFeedback(queryClient.getQueryData(latestReviewKey))).toBe("up");
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `/api/reviews/${REVIEW_ID}/feedback`,
      body: { feedback: "up" },
    });

    answer(json(withFeedback("up")));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(reviewKey(REVIEW_ID))).toEqual(withFeedback("up"));
    expect(queryClient.getQueryData(latestReviewKey)).toEqual(
      latestReviewReadyFixture(withFeedback("up").review),
    );
    expect(queryClient.getQueryState(reviewListKey)?.isInvalidated).toBe(true);
  });

  it("sets the detail from Today, where only the latest review is loaded", async () => {
    stubFetch(() => json(withFeedback("down")));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(latestReviewKey, latestReviewReadyFixture());
    const { result } = renderHook(() => useReviewFeedback(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync({ reviewId: REVIEW_ID, feedback: "down" }));

    expect(queryClient.getQueryData(reviewKey(REVIEW_ID))).toEqual(withFeedback("down"));
    expect(latestFeedback(queryClient.getQueryData(latestReviewKey))).toBe("down");
  });

  it("leaves Today's review alone when the thumb is for another review (past review)", async () => {
    const pastId = reviewListFixture().reviews[2]!.id;
    const past = reviewResponseFixture(
      weeklyReviewCardFixture({ id: pastId, weekStart: "2025-12-29" }),
    );
    stubFetch(() => json({ review: { ...past.review, feedback: "up" } }));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(reviewKey(pastId), past);
    queryClient.setQueryData(latestReviewKey, latestReviewReadyFixture());
    const { result } = renderHook(() => useReviewFeedback(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync({ reviewId: pastId, feedback: "up" }));

    expect(detailFeedback(queryClient.getQueryData(reviewKey(pastId)))).toBe("up");
    expect(queryClient.getQueryData(latestReviewKey)).toEqual(latestReviewReadyFixture());
  });

  it("leaves Today alone when it holds no review (pending)", async () => {
    stubFetch(() => json(withFeedback("up")));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(latestReviewKey, { state: "pending" });
    const { result } = renderHook(() => useReviewFeedback(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync({ reviewId: REVIEW_ID, feedback: "up" }));

    expect(queryClient.getQueryData(latestReviewKey)).toEqual({ state: "pending" });
  });

  it("sends null to clear a thumb", async () => {
    const calls = stubFetch(() => json(withFeedback(null)));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(reviewKey(REVIEW_ID), withFeedback("down"));
    const { result } = renderHook(() => useReviewFeedback(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync({ reviewId: REVIEW_ID, feedback: null }));

    expect(calls[0]?.body).toEqual({ feedback: null });
    expect(detailFeedback(queryClient.getQueryData(reviewKey(REVIEW_ID)))).toBeNull();
  });

  it("puts the earlier thumb back on both and reads them again when a lone tap fails (rollback)", async () => {
    stubFetch(() => problem(500, ErrorCode.internal));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(reviewKey(REVIEW_ID), withFeedback("down"));
    queryClient.setQueryData(
      latestReviewKey,
      latestReviewReadyFixture(withFeedback("down").review),
    );
    const { result } = renderHook(() => useReviewFeedback(), { wrapper: Wrapper });

    await act(async () => {
      await result.current
        .mutateAsync({ reviewId: REVIEW_ID, feedback: "up" })
        .catch(() => undefined);
    });

    expect(detailFeedback(queryClient.getQueryData(reviewKey(REVIEW_ID)))).toBe("down");
    expect(latestFeedback(queryClient.getQueryData(latestReviewKey))).toBe("down");
    expect(queryClient.getQueryState(reviewKey(REVIEW_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(latestReviewKey)?.isInvalidated).toBe(true);
    await waitFor(() => expect(result.current.error).toMatchObject({ code: "internal" }));
  });

  it("sends quick taps one after another and keeps the last on screen while the first answers (thumbs race)", async () => {
    const answers: ((response: Response) => void)[] = [];
    const calls = stubFetch(() => new Promise<Response>((resolve) => answers.push(resolve)));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(reviewKey(REVIEW_ID), reviewResponseFixture());
    const { result } = renderHook(() => useReviewFeedback(), { wrapper: Wrapper });
    const shown = () => detailFeedback(queryClient.getQueryData(reviewKey(REVIEW_ID)));

    act(() => result.current.mutate({ reviewId: REVIEW_ID, feedback: "up" }));
    act(() => result.current.mutate({ reviewId: REVIEW_ID, feedback: "down" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(shown()).toBe("down");
    answers[0]?.(json(withFeedback("up")));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(shown()).toBe("down");
    expect(calls.map((call) => call.body)).toEqual([{ feedback: "up" }, { feedback: "down" }]);
    answers[1]?.(json(withFeedback("down")));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(shown()).toBe("down");
  });

  it("does not create a review that is not loaded before the answer", async () => {
    stubFetch(never);
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useReviewFeedback(), { wrapper: Wrapper });

    act(() => result.current.mutate({ reviewId: REVIEW_ID, feedback: "up" }));

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(queryClient.getQueryData(reviewKey(REVIEW_ID))).toBeUndefined();
    expect(queryClient.getQueryData(latestReviewKey)).toBeUndefined();
  });
});
