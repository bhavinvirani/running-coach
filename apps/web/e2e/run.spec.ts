import {
  ErrorCode,
  RACE_EVENT_TYPE,
  activityResponseSchema,
  type Problem,
} from "@running-coach/shared";
import type { Locator, Page, Request } from "@playwright/test";
import { errorMessages } from "../src/lib/errors";
import {
  connectGarmin,
  fixtureRunIds,
  seedLongRun,
  seedRunDetail,
  syncFromRaceDay,
  syncGarmin,
  waitForBestEfforts,
} from "./fixtures/seed";
import { expect, test } from "./fixtures/login";

/** POST /api/activities/:id/detail, the run screen's Garmin fetch; nothing else has that path. */
const isDetailFetch = (url: URL) => /^\/api\/activities\/[^/]+\/detail$/.test(url.pathname);
const isDetailPost = (request: Request) =>
  request.method() === "POST" && isDetailFetch(new URL(request.url()));

/** A uuid no run has: the API answers 404. */
const unknownRunId = "00000000-0000-4000-8000-000000000000";

/** Opens Progress from the tab bar, the way a thumb gets there. */
async function openProgress(page: Page): Promise<void> {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Tabs" })
    .getByRole("link", { name: "Progress" })
    .click();
  await expect(page.getByRole("heading", { name: "Progress", level: 1 })).toBeVisible();
}

/** Taps a run's row on Progress by its local day ("Sun 27 Sep"), which starts its accessible name. */
async function openRun(page: Page, day: string): Promise<void> {
  await page.getByRole("link", { name: new RegExp(`^${day},`) }).click();
  await expect(page.getByRole("heading", { name: day, level: 1 })).toBeVisible();
}

function section(page: Page, title: string): Locator {
  return page.getByRole("region", { name: title, exact: true });
}

/** The figure under a stat's label in the summary, unit included ("18.0" and "km" side by side). */
function stat(page: Page, label: string): Locator {
  return section(page, "Summary")
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::*[1]");
}

/**
 * The line above the stats: start time, Race chip, PB chip, Indoor. The dots between them are items spaced
 * by a gap, so the text reads "18:30·Indoor"; a chip leads with its own dot instead, "07:30Race8 PBs".
 */
function startLine(page: Page): Locator {
  return section(page, "Summary").locator("p", { has: page.locator("time") });
}

/** The rows of Best efforts, one per distance the run covered, shortest first. */
function effortRows(page: Page): Locator {
  return section(page, "Best efforts")
    .getByRole("list", { name: "Best efforts" })
    .getByRole("listitem");
}

/** The pace bars' rows, one per lap shown. */
function splitBars(page: Page): Locator {
  return section(page, "Splits").getByRole("list", { name: "Splits" }).getByRole("listitem");
}

/**
 * One lap of the pace bars: its bar is an image named by the lap's pace, and the text after it is the change
 * from the lap before ("+0:04" faster, "-0:25" slower), blank on the first lap.
 */
async function expectSplitBar(page: Page, lap: number, pace: string, delta: string) {
  const row = splitBars(page).nth(lap - 1);
  await expect(row.locator(":scope > span").first()).toHaveText(String(lap));
  await expect(row.getByRole("img")).toHaveAccessibleName(pace);
  // The delta is followed by a visually hidden "faster" or "slower" for screen readers; an empty delta
  // must be empty, which toContainText("") would not check.
  const deltaCell = row.locator(":scope > span").last();
  if (delta === "") await expect(deltaCell).toHaveText("");
  else await expect(deltaCell).toContainText(delta);
}

/** One lap of the splits table (Show table): lap, distance, pace and average HR. */
function split(page: Page, lap: number): Locator {
  return section(page, "Splits").getByRole("row").nth(lap).getByRole("cell");
}

/** The id at the end of /runs/:id. */
function runId(page: Page): string {
  const id = new URL(page.url()).pathname.split("/").at(-1);
  if (!id) throw new Error(`No run id in ${page.url()}`);
  return id;
}

async function getRun(page: Page, id: string) {
  const response = await page.request.get(`/api/activities/${id}`);
  expect(response.ok()).toBe(true);
  return activityResponseSchema.parse(await response.json());
}

/** The first lap of the fixture Garmin's detail (detail-splits.json): 1000 m in 390.422 s, 167 bpm. */
const fixtureFirstPace = "6:30 /km";

const unavailable = {
  type: "about:blank",
  title: "Bad Gateway",
  status: 502,
  code: ErrorCode.garminUnavailable,
  requestId: "e2e-detail-unavailable",
} satisfies Problem;

test("opens a stored race from Progress with its stats, splits, charts and route, and Back returns", async ({
  page,
}) => {
  await seedLongRun({ race: true });
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");
  const detailPosts: string[] = [];
  page.on("request", (request) => {
    if (isDetailPost(request)) detailPosts.push(request.url());
  });

  await openProgress(page);
  await openRun(page, "Sun 27 Sep");
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);

  // 18 km in 6120 s: 1:42:00, or 5:40 per km, marked as a race in Garmin Connect.
  await expect(section(page, "Summary").locator("time")).toHaveText("08:00");
  await expect(startLine(page)).toHaveText("08:00Race");
  await expect(startLine(page).getByText("Race", { exact: true })).toBeVisible();
  await expect(stat(page, "Distance")).toHaveText(/^18\.0\s*km$/);
  await expect(stat(page, "Time")).toHaveText("1:42:00");
  await expect(stat(page, "Avg pace")).toHaveText(/^5:40\s*\/km$/);
  await expect(stat(page, "Elevation gain")).toHaveText(/^142\s*m$/);
  await expect(stat(page, "Avg HR")).toHaveText(/^148\s*bpm$/);
  await expect(stat(page, "Cadence")).toHaveText(/^168\s*spm$/);
  await expect(stat(page, "Calories")).toHaveText(/^1,150\s*kcal$/);

  // The seeded laps (seed.ts) as pace bars, the first 12 of 18, each with its change from the lap before:
  // 5:52 then 5:48 (4 s faster), the hill on km 10 at 6:06 (25 s slower than 5:41), the descent at 5:31
  // (35 s faster), and the fast last km at 5:06 (28 s faster than 5:34).
  const splits = section(page, "Splits");
  await expect(splitBars(page)).toHaveCount(12);
  await expectSplitBar(page, 1, "5:52 /km", "");
  await expectSplitBar(page, 2, "5:48 /km", "+0:04");
  await expectSplitBar(page, 10, "6:06 /km", "-0:25");
  await expectSplitBar(page, 11, "5:31 /km", "+0:35");
  await expect(splits.getByRole("table")).toHaveCount(0);

  await splits.getByRole("button", { name: "Show all 18 laps" }).click();
  await expect(splitBars(page)).toHaveCount(18);
  await expectSplitBar(page, 18, "5:06 /km", "+0:28");
  await splits.getByRole("button", { name: "Show fewer" }).click();
  await expect(splitBars(page)).toHaveCount(12);

  // The table view lists the same 12 laps with their average HR, and shares Show all.
  await splits.getByRole("button", { name: "Show table" }).click();
  const table = splits.getByRole("table", { name: "Splits" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Lap",
    "Distance",
    "Pace /km",
    "Avg HR",
  ]);
  await expect(table.getByRole("row")).toHaveCount(1 + 12);
  await expect(split(page, 1)).toHaveText(["1", "1.0 km", "5:52", "140"]);
  await expect(split(page, 10)).toHaveText(["10", "1.0 km", "6:06", "158"]);
  await expect(split(page, 11)).toHaveText(["11", "1.0 km", "5:31", "150"]);
  await expect(splitBars(page)).toHaveCount(0);
  await splits.getByRole("button", { name: "Show all 18 laps" }).click();
  await expect(table.getByRole("row")).toHaveCount(1 + 18);
  await expect(split(page, 18)).toHaveText(["18", "1.0 km", "5:06", "165"]);
  await splits.getByRole("button", { name: "Show chart" }).click();
  await expect(table).toHaveCount(0);
  await expect(splitBars(page)).toHaveCount(18);

  const route = section(page, "Route");
  await expect(route.getByRole("img", { name: "Route sketch" })).toBeVisible();
  await expect(route.getByText("Route only: no map token.", { exact: true })).toBeVisible();

  const charts = [
    ["Heart rate zones", "Heart rate zones chart"],
    ["Cadence", "Cadence chart"],
    ["Elevation", "Elevation chart"],
  ] as const;
  for (const [title, chart] of charts) {
    await expect(section(page, title).getByRole("img", { name: chart })).toBeVisible();
    await expect(section(page, title).getByRole("button", { name: "Show table" })).toBeVisible();
  }

  // The long run's 6120 s by zone (seed.ts): 180, 1260, 3120, 1440 and 120 s.
  const zones = section(page, "Heart rate zones");
  await zones.getByRole("button", { name: "Show table" }).click();
  const zoneRows = zones.getByRole("table", { name: "Heart rate zones" }).getByRole("row");
  await expect(zoneRows).toHaveText([
    /^Zone\s*Time\s*Share$/,
    /^Z1 98\+\s*03:00\s*3%$/,
    /^Z2 118\+\s*21:00\s*21%$/,
    /^Z3 137\+\s*52:00\s*51%$/,
    /^Z4 157\+\s*24:00\s*24%$/,
    /^Z5 176\+\s*02:00\s*2%$/,
  ]);
  await expect(zones.getByRole("img", { name: "Heart rate zones chart" })).toHaveCount(0);
  await zones.getByRole("button", { name: "Show chart" }).click();
  await expect(zones.getByRole("img", { name: "Heart rate zones chart" })).toBeVisible();

  // A stored detail is shown as it is: the screen never asks Garmin again.
  expect(detailPosts).toEqual([]);

  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Progress", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/progress$/);
});

// One test for the failure and the fetch that follows: each Garmin connect counts against the API's six a
// minute, which the whole suite shares.
test("the first open fetches the detail from Garmin: a failure keeps the stats, and Retry stores it", async ({
  page,
}) => {
  await connectGarmin(page.request);
  await syncGarmin(page.request);
  const detailPosts: string[] = [];
  page.on("request", (request) => {
    if (isDetailPost(request)) detailPosts.push(request.url());
  });
  // The first fetch meets Garmin down. The next is held until its loading state has been seen, then goes
  // through to the API unchanged: the fixture Garmin answers too fast to catch it otherwise.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let fetches = 0;
  await page.route(isDetailFetch, async (route) => {
    fetches += 1;
    if (fetches === 1) {
      await route.fulfill({
        status: unavailable.status,
        contentType: "application/problem+json",
        body: JSON.stringify(unavailable),
      });
      return;
    }
    await held;
    await route.continue();
  });

  await openProgress(page);
  await openRun(page, "Sun 27 Sep");

  // The screen asks for the detail by itself; the failure leaves the stats from the stored run.
  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_unavailable);
  await expect(stat(page, "Distance")).toHaveText(/^18\.0\s*km$/);
  await expect(section(page, "Splits")).toHaveCount(0);

  await page.getByRole("button", { name: "Retry" }).click();
  const loading = page.getByRole("status", { name: "Loading laps, route and zones" });
  await expect(loading).toContainText("Getting laps, route and zones from Garmin.");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(stat(page, "Distance")).toHaveText(/^18\.0\s*km$/);
  const fetched = page.waitForResponse((response) => isDetailPost(response.request()));
  release();
  expect((await fetched).ok()).toBe(true);

  // The fixture's 17 laps: 6:30, then 6:49, 19 s slower.
  await expectSplitBar(page, 1, fixtureFirstPace, "");
  await expectSplitBar(page, 2, "6:49 /km", "-0:19");
  await expect(
    section(page, "Splits").getByRole("button", { name: "Show all 17 laps" }),
  ).toBeVisible();
  // The fixture Garmin gives an outdoor run a made-up loop in open ocean.
  const route = section(page, "Route");
  await expect(route.getByRole("img", { name: "Route sketch" })).toBeVisible();
  await expect(route.getByText("Route only: no map token.", { exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  // The failed fetch and the Retry: the screen never retries a Garmin fetch by itself.
  expect(detailPosts).toHaveLength(2);

  const id = runId(page);
  const stored = await getRun(page, id);
  expect(stored.detail).not.toBeNull();
  expect(stored.detail?.laps[0]).toMatchObject({
    index: 1,
    distanceM: 1000,
    durationS: 390.422,
    avgHr: 167,
  });
  expect(stored.detail?.route?.length).toBeGreaterThan(1);
  expect(stored.detail?.hrZones).toHaveLength(5);
  // A second read answers from the database, the same detail again.
  expect((await getRun(page, id)).detail).toEqual(stored.detail);

  // Opened again, the run shows the stored detail without another Garmin fetch.
  await page.reload();
  await expectSplitBar(page, 1, fixtureFirstPace, "");
  expect(detailPosts).toHaveLength(2);
});

// One sync for the three runs: each Garmin connect counts against the API's six a minute.
test("a treadmill run has no route or elevation, a run without heart rate has no zones, and a race says so", async ({
  page,
}) => {
  // From this cursor the sync stores the fixture's six runs of 6 to 27 Sep. Its best-efforts job finds the
  // same efforts in every outdoor run (the fixture serves one set of samples), so ties go to the earliest
  // run, the race of Sun 6 Sep, which holds every best. Waiting for the job keeps the PB chips and rows
  // from depending on which side of it a screen opens.
  await connectGarmin(page.request, syncFromRaceDay);
  expect((await syncGarmin(page.request)).activitiesWritten).toBe(6);
  await waitForBestEfforts(page.request);
  const fetched = () => page.waitForResponse((response) => isDetailPost(response.request()));

  await openProgress(page);
  let detail = fetched();
  await openRun(page, "Thu 24 Sep");
  expect((await detail).ok()).toBe(true);

  // Garmin has the treadmill run uncategorized: no Race chip. The job never computes an indoor run's
  // efforts, so no PB chip and no Best efforts either.
  await expect(section(page, "Summary").locator("time")).toHaveText("18:30");
  await expect(startLine(page)).toHaveText("18:30·Indoor");
  await expect(section(page, "Summary").getByText("Race", { exact: true })).toHaveCount(0);
  await expect(section(page, "Best efforts")).toHaveCount(0);
  await expect(stat(page, "Elevation gain")).toHaveText("–");
  await expectSplitBar(page, 1, fixtureFirstPace, "");
  const route = section(page, "Route");
  await expect(route.getByText("Indoor run: no GPS route.", { exact: true })).toBeVisible();
  await expect(route.getByRole("img")).toHaveCount(0);
  await expect(section(page, "Elevation")).toContainText("No elevation recorded.");
  await expect(section(page, "Elevation").getByRole("img")).toHaveCount(0);
  await expect(
    section(page, "Heart rate zones").getByRole("img", { name: "Heart rate zones chart" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Progress", level: 1 })).toBeVisible();
  detail = fetched();
  await openRun(page, "Wed 16 Sep");
  expect((await detail).ok()).toBe(true);

  await expect(stat(page, "Avg HR")).toHaveText("–");
  await expectSplitBar(page, 1, fixtureFirstPace, "");
  // Its efforts tie the race's, which is earlier and holds the bests: the rows show, none marked PB.
  await expect(startLine(page)).toHaveText("19:00");
  await expect(effortRows(page)).toHaveCount(8);
  await expect(section(page, "Best efforts").getByText("PB", { exact: true })).toHaveCount(0);
  // The table's Avg HR column shows the dash for every lap.
  await section(page, "Splits").getByRole("button", { name: "Show table" }).click();
  await expect(split(page, 1)).toHaveText(["1", "1.0 km", "6:30", "–"]);
  const zones = section(page, "Heart rate zones");
  await expect(
    zones.getByText("No heart rate recorded, so no zones.", { exact: true }),
  ).toBeVisible();
  await expect(zones.getByRole("img")).toHaveCount(0);
  await expect(zones.getByRole("button", { name: "Show table" })).toHaveCount(0);
  // Outdoors, so the route and elevation are there.
  await expect(section(page, "Route").getByRole("img", { name: "Route sketch" })).toBeVisible();
  await expect(
    section(page, "Elevation").getByRole("img", { name: "Elevation chart" }),
  ).toBeVisible();

  // The 10.2 km of Sun 6 Sep is a race in Garmin Connect: its row names it and its screen shows the chip.
  // 3300 s over 10.2 km is 5:24 per km.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Progress", level: 1 })).toBeVisible();
  const raceRow = page.getByRole("link", { name: /^Sun 6 Sep,/ });
  await expect(raceRow).toHaveAccessibleName("Sun 6 Sep, Race · 8 PBs, 10.2 km, 55:00, 5:24 /km");
  await expect(raceRow.getByText("Race", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Thu 24 Sep,/ })).toHaveAccessibleName(
    "Thu 24 Sep, Indoor, 8.0 km, 45:00, 5:38 /km",
  );
  detail = fetched();
  await openRun(page, "Sun 6 Sep");
  expect((await detail).ok()).toBe(true);

  await expect(startLine(page)).toHaveText("07:30Race8 PBs");
  await expect(startLine(page).getByText("Race", { exact: true })).toBeVisible();
  await expect(startLine(page).getByText("8 PBs", { exact: true })).toBeVisible();
  await expect(stat(page, "Distance")).toHaveText(/^10\.2\s*km$/);
  // Every effort is a best, shortest first; the times are the fixture samples' (personal-bests.spec.ts).
  await expect(effortRows(page)).toHaveCount(8);
  await expect(effortRows(page).first()).toContainText("1K");
  await expect(effortRows(page).last()).toContainText("10 mi");
  await expect(section(page, "Best efforts").getByText("PB", { exact: true })).toHaveCount(8);
  await expectSplitBar(page, 1, fixtureFirstPace, "");
  const stored = await getRun(page, runId(page));
  expect(stored.activity.eventType).toBe(RACE_EVENT_TYPE);
});

test("says a run does not exist for an unknown id and for a malformed one", async ({ page }) => {
  const runRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/activities/")) {
      runRequests.push(request.url());
    }
  });

  const missing = page.waitForResponse((response) =>
    response.url().endsWith(`/api/activities/${unknownRunId}`),
  );
  await page.goto(`/runs/${unknownRunId}`);
  expect((await missing).status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Run", level: 1 })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText(errorMessages.not_found);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  // Opened from a link, the run has no earlier screen in the app: Back goes to Progress.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Progress", level: 1 })).toBeVisible();

  runRequests.length = 0;
  await page.goto("/runs/not-a-run");
  await expect(page.getByRole("heading", { name: "Run", level: 1 })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText(errorMessages.not_found);
  // A malformed id fails without asking the API.
  expect(runRequests).toEqual([]);
});
