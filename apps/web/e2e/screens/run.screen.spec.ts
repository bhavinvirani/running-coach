import { latestActivityResponseSchema } from "@running-coach/shared";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/login";
import { fixtureRunIds, seedLongRun, seedRunDetail, seedTreadmillRun } from "../fixtures/seed";

/** Opens the one seeded run by its address: the screen under test is the run, not the way there. */
async function openSeededRun(page: Page): Promise<void> {
  const latest = latestActivityResponseSchema.parse(
    await (await page.request.get("/api/activities/latest")).json(),
  );
  if (!latest.activity) throw new Error("No run was seeded");
  await page.goto(`/runs/${latest.activity.id}`);
}

function section(page: Page, title: string): Locator {
  return page.getByRole("region", { name: title, exact: true });
}

/** The pace bars' rows, one per lap shown: the first 12 until Show all. */
function splitBars(page: Page): Locator {
  return section(page, "Splits").getByRole("list", { name: "Splits" }).getByRole("listitem");
}

/**
 * A full-page capture of a page taller than the viewport leaves the sticky tab bar where the viewport ends,
 * over the charts. A viewport as tall as the page puts it at the bottom, where a runner who scrolled to the
 * end sees it, and every section stays in the comparison (progress.screen.spec.ts).
 */
async function fitViewportToPage(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  const content = await page.locator("body").boundingBox();
  if (!viewport || !content) throw new Error("The page has no viewport or no laid-out body");
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(content.height) });
}

// Nothing on the run screen depends on the clock: the day and time are the run's own start, fixed by the
// seed, and the laps, samples, route and zones are synthetic and deterministic (seedRunDetail).

test("run shows the seeded long run as a race with its route, split bars, zones, cadence and elevation", async ({
  page,
}) => {
  await seedLongRun({ race: true });
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");

  await openSeededRun(page);
  // The last section on the screen: once its line is drawn, every section above it has rendered.
  await expect(
    section(page, "Elevation")
      .getByRole("img", { name: "Elevation chart" })
      .locator(".recharts-line-curve"),
  ).toBeVisible();
  await expect(section(page, "Route").getByRole("img", { name: "Route sketch" })).toBeVisible();
  await expect(section(page, "Summary").getByText("Race", { exact: true })).toBeVisible();
  await expect(splitBars(page)).toHaveCount(12);
  await expect(
    section(page, "Splits").getByRole("button", { name: "Show all 18 laps" }),
  ).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("run.png", { fullPage: true });
});

test("run shows a treadmill run without route or elevation", async ({ page }) => {
  await seedTreadmillRun();
  await seedRunDetail(fixtureRunIds.treadmill, "treadmill");

  await openSeededRun(page);
  // The last section on the screen, a note indoors; the cadence line above it is the last chart drawn.
  await expect(section(page, "Elevation")).toContainText("No elevation recorded.");
  await expect(
    section(page, "Cadence")
      .getByRole("img", { name: "Cadence chart" })
      .locator(".recharts-line-curve"),
  ).toBeVisible();
  await expect(section(page, "Route")).toContainText("Indoor run: no GPS route.");
  await expect(splitBars(page)).toHaveCount(8);

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("run-treadmill.png", { fullPage: true });
});
