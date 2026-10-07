import { ErrorCode, meResponseSchema, type Problem } from "@running-coach/shared";
import type { Locator, Page, Response } from "@playwright/test";
import { errorMessages } from "../src/lib/errors";
import { seedExpiredGarminLogin } from "./fixtures/seed";
import { expect, test } from "./fixtures/login";

function card(page: Page, title: string): Locator {
  return page.getByRole("region", { name: title, exact: true });
}

function heading(page: Page, title: string): Locator {
  return page.getByRole("heading", { name: title, level: 1 });
}

/** Opens Settings from the tab bar, the way a thumb gets there. */
async function openSettings(page: Page): Promise<void> {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Tabs" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(heading(page, "Settings")).toBeVisible();
}

const isSaveSettings = (response: Response) =>
  response.request().method() === "PATCH" && response.url().endsWith("/api/me/settings");

/** Taps a choice on a Units or Coach detail screen and returns the save's answer. */
async function choose(page: Page, group: string, label: string): Promise<Response> {
  const saved = page.waitForResponse(isSaveSettings);
  // The row is the radio's label: a thumb taps the words, not the 20 px ring.
  await page.getByRole("radiogroup", { name: group }).getByText(label, { exact: true }).click();
  return saved;
}

/** A card's rows in order, each a link named "<label>, <value>" ("Units, Kilometers"). */
async function expectRows(group: Locator, names: readonly string[]): Promise<void> {
  const rows = group.getByRole("link");
  await expect(rows).toHaveCount(names.length);
  for (const [index, name] of names.entries()) {
    await expect(rows.nth(index)).toHaveAccessibleName(name);
  }
}

async function getSettings(page: Page) {
  return meResponseSchema.parse(await (await page.request.get("/api/me")).json()).settings;
}

test("lists each setting with what it holds now, in My stuff and My preferences, above the account", async ({
  page,
  login,
}) => {
  await openSettings(page);

  // Every test starts with Garmin not connected, no Claude key, kilometers and standard detail.
  await expectRows(card(page, "My stuff"), ["Garmin, Not connected", "Claude, No key"]);
  await expectRows(card(page, "My preferences"), [
    "Units, Kilometers",
    "Coach detail, Standard",
    "Heart-rate zones",
  ]);
  await expect(card(page, "Account")).toContainText(login.email);
  await expect(card(page, "Account").getByRole("button", { name: "Log out" })).toBeVisible();
});

test("each row opens its own screen inside the Settings tab, and Back returns to the list", async ({
  page,
}) => {
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  // Each screen's own content, so the test knows it is not only a title over an empty page.
  const screens = [
    {
      row: "Garmin, Not connected",
      title: "Garmin",
      path: "/settings/garmin",
      shows: () => expect(card(page, "Garmin")).toContainText("Not connected."),
    },
    {
      row: "Claude, No key",
      title: "Claude",
      path: "/settings/claude",
      shows: () => expect(card(page, "Claude").getByLabel("Claude API key")).toBeVisible(),
    },
    {
      row: "Units, Kilometers",
      title: "Units",
      path: "/settings/units",
      shows: () => expect(page.getByRole("radio", { name: "Kilometers" })).toBeChecked(),
    },
    {
      row: "Coach detail, Standard",
      title: "Coach detail",
      path: "/settings/coach-detail",
      shows: () => expect(page.getByRole("radio", { name: "Standard" })).toBeChecked(),
    },
    {
      row: "Heart-rate zones",
      title: "Heart-rate zones",
      path: "/settings/hr-zones",
      // No run is stored, so no max HR and no zones yet.
      shows: () =>
        expect(
          page.getByText(
            "No run with heart rate yet: sync one recorded with heart rate to see your zones.",
            { exact: true },
          ),
        ).toBeVisible(),
    },
  ];

  await openSettings(page);
  for (const { row, title, path, shows } of screens) {
    await page.getByRole("link", { name: row, exact: true }).click();
    await expect(heading(page, title)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await shows();
    await expect(tabs.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.getByRole("link", { name: "Back" }).click();
    await expect(heading(page, "Settings")).toBeVisible();
    await expect(page).toHaveURL(/\/settings$/);
  }
});

test("Miles is saved at once, stays after a reload, and the Units row says Miles", async ({
  page,
}) => {
  await openSettings(page);
  await page.getByRole("link", { name: "Units, Kilometers" }).click();
  const kilometers = page.getByRole("radio", { name: "Kilometers" });
  const miles = page.getByRole("radio", { name: "Miles" });
  await expect(kilometers).toBeChecked();
  // Each choice shows the same 10 km run in its own unit.
  await expect(miles).toHaveAccessibleDescription("6.2 mi at 8:51 /mi, 394 ft climb");
  await expect(kilometers).toHaveAccessibleDescription("10.0 km at 5:30 /km, 120 m climb");

  expect((await choose(page, "Units", "Miles")).ok()).toBe(true);
  await expect(miles).toBeChecked();
  expect((await getSettings(page)).units).toBe("mi");

  await page.reload();
  await expect(miles).toBeChecked();
  await expect(kilometers).not.toBeChecked();

  await page.getByRole("link", { name: "Back" }).click();
  await expect(heading(page, "Settings")).toBeVisible();
  await expect(page.getByRole("link", { name: "Units, Miles" })).toBeVisible();
});

test("Detailed coach reviews are saved at once and the Coach detail row says Detailed", async ({
  page,
}) => {
  await openSettings(page);
  await page.getByRole("link", { name: "Coach detail, Standard" }).click();
  await expect(page.getByRole("radio", { name: "Standard" })).toBeChecked();

  expect((await choose(page, "Coach detail", "Detailed")).ok()).toBe(true);
  await expect(page.getByRole("radio", { name: "Detailed" })).toBeChecked();
  expect((await getSettings(page)).coachDetail).toBe("detailed");

  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("link", { name: "Coach detail, Detailed" })).toBeVisible();
});

test("a unit that does not save says so and goes back to Kilometers", async ({ page }) => {
  const failure = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: ErrorCode.internal,
    requestId: "e2e-units-failure",
  } satisfies Problem;
  await page.route("**/api/me/settings", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: failure.status,
          contentType: "application/problem+json",
          body: JSON.stringify(failure),
        })
      : route.continue(),
  );
  await openSettings(page);
  await page.getByRole("link", { name: "Units, Kilometers" }).click();

  expect((await choose(page, "Units", "Miles")).status()).toBe(500);

  await expect(page.getByRole("alert")).toHaveText(errorMessages.internal);
  await expect(page.getByRole("radio", { name: "Kilometers" })).toBeChecked();
  expect((await getSettings(page)).units).toBe("km");
});

test("an expired Garmin login shows on its row, and its screen says how to reconnect", async ({
  page,
}) => {
  await seedExpiredGarminLogin();
  await openSettings(page);

  await page.getByRole("link", { name: "Garmin, Login expired" }).click();
  await expect(heading(page, "Garmin")).toBeVisible();
  await expect(card(page, "Garmin")).toContainText(
    "To reconnect, run pnpm garmin:connect with this app's address on your laptop.",
  );
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

  await expect(card(page, "Account")).toContainText(login.email);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
