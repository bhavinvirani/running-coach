import {
  ErrorCode,
  latestActivityResponseSchema,
  meResponseSchema,
  type SyncResponse,
} from "@running-coach/shared";
import type { Locator, Page, Route } from "@playwright/test";
import { errorMessages } from "../src/lib/errors";
import { connectGarmin, seedLongRun } from "./fixtures/seed";
import { garminRateLimited, garminUnavailable, skipSyncOnOpen, syncProblem } from "./fixtures/sync";
import { expect, test } from "./fixtures/login";

const emptySentence = "Sync now to bring in your latest run from Garmin.";
const wakingSentence = "Waking the server. After 15 minutes idle this takes up to a minute.";

function todayHeading(page: Page): Locator {
  return page.getByRole("heading", { name: "Today", level: 1 });
}

/** The figure under a stat's label on the Latest run card, unit included ("5:40" and "/km" side by side). */
function figure(card: Locator, label: string): Locator {
  return card.getByText(label, { exact: true }).locator("xpath=following-sibling::*[1]");
}

/** The fixture's 18 km run of Sun 27 Sep 2026, 08:00, in km: 6120 s is 1:42:00, or 5:40 per km. */
async function expectLongRun(card: Locator): Promise<void> {
  await expect(card.locator("time")).toHaveText("Sun 27 Sep, 08:00");
  await expect(figure(card, "Distance")).toHaveText(/^18\.0\s*km$/);
  await expect(figure(card, "Time")).toHaveText("1:42:00");
  await expect(figure(card, "Pace")).toHaveText(/^5:40\s*\/km$/);
  await expect(figure(card, "Avg HR")).toHaveText(/^148\s*bpm$/);
}

function isSyncNow(route: Route): boolean {
  return route.request().method() === "POST";
}

const authExpired = syncProblem({
  type: "about:blank",
  title: "Conflict",
  status: 409,
  code: ErrorCode.garminAuthExpired,
  detail: "Garmin rejected the saved login. Connect Garmin again.",
  requestId: "e2e-sync-auth-expired",
});

test("says to sync when no run is stored yet", async ({ page }) => {
  await page.goto("/");

  await expect(todayHeading(page)).toBeVisible();
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
  // The empty state's one action; the header leaves it out.
  await expect(page.getByRole("button", { name: "Sync now" })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Latest run" })).toHaveCount(0);
});

test("Sync now brings in the 18 km fixture run and stores it", async ({ page }) => {
  await connectGarmin(page.request);
  // The tap is under test, so the app opens without its own sync (sync.spec.ts covers that one).
  await skipSyncOnOpen(page);
  // The sync is held until the busy button has been seen, then goes through to the API unchanged: the
  // fixture sync answers too fast to catch "Syncing…" otherwise.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/sync", async (route) => {
    if (isSyncNow(route)) await held;
    await route.continue();
  });

  await page.goto("/");
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).click();

  const syncing = page.getByRole("button", { name: "Syncing…" });
  await expect(syncing).toBeDisabled();
  await expect(syncing).toHaveAttribute("aria-busy", "true");
  const synced = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/sync"),
  );
  release();
  expect((await synced).ok()).toBe(true);

  const card = page.getByRole("region", { name: "Latest run" });
  await expectLongRun(card);
  await expect(card).not.toContainText("Indoor");
  // Garmin has the fixture's long run uncategorized: the card names no type. The sync also queues the
  // run's best efforts, so the PB chip joins the name whenever that job lands (personal-bests.spec.ts).
  await expect(card.getByRole("link")).toHaveAccessibleName(
    /^Open the latest run, Sun 27 Sep, 08:00, (8 PBs, )?18\.0 km, 1:42:00$/,
  );
  await expect(card.getByText("Race", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
  await expect(page.getByText(emptySentence, { exact: true })).toHaveCount(0);

  const latest = latestActivityResponseSchema.parse(
    await (await page.request.get("/api/activities/latest")).json(),
  );
  expect(latest.activity).toMatchObject({
    type: "running",
    startLocal: "2026-09-27T08:00:00",
    distanceM: 18_000,
    durationS: 6120,
    avgHr: 148,
    isIndoor: false,
  });
  const me = meResponseSchema.parse(await (await page.request.get("/api/me")).json());
  expect(me.garmin.status).toBe("ok");
  expect(me.garmin.lastSyncAt).not.toBeNull();
});

test("names a latest run marked as a race in Garmin Connect, with its Race chip", async ({
  page,
}) => {
  await seedLongRun({ race: true });

  await page.goto("/");
  const card = page.getByRole("region", { name: "Latest run" });
  await expectLongRun(card);
  await expect(card.getByText("Race", { exact: true })).toBeVisible();
  await expect(card.getByRole("link")).toHaveAccessibleName(
    "Open the latest run, Sun 27 Sep, 08:00, Race, 18.0 km, 1:42:00",
  );
});

test("says to connect Garmin when Sync now runs before it is connected", async ({ page }) => {
  // The real API's 409, no interception: nothing is connected after the reset.
  await page.goto("/");
  await page.getByRole("button", { name: "Sync now" }).click();

  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_not_connected);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
});

test("says the Garmin login expired, keeps the run, and Retry syncs again", async ({ page }) => {
  await seedLongRun();
  const answers = [
    authExpired,
    {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        lastSyncAt: "2026-09-27T12:00:00.000Z",
        activitiesWritten: 0,
        activitiesRemoved: 0,
      } satisfies SyncResponse),
    },
  ];
  let sent = 0;
  await page.route("**/api/sync", async (route) => {
    if (!isSyncNow(route)) return route.continue();
    const answer = answers[sent] ?? authExpired;
    sent += 1;
    await route.fulfill(answer);
  });

  await page.goto("/");
  const card = page.getByRole("region", { name: "Latest run" });
  await expectLongRun(card);
  await page.getByRole("button", { name: "Sync now" }).click();

  await expect(page.getByRole("alert")).toHaveText("Garmin login expired. Reconnect in Settings.");
  await expectLongRun(card);
  await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();

  const resent = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/sync"),
  );
  await page.getByRole("button", { name: "Retry" }).click();
  expect((await resent).ok()).toBe(true);

  // Enabled again means the retried sync has settled, so a missing alert is its final state.
  await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(sent).toBe(2);
  await expectLongRun(card);
});

test("says Garmin is limiting requests, with Retry, and keeps the run", async ({ page }) => {
  await seedLongRun();
  await page.route("**/api/sync", (route) =>
    isSyncNow(route) ? route.fulfill(garminRateLimited) : route.continue(),
  );

  await page.goto("/");
  const card = page.getByRole("region", { name: "Latest run" });
  await expectLongRun(card);
  await page.getByRole("button", { name: "Sync now" }).click();

  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_rate_limited);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expectLongRun(card);
});

test("says Garmin is not responding, with Retry, and keeps the empty state", async ({ page }) => {
  await page.route("**/api/sync", (route) =>
    isSyncNow(route) ? route.fulfill(garminUnavailable) : route.continue(),
  );

  await page.goto("/");
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).click();

  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_unavailable);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
});

test("explains a slow start while the server wakes, then opens Today", async ({ page }) => {
  // The boot request (GET /api/me, awaited by the route loader) is held until the sentence shows, then
  // answered by the API: a server that takes longer than 3 s to wake.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/me", async (route) => {
    await held;
    await route.continue();
  });

  await page.goto("/");
  // The sentence appears 3 s after the app starts; 10 s covers that plus loading the bundle.
  await expect(page.getByRole("status")).toHaveText(wakingSentence, { timeout: 10_000 });
  await expect(todayHeading(page)).toHaveCount(0);
  release();

  await expect(todayHeading(page)).toBeVisible();
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
  await expect(page.getByText(wakingSentence)).toHaveCount(0);
});

test("opens Today when the boot request first meets a waking server's 503", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/me", async (route) => {
    calls += 1;
    if (calls === 1) {
      // Render's proxy answers a sleeping service with an HTML page, not problem+json.
      await route.fulfill({
        status: 503,
        contentType: "text/html",
        body: "<h1>Service Unavailable</h1>",
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/");

  // One retry, after a jittered delay of at most a second.
  await expect(todayHeading(page)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(calls).toBe(2);
});

test("Today is the first tab and Settings opens from the tab bar", async ({ page, login }) => {
  await page.goto("/");
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  const today = tabs.getByRole("link", { name: "Today" });
  const settings = tabs.getByRole("link", { name: "Settings" });

  await expect(tabs.getByRole("link")).toHaveText(["Today", "Plan", "Progress", "Settings"]);
  await expect(today).toHaveAttribute("aria-current", "page");

  await settings.click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("region", { name: "Account" })).toContainText(login.email);
  await expect(settings).toHaveAttribute("aria-current", "page");
  await expect(today).not.toHaveAttribute("aria-current", "page");

  await today.click();
  await expect(todayHeading(page)).toBeVisible();
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
});
