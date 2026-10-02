import { ErrorCode } from "@running-coach/shared";
import { expect, test } from "@playwright/test";
import { ApiError } from "../src/api/client";
import { logInErrorMessage } from "../src/lib/errors";
import { runner } from "./fixtures/seed";

// Signed out on purpose: plain Playwright `test`, not the login fixture.

// The text the login form shows for a 401, taken from src/lib/errors.ts so the copy lives in one place.
const wrongCredentials = logInErrorMessage(
  new ApiError({ status: 401, code: ErrorCode.unauthorized }),
);

test("says the email or password is wrong and stays on the login screen", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("Email").fill(runner.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();

  await expect(page.getByRole("alert")).toHaveText(wrongCredentials);
  await expect(page).toHaveURL(/\/login$/);
});

test("lands on Today with the right password", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("Email").fill(runner.email);
  await page.getByLabel("Password").fill(runner.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/:\d+\/$/);
  // Signed out, so no reset ran: whatever runs are stored, Today has loaded once Sync now shows.
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
});
