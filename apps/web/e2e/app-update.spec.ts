import type { MeResponse } from "@running-coach/shared";
import type { Page, Request } from "@playwright/test";
import { versionMismatchMessage } from "../src/lib/errors";
import { expect, test } from "./fixtures/login";

// Service workers are blocked here (playwright.config.ts), so the app learns of another version from what
// the server answers for /index.html, what a reload would load. These tests stand in for a deploy or a
// rollback from one build by routing /api/me, /index.html or a screen's chunk; service-worker.spec.ts covers
// the worker, src/app/app-update.test.ts its takeovers.

/** /api/me as the API sends it, changed the way another version of the API would change it. */
async function changeMe(page: Page, change: (me: MeResponse) => unknown): Promise<void> {
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: change((await response.json()) as MeResponse) });
  });
}

/** Every document load of the page from now on, the first page.goto included. */
function documentLoads(page: Page): Request[] {
  const loads: Request[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads.push(request);
  });
  return loads;
}

/**
 * The server runs another version: its index.html loads another entry script. Records, per document load so
 * far, how often the app asked for it.
 */
async function serverRunsAnotherVersion(page: Page, loads: Request[]): Promise<number[]> {
  const asked: number[] = [];
  await page.route("**/index.html", (route) => {
    asked[loads.length] = (asked[loads.length] ?? 0) + 1;
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><script type="module" src="/assets/index-another.js"></script>',
    });
  });
  return asked;
}

const todayHeading = (page: Page) => page.getByRole("heading", { name: "Today", level: 1 });

test("reads an answer with fields a newer API added, at any depth", async ({ page }) => {
  await changeMe(page, (me) => ({
    ...me,
    addedLater: [1],
    settings: { ...me.settings, weekStart: "mon" },
  }));
  await page.goto("/");

  await expect(todayHeading(page)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("offers Reload for an answer it cannot read, and never reloads by itself while the server runs this version", async ({
  page,
}) => {
  // A coach detail this version does not know.
  await changeMe(page, (me) => ({ ...me, settings: { ...me.settings, coachDetail: "brief" } }));
  const loads = documentLoads(page);
  const probed = page.waitForResponse("**/index.html");
  await page.goto("/");

  await expect(page.getByRole("alert")).toHaveText(versionMismatchMessage);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  // The app decides on the probe's answer, so count once that answer is in and the page has gone quiet.
  await (await probed).finished();
  await page.waitForLoadState("networkidle");
  expect(loads).toHaveLength(1);

  await page.unroute("**/api/me");
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(todayHeading(page)).toBeVisible();
  expect(loads).toHaveLength(2);
});

test("reloads once into the version the server runs, then leaves Reload to the runner", async ({
  page,
}) => {
  await changeMe(page, (me) => ({ ...me, settings: { ...me.settings, coachDetail: "brief" } }));
  const loads = documentLoads(page);
  const asked = await serverRunsAnotherVersion(page, loads);
  await page.goto("/");

  await expect.poll(() => loads.length).toBe(2);
  await expect(page.getByRole("alert")).toHaveText(versionMismatchMessage);
  // The reloaded page could not read the answer either and asked again; one automatic reload per tab is all
  // it gets.
  await expect.poll(() => asked[2] ?? 0).toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");
  expect(loads).toHaveLength(2);
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});

test("shows a screen whose code is gone inside the tabs with Reload, never a blank page", async ({
  page,
}) => {
  const planChunk = /\/assets\/plan-screen-[\w-]+\.js$/;
  await page.route(planChunk, (route) => route.fulfill({ status: 404, body: "" }));
  const loads = documentLoads(page);
  await page.goto("/");
  await expect(todayHeading(page)).toBeVisible();

  const tabs = page.getByRole("navigation", { name: "Tabs" });
  const probed = page.waitForResponse("**/index.html");
  await tabs.getByRole("link", { name: "Plan" }).click();

  await expect(page.getByRole("alert")).toHaveText(versionMismatchMessage);
  await expect(tabs).toBeVisible();
  await expect(page).toHaveURL(/\/plan$/);
  await (await probed).finished();
  await page.waitForLoadState("networkidle");
  expect(loads).toHaveLength(1);

  await page.unroute(planChunk);
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByRole("heading", { name: "Plan", level: 1 })).toBeVisible();
  // networkidle fires once per document and Today may have reached it before the tap, so a reload that the
  // probe's answer started shows here, as a third load.
  expect(loads).toHaveLength(2);
});
