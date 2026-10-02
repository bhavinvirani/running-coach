import { personalBestsResponseSchema } from "@running-coach/shared";
import { expect, test } from "../fixtures/login";
import { connectGarmin, syncGarmin } from "../fixtures/seed";

test("today shows the latest run synced from the fixture Garmin account", async ({ page }) => {
  // Through the API, not the UI: the screen under test is the loaded Today, not the sync.
  await connectGarmin(page.request);
  await syncGarmin(page.request);
  // The sync queues the run's best efforts, and its PB chip appears once that job has run. Waiting for it
  // here, rather than on screen, keeps the capture from depending on which side of the job it lands.
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/personal-bests");
        const { bests, pendingRuns } = personalBestsResponseSchema.parse(await response.json());
        return pendingRuns === 0 && bests.length > 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.goto("/");
  // The last stat on the screen: once it shows, the card above it has rendered from the synced run.
  const card = page.getByRole("region", { name: "Latest run" });
  const avgHr = card.getByText("Avg HR", { exact: true }).locator("xpath=following-sibling::*[1]");
  await expect(avgHr).toBeVisible();
  await expect(avgHr).toHaveText(/^148\s*bpm$/);
  await expect(card.getByText(/\bPBs?\b/)).toBeVisible();

  // Nothing here depends on the clock: the date is the run's own start, fixed by the fixture.
  await expect(page).toHaveScreenshot("today.png", { fullPage: true });
});
