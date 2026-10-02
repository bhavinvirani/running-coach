import { expect, test } from "../fixtures/login";
import {
  bestsCheckedAt,
  connectGarmin,
  historyBestEfforts,
  importDone,
  seedBestEfforts,
  seedGarminRecords,
  seedImportProgress,
  seedRunHistory,
} from "../fixtures/seed";

test("progress shows the personal bests and the seeded runs by week under a finished import", async ({
  page,
}) => {
  // Seeded rows, not an import or a best-efforts pass: the screen under test is the loaded list.
  await seedRunHistory();
  await seedBestEfforts(historyBestEfforts);
  await seedImportProgress(importDone);
  // Garmin's own records live on the connection.
  await connectGarmin(page.request);
  await seedGarminRecords();
  // "New" is measured from the browser's clock: pinned three days after the newest run, the badges of
  // Sun 27 Sep read New and the rest do not, whatever the date.
  await page.clock.setFixedTime(bestsCheckedAt);

  await page.goto("/progress");
  // The last row on the screen: once it shows, the import line, the bests and the eight weeks above it
  // have rendered.
  await expect(page.getByRole("button", { name: "Show earlier weeks" })).toBeVisible();
  await expect(page.getByRole("region", { name: "History import" })).toContainText(
    "24 runs · history imported 28 Sep 2026",
  );
  const bests = page.getByRole("region", { name: "Personal bests" });
  await expect(bests.getByRole("link")).toHaveCount(7);
  await expect(
    bests.getByRole("link", { name: "10K, 56:41, 27 Sep 2026, Garmin 56:38, New" }),
  ).toBeVisible();
  await expect(bests.getByText("No run yet", { exact: true })).toHaveCount(4);
  // Under the row of tiles, since Garmin's records are seeded.
  await expect(
    bests.getByText("Garmin keeps records for 1K, 1 mi, 5K, 10K, half and marathon only.", {
      exact: true,
    }),
  ).toBeVisible();

  // A full-page capture of a page taller than the viewport leaves the sticky tab bar where the viewport
  // ends, over the fourth week. A viewport as tall as the page puts it at the bottom, where a runner who
  // scrolled to the end sees it, and every week stays in the comparison.
  const viewport = page.viewportSize();
  const content = await page.locator("body").boundingBox();
  if (!viewport || !content) throw new Error("The page has no viewport or no laid-out body");
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(content.height) });

  // Nothing else here depends on the clock: the import's times are fixed by the seed, the bests' dates are
  // the runs' own, and week labels come from the runs' own dates, the newest week being the reference for
  // the year.
  await expect(page).toHaveScreenshot("progress.png", { fullPage: true });
});
