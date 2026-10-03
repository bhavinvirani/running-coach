import { planCopy } from "../../src/screens/plan/plan-copy";
import { expect, test } from "../fixtures/login";
import { planWeekTwoAt, seedPlan } from "../fixtures/seed";

test("plan shows the seeded half marathon plan with week 2 as this week", async ({ page }) => {
  const plan = await seedPlan();
  // The current week is the one that holds the browser's today: pinned to Wed 14 Oct 2026, week 2 has the
  // selected border whatever the date.
  await page.clock.setFixedTime(planWeekTwoAt);

  await page.goto("/plan");
  // The last row on the screen: once it shows, the goal, the paces and every week above it have rendered.
  const weeks = page.getByRole("region", { name: planCopy.weeks }).getByRole("link");
  await expect(weeks).toHaveCount(plan.weeks.length);
  await expect(weeks.last()).toBeVisible();
  await expect(weeks.nth(1)).toHaveAccessibleName(/, this week, /);

  // A full-page capture of a page taller than the viewport leaves the sticky tab bar where the viewport
  // ends, over a week card. A viewport as tall as the page puts it at the bottom, where a runner who
  // scrolled to the end sees it, and every week stays in the comparison.
  const viewport = page.viewportSize();
  const content = await page.locator("body").boundingBox();
  if (!viewport || !content) throw new Error("The page has no viewport or no laid-out body");
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(content.height) });

  // Nothing else here depends on the clock: the goal, paces and weeks are the seed's, and week ranges come
  // from the plan's own dates, its last week being the reference for the year.
  await expect(page).toHaveScreenshot("plan.png", { fullPage: true });
});
