import { planWeekCopy } from "../../src/screens/plan-week/plan-week-copy";
import { expect, test } from "../fixtures/login";
import { planWeekTwoAt, seedPlan } from "../fixtures/seed";

test("plan week shows week 2 of the seeded plan, Monday to Sunday", async ({ page }) => {
  await seedPlan();
  // Pinned as on Plan's capture: nothing on a week reads today, but the two captures stay one moment.
  await page.clock.setFixedTime(planWeekTwoAt);

  await page.goto("/plan/weeks/2");
  // The last row on the screen: once Sunday shows, the week's figure and every day above it have rendered.
  const days = page.getByRole("region", { name: planWeekCopy.days }).getByRole("listitem");
  await expect(days).toHaveCount(7);
  await expect(days.last()).toContainText("Sun 18 Oct");

  // A page taller than the viewport would leave the sticky tab bar over a day in a full-page capture; a
  // viewport as tall as the page puts it at the bottom.
  const viewport = page.viewportSize();
  const content = await page.locator("body").boundingBox();
  if (!viewport || !content) throw new Error("The page has no viewport or no laid-out body");
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(content.height) });

  // No mask: the week's dates and steps are the seed's.
  await expect(page).toHaveScreenshot("plan-week.png", { fullPage: true });
});
