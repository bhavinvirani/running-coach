import { reviewCopy } from "../../src/lib/weekly-review";
import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import {
  seedWeekOneReview,
  weekOneReviewAt,
  weeklyReviewCard,
} from "../fixtures/seed-weekly-review";

test("weekly reviews lists the coach's review of week 1 with its week and headline", async ({
  page,
}) => {
  await seedWeekOneReview();
  // Mon 12 Oct, the morning the review was written: the week reads "5–11 Oct" without a year whatever
  // the date.
  await page.clock.setFixedTime(weekOneReviewAt);

  await page.goto("/plan/reviews");
  await expect(page.getByRole("heading", { name: reviewCopy.listTitle, level: 1 })).toBeVisible();
  // The last row: once the review's headline shows, the list has rendered.
  await expect(page.getByText(weeklyReviewCard.headline, { exact: true })).toBeVisible();

  await fitViewportToPage(page);
  // No mask: the week and the headline are the seed's; nothing on the screen reads the time.
  await expect(page).toHaveScreenshot("reviews.png", { fullPage: true });
});
