import { reviewCopy } from "../../src/lib/weekly-review";
import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import {
  seedWeekOneReview,
  weekOneReviewAt,
  weeklyReviewNote,
} from "../fixtures/seed-weekly-review";

test("weekly review shows the coach's review of week 1 with its plan change and week 2's sessions", async ({
  page,
}) => {
  const review = await seedWeekOneReview();
  // Mon 12 Oct, the morning the review was written: the week reads "5–11 Oct" without a year whatever
  // the date.
  await page.clock.setFixedTime(weekOneReviewAt);

  await page.goto(`/plan/reviews/${review.id}`);
  await expect(page.getByText(weeklyReviewNote, { exact: true })).toBeVisible();
  // The last row on the screen: once Sunday's long run shows, the card above it has rendered.
  const sessions = page.getByRole("region", { name: reviewCopy.comingWeek }).getByRole("link");
  await expect(sessions).toHaveCount(4);
  await expect(sessions.last()).toContainText("Sun 18 Oct");

  await fitViewportToPage(page);
  // No mask: the week, the summary, the change and the sessions are the seed's, the plan's numbers the
  // engine's own; nothing on the screen reads the time.
  await expect(page).toHaveScreenshot("weekly-review.png", { fullPage: true });
});
