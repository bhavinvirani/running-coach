import type { Locator, Page } from "@playwright/test";
import { garminCopy } from "../../src/screens/garmin/garmin-copy";
import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { connectGarmin, seedExpiredGarminLogin } from "../fixtures/seed";
import { fixtureGarminLogin } from "../fixtures/seed-garmin-login";
import { skipSyncOnOpen } from "../fixtures/sync";

// "Last sync" on the connected and expired screens is the seeded cursor, Sat 26 Sep 2026, 12:00 in the
// default zone (UTC), not a time the clock decides, so nothing is masked.

/** The laptop CLI line, under the Sign in card on both steps of the form. */
const laptopHelp =
  "If signing in here does not work, run pnpm garmin:connect with this app's address on your laptop.";

/** The Connection card: Status and Last sync. */
function connectionCard(page: Page): Locator {
  return page.getByRole("region", { name: garminCopy.connection, exact: true });
}

/** The Sign in card with the form's fields; the form's buttons and the laptop line sit under it. */
function signInCard(page: Page): Locator {
  return page.getByRole("region", { name: garminCopy.signIn, exact: true });
}

test("garmin offers email and password to connect when no login is stored", async ({ page }) => {
  await page.goto("/settings/garmin");
  await expect(connectionCard(page)).toContainText("Not connected");
  await expect(signInCard(page).getByLabel(garminCopy.email, { exact: true })).toBeVisible();
  // The last row on the screen.
  await expect(page.getByText(laptopHelp, { exact: true })).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("garmin-connect.png", { fullPage: true });
});

test("garmin asks for the code Garmin sent once email and password are in", async ({ page }) => {
  await page.goto("/settings/garmin");
  const form = signInCard(page);
  await form.getByLabel(garminCopy.email, { exact: true }).fill(fixtureGarminLogin.email);
  await form.getByLabel(garminCopy.password, { exact: true }).fill(fixtureGarminLogin.password);
  await page.getByRole("button", { name: garminCopy.connect.idle, exact: true }).click();

  await expect(form.getByText(garminCopy.codeSent, { exact: true })).toBeVisible();
  // The code field takes the focus as the step opens, as a thumb finds it.
  await expect(form.getByLabel(garminCopy.code, { exact: true })).toBeFocused();
  await expect(page.getByText(laptopHelp, { exact: true })).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("garmin-code.png", { fullPage: true });
});

test("garmin shows a working login with its last sync and Disconnect Garmin", async ({ page }) => {
  await connectGarmin(page.request);
  // A sync on open would move "Last sync" to now.
  await skipSyncOnOpen(page);

  await page.goto("/settings/garmin");
  const connection = connectionCard(page);
  await expect(connection).toContainText("Connected");
  await expect(connection).toContainText("Sat 26 Sep 2026, 12:00");
  // The last row on the screen.
  await expect(
    page.getByRole("button", { name: garminCopy.disconnect.idle, exact: true }),
  ).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("garmin-connected.png", { fullPage: true });
});

test("garmin shows an expired login with its last sync, the form to reconnect and Disconnect Garmin", async ({
  page,
}) => {
  await seedExpiredGarminLogin();

  await page.goto("/settings/garmin");
  const connection = connectionCard(page);
  await expect(connection).toContainText("Login expired");
  await expect(connection).toContainText("Sat 26 Sep 2026, 12:00");
  await expect(
    signInCard(page).getByText(garminCopy.reconnectIntro, { exact: true }),
  ).toBeVisible();
  // The last row on the screen.
  await expect(
    page.getByRole("button", { name: garminCopy.disconnect.idle, exact: true }),
  ).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("garmin-expired.png", { fullPage: true });
});
