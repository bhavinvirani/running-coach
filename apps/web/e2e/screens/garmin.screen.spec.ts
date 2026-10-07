import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { seedExpiredGarminLogin } from "../fixtures/seed";

test("garmin shows an expired login with its last sync and how to reconnect", async ({ page }) => {
  await seedExpiredGarminLogin();

  await page.goto("/settings/garmin");
  const garmin = page.getByRole("region", { name: "Garmin" });
  await expect(garmin).toContainText("Login expired");
  // The last row on the screen.
  await expect(
    garmin.getByText(
      "To reconnect, run pnpm garmin:connect with this app's address on your laptop.",
    ),
  ).toBeVisible();

  await fitViewportToPage(page);
  // No mask: "Last sync" is the seeded cursor, Sat 26 Sep 2026, 12:00 in the default zone (UTC), not a time
  // the clock decides.
  await expect(page).toHaveScreenshot("garmin-expired.png", { fullPage: true });
});
