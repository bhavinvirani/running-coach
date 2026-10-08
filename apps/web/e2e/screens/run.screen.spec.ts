import { latestActivityResponseSchema } from "@running-coach/shared";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/login";
import {
  fixtureRunIds,
  longRunBestEfforts,
  longRunInsight,
  seedBestEfforts,
  seedInsight,
  seedLongRun,
  seedRaceDayRun,
  seedRunDetail,
  seedTreadmillRun,
} from "../fixtures/seed";
import { pairs, seedPair, wearPair } from "../fixtures/seed-shoes";

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

/**
 * The Shoes section once the pairs have loaded beside the run: the pair the run wears with Change, or with
 * no pair stored, the sentence and Add shoes.
 */
async function expectShoesLoaded(page: Page, pair: string | null): Promise<void> {
  const shoes = section(page, "Shoes");
  if (pair === null) {
    await expect(shoes.getByRole("link", { name: "Add shoes", exact: true })).toBeVisible();
  } else {
    await expect(shoes.getByRole("button", { name: "Change" })).toHaveAccessibleDescription(pair);
  }
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

test("run shows the seeded long run as a race with its pair, best efforts, route, split bars, zones, cadence and elevation", async ({
  page,
}) => {
  await seedLongRun({ race: true });
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");
  // An earlier, faster race beside it, so the long run holds only 15K and 10 mi and its Best efforts show
  // both kinds of tile. The race starts earlier, so the newest run is still the long run.
  await seedRaceDayRun();
  await seedBestEfforts(longRunBestEfforts);
  // The pair it was run in, under the stats.
  await wearPair(fixtureRunIds.longRun, await seedPair(pairs.glide, { active: true }));

  await openSeededRun(page);
  await expectShoesLoaded(page, "Northpace Glide 4");
  // The last section on the screen: once its line is drawn, every section above it has rendered.
  await expect(
    section(page, "Elevation")
      .getByRole("img", { name: "Elevation chart" })
      .locator(".recharts-line-curve"),
  ).toBeVisible();
  await expect(section(page, "Route").getByRole("img", { name: "Route sketch" })).toBeVisible();
  await expect(section(page, "Summary").getByText("Race", { exact: true })).toBeVisible();
  await expect(section(page, "Summary").getByText("PB 15K, 10 mi", { exact: true })).toBeVisible();
  const efforts = section(page, "Best efforts");
  await expect(efforts.getByRole("listitem")).toHaveCount(8);
  await expect(efforts.getByText("PB", { exact: true })).toHaveCount(2);
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
  await expectShoesLoaded(page, null);
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

test("run shows the coach's review of the long run under its stats, rated helpful", async ({
  page,
}) => {
  await seedLongRun();
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");
  // The model's card with a caution, already rated: every part the card can show, with the thumb
  // pressed. The card's date is the seed's, and nothing on it reads the clock.
  await seedInsight(fixtureRunIds.longRun, longRunInsight, { feedback: "up" });

  await openSeededRun(page);
  await expectShoesLoaded(page, null);
  const coach = section(page, "Coach");
  await expect(coach.getByText(longRunInsight.headline, { exact: true })).toBeVisible();
  await expect(coach.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The last section on the screen: once its line is drawn, every section above it has rendered.
  await expect(
    section(page, "Elevation")
      .getByRole("img", { name: "Elevation chart" })
      .locator(".recharts-line-curve"),
  ).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("run-coach.png", { fullPage: true });
});
