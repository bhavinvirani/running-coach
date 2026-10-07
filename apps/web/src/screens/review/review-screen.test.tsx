import type { CoachFeedback, MeResponse, ReviewResponse } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { reviewKey } from "@/api/reviews";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { meFixture, planSessionId } from "@/test/fixtures";
import {
  REVIEW_ID,
  fallbackReviewFixture,
  reviewResponseFixture,
  weeklyReviewCardFixture,
} from "@/test/fixtures-weekly-review";
import { renderScreen } from "@/test/render";
import { ReviewScreen } from "./review-screen";

type FakeReviewApi = {
  me?: MeResponse;
  /** GET /api/reviews/:id: the review, or an answer per read. */
  review?: ReviewResponse | (() => Response | Promise<Response>);
  /** PUT /api/reviews/:id/feedback; by default the review with the thumb sent. */
  feedback?: (sent: CoachFeedback | null) => Response | Promise<Response>;
};

/** /api/me, the review and its feedback, in memory. */
function fakeReviewApi({
  me = meFixture(),
  review = reviewResponseFixture(),
  feedback = (sent) => json(reviewResponseFixture(weeklyReviewCardFixture({ feedback: sent }))),
}: FakeReviewApi = {}) {
  return stubFetch(({ method, path, body }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "GET" && path === `/api/reviews/${REVIEW_ID}`) {
      return typeof review === "function" ? review() : json(review);
    }
    if (method === "PUT" && path === `/api/reviews/${REVIEW_ID}/feedback`) {
      return feedback((body as { feedback: CoachFeedback | null }).feedback);
    }
    return notFound();
  });
}

function renderReview(id = REVIEW_ID) {
  return renderScreen(<ReviewScreen />, {
    route: "/plan/reviews/:id",
    path: `/plan/reviews/${id}`,
  });
}

const headline = weeklyReviewCardFixture().content.headline;

describe("ReviewScreen", () => {
  it("shows a skeleton in the final layout under the title while loading, with Back to the list", () => {
    fakeReviewApi({ review: never });
    renderReview();

    expect(screen.getByRole("heading", { name: "Weekly review", level: 1 })).toHaveClass(
      "text-title",
    );
    expect(screen.getByRole("status", { name: "Loading the weekly review" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/plan/reviews");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    fakeReviewApi({
      review: () => {
        attempts += 1;
        return attempts === 1 ? problem(500, ErrorCode.internal) : json(reviewResponseFixture());
      },
    });
    renderReview();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(headline)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says a review that is not the runner's no longer exists, with the way back to the list (404)", async () => {
    fakeReviewApi({ review: () => problem(404, ErrorCode.notFound) });
    const { router } = renderReview();

    expect(await screen.findByText("That weekly review no longer exists.")).toHaveClass(
      "text-body",
      "text-ink-2",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Open weekly reviews" }));
    expect(router.state.location.pathname).toBe("/plan/reviews");
  });

  it("says the same for a malformed address without asking the API", async () => {
    const calls = fakeReviewApi();
    renderReview("not-a-review");

    expect(await screen.findByText("That weekly review no longer exists.")).toBeInTheDocument();
    expect(calls.filter((call) => call.path.startsWith("/api/reviews"))).toEqual([]);
  });

  it("shows the review's card and the coming week's sessions, each opening its session (past reviews visible)", async () => {
    fakeReviewApi();
    const { router } = renderReview();

    expect(await screen.findByText(headline)).toBeInTheDocument();
    expect(screen.getByText("5–11 Oct")).toBeInTheDocument();
    expect(screen.getByText("Sun 18 Long run 18.0 km → Long run 16.2 km")).toBeInTheDocument();
    const week = screen.getByRole("region", { name: "Coming week" });
    const sessions = within(week).getAllByRole("link");
    expect(sessions).toHaveLength(5);

    await userEvent.click(within(week).getByRole("link", { name: "Thu 15 Oct, Tempo, 8.2 km" }));
    expect(router.state.location.pathname).toBe(`/plan/sessions/${planSessionId("2026-10-15")}`);
  });

  it("gives the week's distances, its changes and the coming week in mi when the runner uses miles (unit conversion)", async () => {
    fakeReviewApi({ me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }) });
    renderReview();

    await screen.findByText(headline);
    expect(screen.getByText("Distance", { selector: "span" }).parentElement).toHaveTextContent(
      "Distance19.5of 23.6 mi",
    );
    expect(screen.getByText("Sun 18 Long run 11.2 mi → Long run 10.1 mi")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sun 18 Oct, Long run, 10.1 mi" })).toBeInTheDocument();
  });

  it("stores a thumb, shows it pressed and clears it on a second tap (thumbs stored)", async () => {
    const calls = fakeReviewApi();
    renderReview();
    const helpful = await screen.findByRole("button", { name: "Helpful" });

    await userEvent.click(helpful);
    await vi.waitFor(() => expect(helpful).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(helpful);
    await vi.waitFor(() => expect(helpful).toHaveAttribute("aria-pressed", "false"));

    const sent = calls.filter((call) => call.method === "PUT");
    expect(sent.map((call) => call.path)).toEqual([
      `/api/reviews/${REVIEW_ID}/feedback`,
      `/api/reviews/${REVIEW_ID}/feedback`,
    ]);
    expect(sent.map((call) => call.body)).toEqual([{ feedback: "up" }, { feedback: null }]);
  });

  it("puts the thumb back and says why when saving it fails (feedback rollback)", async () => {
    let fail!: () => void;
    fakeReviewApi({
      feedback: () =>
        new Promise<Response>(
          (resolve) => (fail = () => resolve(problem(500, ErrorCode.internal))),
        ),
    });
    renderReview();
    const notHelpful = await screen.findByRole("button", { name: "Not helpful" });

    await userEvent.click(notHelpful);
    await vi.waitFor(() => expect(notHelpful).toHaveAttribute("aria-pressed", "true"));
    act(() => fail());

    await vi.waitFor(() => expect(notHelpful).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByRole("alert")).toHaveTextContent(errorMessages.internal);
  });

  it("shows a fallback review with its reason line, without thumbs or Try again (fallback card)", async () => {
    const fallback = fallbackReviewFixture("key_invalid");
    fakeReviewApi({ review: reviewResponseFixture({ ...fallback, id: REVIEW_ID }) });
    renderReview();

    expect(await screen.findByText(fallback.content.whatItMeans)).toBeInTheDocument();
    expect(screen.queryByText("What it means")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps the review and offers Retry when a background reload fails", async () => {
    let failing = false;
    fakeReviewApi({
      review: () => (failing ? problem(503, ErrorCode.internal) : json(reviewResponseFixture())),
    });
    const { queryClient } = renderReview();
    await screen.findByText(headline);

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: reviewKey(REVIEW_ID) }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByText(headline)).toBeInTheDocument();
  });
});
