import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { seedExpiredGarminLogin } from "../fixtures/seed";

test("settings shows the seeded runner's defaults and account", async ({ page, login }) => {
  await page.goto("/settings");
  // The last row on the screen: once it shows, every section above it has rendered from /api/me.
  await expect(page.getByRole("region", { name: "Account" }).getByText(login.email)).toBeVisible();

  // Taller than the viewport since the Claude section: without this the tab bar covers Account.
  await fitViewportToPage(page);
  // Nothing here depends on the clock while Garmin is not connected. Screens that show a time, a date or
  // "Last sync" the clock decides pass those locators in `mask`.
  await expect(page).toHaveScreenshot("settings.png", { fullPage: true });
});

test("settings shows an expired Garmin login with its last sync and how to reconnect", async ({
  page,
  login,
}) => {
  await seedExpiredGarminLogin();

  await page.goto("/settings");
  await expect(page.getByRole("region", { name: "Garmin" })).toContainText("Login expired");
  // The last row on the screen: once it shows, every section above it has rendered from /api/me.
  await expect(page.getByRole("region", { name: "Account" }).getByText(login.email)).toBeVisible();

  await fitViewportToPage(page);
  // No mask: "Last sync" is the seeded cursor, Sat 26 Sep 2026, 12:00 in the default zone (UTC), not a time
  // the clock decides.
  await expect(page).toHaveScreenshot("settings-expired.png", { fullPage: true });
});

test("settings shows the owner's coach on the Claude plan, with no key form", async ({
  page,
  login,
}) => {
  const chosen = await page.request.patch("/api/me/settings", {
    data: { coachCredential: "plan" },
  });
  expect(chosen.ok()).toBe(true);

  await page.goto("/settings");
  await expect(
    page
      .getByRole("region", { name: "Claude", exact: true })
      .getByText(/^The coach runs on your Claude plan/),
  ).toBeVisible();
  // The last row on the screen: once it shows, every section above it has rendered from /api/me.
  await expect(page.getByRole("region", { name: "Account" }).getByText(login.email)).toBeVisible();

  await fitViewportToPage(page);
  // Nothing here depends on the clock while Garmin is not connected.
  await expect(page).toHaveScreenshot("settings-plan.png", { fullPage: true });
});
