import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import {
  connectGarmin,
  planWeekTwoAt,
  runnerToday,
  seedBestEfforts,
  seedLongRun,
  seedPlan,
  seedPushedGarmin,
  seedSessionsOnGarmin,
  syncGarmin,
  waitForBestEfforts,
} from "../fixtures/seed";
import { skipSyncOnOpen } from "../fixtures/sync";

test("today shows the latest run synced from the fixture Garmin account", async ({ page }) => {
  // Through the API, not the UI: the screen under test is the loaded Today, not the sync.
  await connectGarmin(page.request);
  await syncGarmin(page.request);
  // The sync queues the run's best efforts, and its PB chip appears once that job has run. Waiting for it
  // here, rather than on screen, keeps the capture from depending on which side of the job it lands.
  await waitForBestEfforts(page.request);

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

test("today shows the next 7 days of the seeded plan with where each workout stands on Garmin", async ({
  page,
}) => {
  // Pinned to Wed 14 Oct, the next 7 days are 14 to 20 Oct: intervals on Wed 14, easy runs on Fri 16 and
  // Mon 19 and the long run on Sun 18. Three are on Garmin; the long run waits to be sent.
  await seedPlan();
  await seedSessionsOnGarmin(["2026-10-14", "2026-10-16", "2026-10-19"]);
  // Straight into the database, so no push runs: the API pushes the server's real week, which would move
  // these ids. Garmin lists another app's workout in that real week, so its day is masked below.
  await seedPushedGarmin({
    pushedAt: "2026-10-14T05:00:00Z",
    others: [{ scheduleId: 6_000_000_101, date: runnerToday(), title: "Running club track night" }],
  });
  // A latest run above the days, checked for bests and holding none, so no chip waits on a job.
  await seedLongRun();
  await seedBestEfforts([]);
  await page.clock.setFixedTime(planWeekTwoAt);
  await skipSyncOnOpen(page);

  await page.goto("/");
  const days = page.getByRole("region", { name: "Next 7 days" });
  await expect(days.getByRole("listitem")).toHaveCount(7);
  await expect(days.getByRole("listitem").last()).toContainText("Tue 20");
  await expect(days.getByRole("link", { name: /^Intervals, .*, On Garmin$/ })).toBeVisible();
  await expect(days.getByRole("link", { name: /^Long run, .*, Waiting to send$/ })).toBeVisible();
  await expect(days.getByRole("button", { name: "Send to Garmin" })).toBeVisible();
  // The last row on the screen: once it shows, the run and the days above it have rendered.
  const others = page.getByRole("region", { name: "Also on your Garmin calendar" });
  await expect(
    others.getByRole("button", { name: /^Unschedule Running club track night on / }),
  ).toBeVisible();

  await fitViewportToPage(page);
  // The other app's workout is dated in the server's real week; its title is wider than any day, so the
  // masked box keeps one size whatever the date.
  await expect(page).toHaveScreenshot("today-next-7-days.png", {
    fullPage: true,
    mask: [others.locator("time")],
  });
});
