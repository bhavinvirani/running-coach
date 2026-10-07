import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { fixtureRunIds, seedLongRun, seedRunDetail } from "../fixtures/seed";

test("hr zones shows Garmin's zones from the seeded long run, each by percent of max HR and bpm", async ({
  page,
}) => {
  // Garmin's floors as seedRunDetail stores them with the run (98, 118, 137, 157 and 176 bpm), read back
  // with max HR 196. Nothing depends on the clock: the zones are the stored run's, not an estimate.
  await seedLongRun();
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");

  await page.goto("/settings/hr-zones");
  await expect(
    page.getByText("Garmin's zones, from your latest run with heart rate.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Max HR", { exact: true })).toHaveValue("196");
  await expect(page.getByLabel("Zone 5 lower bound, bpm", { exact: true })).toHaveValue("176");
  // The last row on the screen.
  await expect(page.getByRole("button", { name: "Save zones" })).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("hr-zones.png", { fullPage: true });
});
