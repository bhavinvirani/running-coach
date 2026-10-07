import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";

// Nothing here depends on the clock: the rows read the seeded runner's settings.

test("settings shows the seeded runner's rows, grouped, with their values and the account", async ({
  page,
  login,
}) => {
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: "Garmin, Not connected" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Heart rate zones" })).toBeVisible();
  // The last row on the screen: once it shows, every card above it has rendered from /api/me.
  await expect(page.getByRole("region", { name: "Account" }).getByText(login.email)).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("settings.png", { fullPage: true });
});
