import { expect, test } from "../fixtures/login";

test("settings", async ({ page, login }) => {
  await page.goto("/settings");
  // The last row on the screen: once it shows, every section above it has rendered from /api/me.
  await expect(page.getByRole("region", { name: "Account" }).getByText(login.email)).toBeVisible();

  // Nothing here depends on the clock while Garmin is not connected. Screens that show a time, a date or
  // "Last sync" pass those locators in `mask`.
  await expect(page).toHaveScreenshot("settings.png", { fullPage: true });
});
