import type { ReviewListResponse } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { reviewListKey } from "@/api/reviews";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { REVIEW_ID, reviewListFixture } from "@/test/fixtures-weekly-review";
import { renderScreen } from "@/test/render";
import { ReviewsScreen } from "./reviews-screen";

/** /api/me and GET /api/reviews, in memory. */
function fakeReviewsApi(
  reviews: ReviewListResponse | (() => Response | Promise<Response>) = reviewListFixture(),
) {
  return stubFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/me") return json(meFixture());
    if (method === "GET" && path === "/api/reviews") {
      return typeof reviews === "function" ? reviews() : json(reviews);
    }
    return notFound();
  });
}

function renderReviews() {
  return renderScreen(<ReviewsScreen />, { path: "/plan/reviews" });
}

describe("ReviewsScreen", () => {
  it("shows a skeleton in the final layout under the title while loading", () => {
    fakeReviewsApi(never);
    renderReviews();

    expect(screen.getByRole("heading", { name: "Weekly reviews", level: 1 })).toHaveClass(
      "text-title",
    );
    expect(screen.getByRole("status", { name: "Loading your weekly reviews" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/plan");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    fakeReviewsApi(() => {
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(reviewListFixture());
    });
    renderReviews();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says there is no review yet in one sentence with one action back to Plan (empty)", async () => {
    fakeReviewsApi({ reviews: [] });
    const { router } = renderReviews();

    expect(
      await screen.findByText("No weekly reviews yet: the coach writes one after each week ends."),
    ).toHaveClass("text-body", "text-ink-2");
    const links = screen.getAllByRole("link").filter((link) => link.textContent !== "Back");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent("Open plan");

    await userEvent.click(links[0]!);
    expect(router.state.location.pathname).toBe("/plan");
  });

  it("lists the past reviews newest week first, each as its dates and headline, opening the review (past reviews visible)", async () => {
    fakeReviewsApi();
    const { router } = renderReviews();

    const rows = await screen.findAllByRole("listitem");
    const links = rows.map((row) => within(row).getByRole("link"));
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "5–11 Oct, 31.4 km of the planned 38.0 km, with 4 of 5 sessions done.",
      "28 Sep – 4 Oct, 27.2 km in 4 runs, no plan yet.",
      // A week outside the newest one's year names its years.
      "29 Dec 2025 – 4 Jan 2026, 18.5 km over the holidays, 3 easy runs.",
    ]);
    expect(within(links[0]!).getByText("5–11 Oct")).toHaveClass("text-caption", "text-ink-2");
    expect(
      within(links[0]!).getByText("31.4 km of the planned 38.0 km, with 4 of 5 sessions done."),
    ).toHaveClass("text-body", "text-ink");

    await userEvent.click(links[0]!);
    expect(router.state.location.pathname).toBe(`/plan/reviews/${REVIEW_ID}`);
  });

  it("keeps the list and offers Retry when a background reload fails", async () => {
    let failing = false;
    fakeReviewsApi(() => (failing ? problem(503, ErrorCode.internal) : json(reviewListFixture())));
    const { queryClient } = renderReviews();
    expect(await screen.findAllByRole("listitem")).toHaveLength(3);

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: reviewListKey }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
