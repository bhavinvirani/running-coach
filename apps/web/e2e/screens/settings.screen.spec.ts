import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { seedExpiredGarminLogin } from "../fixtures/seed";

// Nothing on these screens depends on the clock: the rows read the seeded runner's settings, and the one
// time shown, the expired login's "Last sync", is the seeded cursor.

test("settings shows the seeded runner's rows, grouped, with their values and the account", async ({
  page,
  login,
}) => {
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: "Garmin, Not connected" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Heart-rate zones" })).toBeVisible();
  // The last row on the screen: once it shows, every card above it has rendered from /api/me.
  await expect(page.getByRole("region", { name: "Account" }).getByText(login.email)).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("settings.png", { fullPage: true });
});

test("settings' Garmin screen shows an expired login with its last sync and how to reconnect", async ({
  page,
}) => {
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
  await expect(page).toHaveScreenshot("settings-expired.png", { fullPage: true });
});

test("settings' Claude screen shows the owner's coach on the Claude plan, with no key form", async ({
  page,
}) => {
  const chosen = await page.request.patch("/api/me/settings", {
    data: { coachCredential: "plan" },
  });
  expect(chosen.ok()).toBe(true);

  await page.goto("/settings/claude");
  const claude = page.getByRole("region", { name: "Claude", exact: true });
  await expect(claude.getByRole("radio", { name: "Claude plan", exact: true })).toBeChecked();
  // The last row on the screen, in place of the key form.
  await expect(claude.getByText(/^The coach runs on your Claude plan/)).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("settings-plan.png", { fullPage: true });
});
