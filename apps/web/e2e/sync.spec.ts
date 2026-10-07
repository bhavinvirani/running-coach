import { meResponseSchema, type MeResponse } from "@running-coach/shared";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { errorMessages } from "../src/lib/errors";
import { garminCopy } from "../src/screens/garmin/garmin-copy";
import { connectGarmin, seedExpiredGarminLogin, seedLongRun } from "./fixtures/seed";
import { garminRateLimited, garminUnavailable, isSyncPost, recordSyncPosts } from "./fixtures/sync";
import { expect, test } from "./fixtures/login";

// The app syncs by itself when it opens (useSyncOnOpen) while Garmin is connected and working, no sync
// runs, and both the last sync and this device's last attempt are 10 minutes old or more. connectGarmin
// pins the last sync to Sat 26 Sep 2026, so a test that connects opens onto a due sync. A test that lets
// one reach the API waits for its answer, so no sync writes into the next test's reset runner.

const emptySentence = "Sync now to bring in your latest run from Garmin.";

function syncNow(page: Page): Locator {
  return page.getByRole("button", { name: "Sync now" });
}

function syncing(page: Page): Locator {
  return page.getByRole("button", { name: "Syncing…" });
}

/** The figure under a label in a row or card ("Distance", "Last sync"). */
function figure(scope: Locator, label: string): Locator {
  return scope.getByText(label, { exact: true }).locator("xpath=following-sibling::*[1]");
}

/** The fixture's 18 km run of Sun 27 Sep 2026, 08:00, the one run a sync from the pinned cursor stores. */
async function expectFixtureRun(page: Page): Promise<void> {
  const card = page.getByRole("region", { name: "Latest run" });
  await expect(card.locator("time")).toHaveText("Sun 27 Sep, 08:00");
  await expect(figure(card, "Distance")).toHaveText(/^18\.0\s*km$/);
}

async function garmin(request: APIRequestContext): Promise<MeResponse["garmin"]> {
  return meResponseSchema.parse(await (await request.get("/api/me")).json()).garmin;
}

/**
 * Holds every POST /api/sync until the returned release() is called, then lets it through to the API
 * unchanged: the fixture sync answers too fast to see "Syncing…" otherwise.
 */
async function holdSyncs(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/sync", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  return release;
}

// One test for the sync on open, the tap during it and the open after it: one real sync serves all three.
test("opening the app syncs without a tap, a tap meanwhile starts no second sync, and opening it again within 10 minutes does not sync", async ({
  page,
}) => {
  await connectGarmin(page.request);
  const before = await garmin(page.request);
  const posts = recordSyncPosts(page);
  const release = await holdSyncs(page);

  await page.goto("/");
  const busy = syncing(page);
  await expect(busy).toBeDisabled();
  await expect(busy).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
  // A thumb on the busy button: disabled, so the tap does nothing.
  await busy.click({ force: true });
  const synced = page.waitForResponse((response) => isSyncPost(response.request()));
  release();
  expect((await synced).ok()).toBe(true);

  // Enabled again means no sync is running or queued behind the first, so the count is final.
  await expectFixtureRun(page);
  await expect(syncNow(page)).toBeEnabled();
  expect(posts).toHaveLength(1);
  const after = await garmin(page.request);
  expect(after.status).toBe("ok");
  expect(Date.parse(after.lastSyncAt ?? "")).toBeGreaterThan(Date.parse(before.lastSyncAt ?? ""));

  // Opened again right away: the last sync and this device's attempt are seconds old. The app decides as
  // it mounts, before the run is on screen, and a sync would turn Sync now into "Syncing…".
  await page.reload();
  await expectFixtureRun(page);
  await expect(syncNow(page)).toBeEnabled();
  expect(posts).toHaveLength(1);
});

test("an expired Garmin login shows Reconnect Garmin instead of Sync now, which opens the Garmin screen, and opening the app does not sync", async ({
  page,
}) => {
  await seedExpiredGarminLogin();
  const posts = recordSyncPosts(page);

  await page.goto("/");
  // In the empty state the line and the link take the place of the sentence and Sync now.
  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_auth_expired);
  const reconnect = page.getByRole("link", { name: "Reconnect Garmin" });
  await expect(reconnect).toBeVisible();
  await expect(syncNow(page)).toHaveCount(0);
  await expect(syncing(page)).toHaveCount(0);
  await expect(page.getByText(emptySentence, { exact: true })).toHaveCount(0);
  expect(posts).toHaveLength(0);

  await reconnect.click();
  await expect(page.getByRole("heading", { name: "Garmin", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/garmin$/);
  const section = page.getByRole("region", { name: "Garmin" });
  await expect(figure(section, "Status")).toHaveText("Login expired");
  // The seeded cursor in the runner's default zone, UTC.
  await expect(figure(section, "Last sync")).toHaveText("Sat 26 Sep 2026, 12:00");
  await expect(section.getByText(garminCopy.reconnectIntro, { exact: true })).toBeVisible();
  await expect(
    section.getByRole("button", { name: garminCopy.reconnect.idle, exact: true }),
  ).toBeVisible();
  expect(posts).toHaveLength(0);
});

test("an expired Garmin login keeps the latest run, with Reconnect Garmin in the header", async ({
  page,
}) => {
  await seedExpiredGarminLogin();
  await seedLongRun();
  const posts = recordSyncPosts(page);

  await page.goto("/");
  await expectFixtureRun(page);
  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_auth_expired);
  await expect(page.getByRole("link", { name: "Reconnect Garmin" })).toBeVisible();
  await expect(syncNow(page)).toHaveCount(0);
  expect(posts).toHaveLength(0);
});

test("a Garmin outage on open shows the error with Retry, and the app does not retry by itself", async ({
  page,
}) => {
  await connectGarmin(page.request);
  const posts = recordSyncPosts(page);
  // The open sync meets Garmin down, the Retry after it Garmin's 429; neither reaches the API.
  const answers = [garminUnavailable, garminRateLimited];
  let sent = 0;
  await page.route("**/api/sync", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const answer = answers[sent] ?? garminRateLimited;
    sent += 1;
    await route.fulfill(answer);
  });

  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_unavailable);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
  // Enabled means the failed sync has settled: nothing retried it.
  await expect(syncNow(page)).toBeEnabled();
  expect(posts).toHaveLength(1);

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_rate_limited);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(syncNow(page)).toBeEnabled();
  expect(posts).toHaveLength(2);

  // Opened again within 10 minutes of the failed attempt: the last sync is still days old, yet the app
  // leaves Garmin alone until the runner taps.
  await page.reload();
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
  await expect(syncNow(page)).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(posts).toHaveLength(2);
});

test("opening the app without Garmin connected does not sync", async ({ page }) => {
  const posts = recordSyncPosts(page);

  await page.goto("/");
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();
  await expect(syncNow(page)).toBeEnabled();
  expect(posts).toHaveLength(0);
});
