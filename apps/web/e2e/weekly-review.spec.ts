import {
  ErrorCode,
  latestReviewResponseSchema,
  reviewResponseSchema,
  type Problem,
  type ReviewSession,
  type WeeklyReviewCard,
} from "@running-coach/shared";
import type { Locator, Page, Response } from "@playwright/test";
import { addDays } from "../src/lib/dates";
import { errorMessages } from "../src/lib/errors";
import { formatLocalDay, formatWeekRange } from "../src/lib/format";
import { planChangeLine, snapshotAmount } from "../src/lib/session-adjustment";
import { comingSessionState, reviewCopy } from "../src/lib/weekly-review";
import { sessionName } from "../src/lib/workout-steps";
import { expect, test } from "./fixtures/login";
import {
  seedLastWeek,
  seedLastWeekReview,
  weeklyReviewCard,
  weeklyReviewNote,
} from "./fixtures/seed-weekly-review";
import { skipSyncOnOpen } from "./fixtures/sync";

// Every flow here runs on the real clock: the API answers GET /api/reviews/latest with the review of the
// last week that ended on the server's own today, so the review is seeded for that week and the plan's
// coming week is this one. No test connects Garmin, and none is about the sync on open.

/** The review on Today, named by its title. */
function reviewRegion(page: Page): Locator {
  return page.getByRole("region", { name: reviewCopy.title, exact: true });
}

const isLatestReview = (response: Response) =>
  response.request().method() === "GET" &&
  new URL(response.url()).pathname === "/api/reviews/latest";

async function getReview(page: Page, id: string): Promise<WeeklyReviewCard> {
  const response = await page.request.get(`/api/reviews/${id}`);
  expect(response.ok()).toBe(true);
  return reviewResponseSchema.parse(await response.json()).review;
}

/**
 * A coming-week session's link as the review screen reads it out: its day, its name, what happened to it
 * and its distance ("Sun 18 Oct, Long run, 13.5 km").
 */
function comingSessionLabel(session: ReviewSession): string {
  return [
    formatLocalDay(session.date),
    sessionName(session),
    comingSessionState(session.status),
    session.status === "skipped" ? null : snapshotAmount(session.target, "km"),
  ]
    .filter((part) => part !== null)
    .join(", ");
}

test("Today shows last week's review with its three parts and the plan change with its note, and a thumbs up is stored and stays after a reload", async ({
  page,
}) => {
  const review = await seedLastWeekReview();
  await skipSyncOnOpen(page);

  await page.goto("/");
  const card = reviewRegion(page);
  await expect(card.getByText(weeklyReviewCard.headline, { exact: true })).toBeVisible();
  // The reviewed week's dates, its year named only when it is not this week's.
  await expect(card).toContainText(formatWeekRange(review.weekStart, addDays(review.weekStart, 7)));
  await expect(card.getByRole("heading", { level: 3 })).toHaveText([
    reviewCopy.whatHappened,
    reviewCopy.whatItMeans,
    reviewCopy.nextWeek,
    reviewCopy.changes,
  ]);
  await expect(card.getByText(weeklyReviewCard.whatHappened, { exact: true })).toBeVisible();
  await expect(card.getByText(weeklyReviewCard.whatItMeans, { exact: true })).toBeVisible();
  await expect(card.getByText(weeklyReviewCard.nextWeek, { exact: true })).toBeVisible();
  // The change as the engine made it, not in the coach's words, then the coach's note.
  await expect(card.getByText(planChangeLine(review.change, "km"), { exact: true })).toBeVisible();
  await expect(card.getByText(weeklyReviewNote, { exact: true })).toBeVisible();
  // Today stays Today: the review sits under the latest run, above the next 7 days.
  await expect(page.getByRole("region", { name: "Latest run" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Next 7 days" })).toBeVisible();

  const helpful = card.getByRole("button", { name: "Helpful", exact: true });
  const notHelpful = card.getByRole("button", { name: "Not helpful", exact: true });
  await expect(helpful).toHaveAttribute("aria-pressed", "false");
  const rated = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/reviews/${review.id}/feedback`,
  );
  await helpful.click();
  expect((await rated).ok()).toBe(true);
  await expect(helpful).toHaveAttribute("aria-pressed", "true");
  expect((await getReview(page, review.id)).feedback).toBe("up");

  await page.reload();
  await expect(card.getByText(weeklyReviewCard.headline, { exact: true })).toBeVisible();
  await expect(helpful).toHaveAttribute("aria-pressed", "true");
  await expect(notHelpful).toHaveAttribute("aria-pressed", "false");
  expect((await getReview(page, review.id)).feedback).toBe("up");
});

test("Open weekly reviews on Today opens the list and the review with the coming week's sessions, and Plan's Open weekly reviews reaches the same list", async ({
  page,
}) => {
  const review = await seedLastWeekReview();
  await skipSyncOnOpen(page);

  await page.goto("/");
  await reviewRegion(page).getByRole("link", { name: reviewCopy.openList }).click();
  await expect(page).toHaveURL(/\/plan\/reviews$/);
  await expect(page.getByRole("heading", { name: reviewCopy.listTitle, level: 1 })).toBeVisible();
  // The newest week is the list's reference for the year, so its own row names none.
  const row = page.getByRole("link", {
    name: `${formatWeekRange(review.weekStart, review.weekStart)}, ${weeklyReviewCard.headline}`,
  });

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/plan/reviews/${review.id}$`));
  await expect(page.getByRole("heading", { name: reviewCopy.title, level: 1 })).toBeVisible();
  await expect(page.getByText(weeklyReviewCard.headline, { exact: true })).toBeVisible();
  await expect(page.getByText(planChangeLine(review.change, "km"), { exact: true })).toBeVisible();
  await expect(page.getByText(weeklyReviewNote, { exact: true })).toBeVisible();
  // This week's four sessions as the plan holds them now, the long run as the review left it.
  const sessions = page.getByRole("region", { name: reviewCopy.comingWeek }).getByRole("link");
  await expect(sessions).toHaveCount(review.comingWeek.length);
  for (const [position, session] of review.comingWeek.entries()) {
    await expect(sessions.nth(position)).toHaveAccessibleName(comingSessionLabel(session));
  }
  const stored = await getReview(page, review.id);
  expect(stored.comingWeek).toEqual(review.comingWeek);
  expect(stored.changes).toEqual([{ ...review.change, note: weeklyReviewNote }]);

  await page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "Plan" }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await page.getByRole("link", { name: reviewCopy.openList, exact: true }).click();
  await expect(page).toHaveURL(/\/plan\/reviews$/);
  await expect(row).toBeVisible();
});

test("a failed read of the review keeps Today on screen with an inline alert, and Retry brings the review", async ({
  page,
}) => {
  await seedLastWeekReview();
  await skipSyncOnOpen(page);
  const failure = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: ErrorCode.internal,
    requestId: "e2e-weekly-review-failure",
  } satisfies Problem;
  await page.route("**/api/reviews/latest", (route) =>
    route.fulfill({
      status: failure.status,
      contentType: "application/problem+json",
      body: JSON.stringify(failure),
    }),
  );

  await page.goto("/");
  const card = reviewRegion(page);
  // The query retries a server error three times with jittered backoff (at most 1 + 2 + 4 s) before the
  // alert shows, so the wait covers that instead of the default 5 s.
  await expect(card.getByRole("alert")).toHaveText(errorMessages.internal, { timeout: 15_000 });
  await expect(card.getByText(weeklyReviewCard.headline, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Latest run" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Next 7 days" })).toBeVisible();

  await page.unroute("**/api/reviews/latest");
  await card.getByRole("button", { name: "Retry" }).click();

  await expect(card.getByText(weeklyReviewCard.headline, { exact: true })).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
});

test("a runner the coach has not reviewed sees no review on Today and the empty list, whose Open plan goes back to Plan", async ({
  page,
}) => {
  await seedLastWeek();
  await skipSyncOnOpen(page);

  const latest = page.waitForResponse(isLatestReview);
  await page.goto("/");
  const answer = await latest;
  expect(answer.ok()).toBe(true);
  expect(latestReviewResponseSchema.parse(await answer.json())).toEqual({ state: "none" });
  await expect(page.getByRole("region", { name: "Latest run" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Next 7 days" })).toBeVisible();
  await expect(reviewRegion(page)).toHaveCount(0);

  await page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "Plan" }).click();
  await page.getByRole("link", { name: reviewCopy.openList, exact: true }).click();
  await expect(page).toHaveURL(/\/plan\/reviews$/);
  await expect(page.getByText(reviewCopy.empty, { exact: true })).toBeVisible();

  await page.getByRole("link", { name: reviewCopy.openPlan, exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByRole("link", { name: reviewCopy.openList, exact: true })).toBeVisible();
});
