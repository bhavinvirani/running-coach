import { ErrorCode, meResponseSchema, type Problem } from "@running-coach/shared";
import { errorMessages } from "../src/lib/errors";
import { expect, test } from "./fixtures/login";

test("shows the account email and that Garmin is not connected", async ({ page, login }) => {
  await page.goto("/settings");

  await expect(page.getByRole("region", { name: "Account" })).toContainText(login.email);
  await expect(page.getByRole("region", { name: "Garmin" })).toContainText("Not connected.");
});

test("keeps miles after a reload and saves them to the account", async ({ page }) => {
  await page.goto("/settings");
  const miles = page.getByRole("radio", { name: "mi", exact: true });
  await expect(page.getByRole("radio", { name: "km", exact: true })).toBeChecked();

  // The control shows the new value at once; wait for the save itself before reloading.
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith("/api/me/settings"),
  );
  // The radio itself is visually hidden; a thumb taps its label.
  await page.getByRole("group", { name: "Units" }).getByText("mi", { exact: true }).click();
  expect((await saved).ok()).toBe(true);

  await page.reload();
  await expect(miles).toBeChecked();

  const me = meResponseSchema.parse(await (await page.request.get("/api/me")).json());
  expect(me.settings.units).toBe("mi");
});

test("says what failed and recovers with Retry when settings do not load", async ({
  page,
  login,
}) => {
  const failure = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: ErrorCode.internal,
    requestId: "e2e-settings-failure",
  } satisfies Problem;
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: failure.status,
      contentType: "application/problem+json",
      body: JSON.stringify(failure),
    }),
  );

  await page.goto("/settings");
  // /api/me is preloaded by the authenticated route's loader, so this exercises the loader and
  // ScreenErrorBoundary, not the screen's own error state. The loader's query retries server errors three
  // times with jittered backoff (at most 2 + 4 + 8 s), so the wait covers that instead of the default 5 s.
  await expect(page.getByRole("alert")).toHaveText(errorMessages.internal, { timeout: 20_000 });

  await page.unroute("**/api/me");
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByRole("region", { name: "Account" })).toContainText(login.email);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
