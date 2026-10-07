import { planWeekCopy } from "../../src/screens/plan-week/plan-week-copy";
import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { planWeekThreeAt, planWeekTwoAt, seedAdjustedPlan, seedPlan } from "../fixtures/seed";

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

test("plan week shows what the adaptation made of week 3: done, missed, changed by the coach, eased and walk-run", async ({
  page,
}) => {
  await seedAdjustedPlan();
  // Thu 22 Oct: Mon 19 and Wed 21 are past, and Add shows from Thursday on.
  await page.clock.setFixedTime(planWeekThreeAt);

  await page.goto("/plan/weeks/3");
  const days = page.getByRole("region", { name: planWeekCopy.days });
  // Each session's link carries its state and change, so these wait for every row the capture is about.
  await expect(
    days.getByRole("link", {
      name: /^Walk-run, Easy, Mon 19 Oct, Done, .*, Eased for your return, was 4\.9 km$/,
    }),
  ).toBeVisible();
  await expect(
    days.getByRole("link", {
      name: /^Easy, Wed 21 Oct, Missed, .*, Changed by the coach, was Tempo 6\.9 km$/,
    }),
  ).toBeVisible();
  await expect(
    days.getByRole("link", { name: /^Easy, Fri 23 Oct, .*, Eased for your return, was 4\.9 km$/ }),
  ).toBeVisible();
  await expect(
    days.getByRole("link", {
      name: /^Long run, Sun 25 Oct, .*, Eased for your return, was 15\.0 km$/,
    }),
  ).toBeVisible();
  await expect(days.getByRole("listitem")).toHaveCount(7);

  await fitViewportToPage(page);
  // No mask: the week's dates, steps and changes are the seed's, made with the engine's own rules.
  await expect(page).toHaveScreenshot("plan-week-adjusted.png", { fullPage: true });
});
