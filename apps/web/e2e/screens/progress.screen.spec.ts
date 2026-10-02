import { expect, test } from "../fixtures/login";
import { importDone, seedImportProgress, seedRunHistory } from "../fixtures/seed";

test("progress shows the seeded runs by week under a finished import", async ({ page }) => {
  // Seeded rows, not an import: the screen under test is the loaded list, not the import.
  await seedRunHistory();
  await seedImportProgress(importDone);

  await page.goto("/progress");
  // The last row on the screen: once it shows, the import line and the eight weeks above it have rendered.
  await expect(page.getByRole("button", { name: "Show earlier weeks" })).toBeVisible();
  await expect(page.getByRole("region", { name: "History import" })).toContainText(
    "24 runs · history imported 28 Sep 2026",
  );

  // A full-page capture of a page taller than the viewport leaves the sticky tab bar where the viewport
  // ends, over the fourth week. A viewport as tall as the page puts it at the bottom, where a runner who
  // scrolled to the end sees it, and every week stays in the comparison.
  const viewport = page.viewportSize();
  const content = await page.locator("body").boundingBox();
  if (!viewport || !content) throw new Error("The page has no viewport or no laid-out body");
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(content.height) });

  // Nothing here depends on the clock: the import's times are fixed by the seed and week labels come
  // from the runs' own dates, the newest week being the reference for the year.
  await expect(page).toHaveScreenshot("progress.png", { fullPage: true });
});
