import { ErrorCode, importProgressSchema, type Problem } from "@running-coach/shared";
import type { Locator, Page } from "@playwright/test";
import { errorMessages } from "../src/lib/errors";
import { connectGarmin, importStalled, seedImportProgress, seedRunHistory } from "./fixtures/seed";
import { expect, test } from "./fixtures/login";

const emptySentence = "Import your Garmin history to see your runs by week.";

/** The eight newest weeks of runHistory (seed.ts), newest first: the first page of Progress. */
const firstPageWeeks = [
  "21–27 Sep",
  "14–20 Sep",
  "7–13 Sep",
  "31 Aug – 6 Sep",
  "24–30 Aug",
  "17–23 Aug",
  "10–16 Aug",
  "3–9 Aug",
];
const earlierWeeks = ["27 Jul – 2 Aug", "20–26 Jul"];

/** Runs of Garmin's running list in the fixture account (sync.json and history.json, non-runs left out). */
const fixtureRunCount = 46;

/** Opens Progress from the tab bar, the way a thumb gets there. */
async function openProgress(page: Page): Promise<void> {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Tabs" })
    .getByRole("link", { name: "Progress" })
    .click();
  await expect(page.getByRole("heading", { name: "Progress", level: 1 })).toBeVisible();
}

function importLine(page: Page): Locator {
  return page.getByRole("region", { name: "History import" });
}

function week(page: Page, range: string): Locator {
  return page.getByRole("region", { name: range, exact: true });
}

/** A week's total distance, its unit drawn beside it: "30.0" and "km". */
function weekDistance(section: Locator): Locator {
  return section.locator("p > span").first();
}

/** The run of a given local day inside a week ("Thu 24 Sep"). */
function run(section: Locator, day: string): Locator {
  return section
    .getByRole("listitem")
    .filter({ has: section.page().getByText(day, { exact: true }) });
}

/** Every button that would start, resume or redo the import. */
function importButtons(page: Page): Locator {
  return page.getByRole("button", { name: /^(Import history|Resume import|Import again)$/ });
}

const isActivityWeeks = (url: URL) => url.pathname === "/api/activities";

test("Import history brings in the fixture account's runs by week", async ({ page }) => {
  await connectGarmin(page.request);
  // Polls of GET /api/import after the tap are held until the running line has been seen, then go
  // through to the API unchanged: the fixture import is one page, often done before the first poll.
  let holdPolls = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/import", async (route) => {
    if (holdPolls && route.request().method() === "GET") await held;
    await route.continue();
  });

  await openProgress(page);
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();

  holdPolls = true;
  const started = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/import"),
  );
  await page.getByRole("button", { name: "Import history" }).click();
  expect((await started).ok()).toBe(true);

  // POST /api/import answers with the running import; while it runs nothing offers to start another.
  await expect(importLine(page)).toHaveText(/^Importing history · /);
  await expect(importButtons(page)).toHaveCount(0);
  release();

  // The worker polls for the page every 2 s and the screen polls the import every 3 s.
  await expect(importLine(page)).toContainText(`${fixtureRunCount} runs · history imported`, {
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Import again" })).toBeEnabled();

  // The fixture's newest week: the 18 km run of Sun 27 Sep and the 8 km treadmill run of Thu 24 Sep.
  await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText("21–27 Sep");
  const newest = week(page, "21–27 Sep");
  await expect(weekDistance(newest)).toHaveText(/^26\.0\s*km$/);
  await expect(newest.getByRole("listitem")).toHaveCount(2);
  await expect(run(newest, "Thu 24 Sep")).toContainText("Indoor");
  await expect(page.getByText(emptySentence, { exact: true })).toHaveCount(0);

  const progress = importProgressSchema.parse(await (await page.request.get("/api/import")).json());
  expect(progress).toMatchObject({ status: "done", runsStored: fixtureRunCount, errorCode: null });
});

test("says to connect Garmin when Import history runs before it is connected", async ({ page }) => {
  // The real API's 409, no interception: nothing is connected after the reset.
  await openProgress(page);
  await page.getByRole("button", { name: "Import history" }).click();

  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_not_connected);
  await expect(page.getByRole("button", { name: "Import history" })).toBeEnabled();
  await expect(page.getByText(emptySentence, { exact: true })).toBeVisible();

  const progress = importProgressSchema.parse(await (await page.request.get("/api/import")).json());
  expect(progress.status).toBe("not_started");
});

test("lists runs by week, newest first, and Show earlier weeks loads older ones", async ({
  page,
}) => {
  await seedRunHistory();
  await openProgress(page);

  const ranges = page.getByRole("heading", { level: 2 });
  await expect(ranges).toHaveText(firstPageWeeks);

  const newest = week(page, "21–27 Sep");
  await expect(weekDistance(newest)).toHaveText(/^30\.0\s*km$/);
  await expect(newest).toContainText("2:49:00");
  await expect(newest.getByRole("listitem")).toHaveCount(3);
  await expect(run(newest, "Sun 27 Sep")).toContainText(/16\.0\s*km\s*1:32:00\s*5:45\s*\/km/);
  await expect(run(newest, "Thu 24 Sep")).toContainText("Indoor");
  await expect(run(newest, "Sun 27 Sep")).not.toContainText("Indoor");
  await expect(run(week(page, "14–20 Sep"), "Thu 17 Sep")).toContainText("Manual");
  // The 5 km of Thu 10 Sep is a race in Garmin Connect: its row shows the chip and its name says so.
  const race = run(week(page, "7–13 Sep"), "Thu 10 Sep");
  await expect(race.getByText("Race", { exact: true })).toBeVisible();
  await expect(race.getByRole("link")).toHaveAccessibleName(
    "Thu 10 Sep, Race, 5.0 km, 27:30, 5:30 /km",
  );
  await expect(run(newest, "Sun 27 Sep").getByRole("link")).toHaveAccessibleName(
    "Sun 27 Sep, 16.0 km, 1:32:00, 5:45 /km",
  );
  await expect(weekDistance(week(page, "31 Aug – 6 Sep"))).toHaveText(/^20\.0\s*km$/);

  await page.getByRole("button", { name: "Show earlier weeks" }).click();

  await expect(ranges).toHaveText([...firstPageWeeks, ...earlierWeeks]);
  await expect(weekDistance(week(page, "27 Jul – 2 Aug"))).toHaveText(/^15\.0\s*km$/);
  await expect(weekDistance(week(page, "20–26 Jul"))).toHaveText(/^12\.0\s*km$/);
  // Nothing older is stored, so the list ends there.
  await expect(page.getByRole("button", { name: "Show earlier weeks" })).toHaveCount(0);
});

test("shows the week totals in miles once Settings switches units", async ({ page }) => {
  await seedRunHistory();
  await page.goto("/settings");

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith("/api/me/settings"),
  );
  // The radio itself is visually hidden; a thumb taps its label.
  await page.getByRole("group", { name: "Units" }).getByText("mi", { exact: true }).click();
  expect((await saved).ok()).toBe(true);

  await page
    .getByRole("navigation", { name: "Tabs" })
    .getByRole("link", { name: "Progress" })
    .click();

  // 30 km is 18.64 mi; the 16 km run is 9.94 mi at 9:15 per mile.
  const newest = week(page, "21–27 Sep");
  await expect(weekDistance(newest)).toHaveText(/^18\.6\s*mi$/);
  await expect(run(newest, "Sun 27 Sep")).toContainText(/9\.9\s*mi\s*1:32:00\s*9:15\s*\/mi/);
  await expect(weekDistance(week(page, "14–20 Sep"))).toHaveText(/^16\.8\s*mi$/);
  await expect(page.getByRole("main")).not.toContainText("km");
});

test("says what failed when the runs do not load, and Retry recovers", async ({ page }) => {
  await seedRunHistory();
  const failure = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: ErrorCode.internal,
    requestId: "e2e-activities-failure",
  } satisfies Problem;
  await page.route(isActivityWeeks, (route) =>
    route.fulfill({
      status: failure.status,
      contentType: "application/problem+json",
      body: JSON.stringify(failure),
    }),
  );

  await openProgress(page);
  // The query retries server errors three times with jittered backoff (at most 1 + 2 + 4 s) before the
  // screen shows its error, so the wait covers that instead of the default 5 s.
  await expect(page.getByRole("alert")).toHaveText(errorMessages.internal, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);

  await page.unroute(isActivityWeeks);
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByRole("heading", { level: 2 })).toHaveText(firstPageWeeks);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("says when a paused import continues, in the runner's time zone", async ({ page }) => {
  // A real pause needs Garmin's 429 and a deferred page job; the API tests cover that path, so this one
  // answers GET /api/import with the paused import and checks what the line says.
  const paused = importProgressSchema.parse({
    status: "paused",
    runsStored: 0,
    oldestDate: null,
    startedAt: "2026-09-28T06:00:00.000Z",
    finishedAt: null,
    resumeAt: "2036-01-15T14:05:00.000Z",
    errorCode: ErrorCode.garminRateLimited,
  });
  await page.route("**/api/import", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: paused }) : route.continue(),
  );
  // 14:05 UTC on 15 Jan is 09:05 in New York (EST, UTC-5).
  const zone = await page.request.patch("/api/me/settings", {
    data: { timezone: "America/New_York" },
  });
  expect(zone.ok()).toBe(true);

  await openProgress(page);

  await expect(importLine(page)).toHaveText(
    "Garmin is limiting requests. The import continues after 09:05.",
  );
  await expect(importButtons(page)).toHaveCount(0);
  await expect(page.getByText("No runs yet.", { exact: true })).toBeVisible();
});

test("Resume import finishes an import whose job chain died", async ({ page }) => {
  await connectGarmin(page.request);
  await seedImportProgress(importStalled);

  await openProgress(page);
  await expect(importLine(page)).toContainText(
    "The import stopped. Resume import to carry on where it left off.",
  );

  await page.getByRole("button", { name: "Resume import" }).click();

  await expect(importLine(page)).toContainText(`${fixtureRunCount} runs · history imported`, {
    timeout: 15_000,
  });
  const progress = importProgressSchema.parse(await (await page.request.get("/api/import")).json());
  expect(progress).toMatchObject({ status: "done", runsStored: fixtureRunCount, errorCode: null });
});
