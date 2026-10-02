import {
  ErrorCode,
  latestActivityResponseSchema,
  personalBestsResponseSchema,
  type PersonalBestsResponse,
  type Problem,
} from "@running-coach/shared";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { errorMessages } from "../src/lib/errors";
import {
  bestsCheckedAt,
  connectGarmin,
  fixtureRunIds,
  historyBestEfforts,
  historyRunIds,
  indoorAndManualEfforts,
  seedBestEfforts,
  seedRunDetail,
  seedRunHistory,
  seedTreadmillRun,
} from "./fixtures/seed";
import { expect, test } from "./fixtures/login";

/** The badges of historyBestEfforts (seed.ts), longest first, named as a screen reader reads them. */
const historyBadges = [
  "15K, 1:25:52, 27 Sep 2026, New",
  "10K, 56:41, 27 Sep 2026, New",
  "5 mi, 45:10, 13 Sep 2026",
  "5K, 27:29, 10 Sep 2026",
  "2 mi, 17:21, 10 Sep 2026",
  "1 mi, 8:12, 10 Sep 2026",
  "1K, 4:58, 2 Sep 2026",
];
/** The whole row for historyBestEfforts: its badges, then the distances no run reached, longest first. */
const historyRow = [
  "15K",
  "10K",
  "5 mi",
  "5K",
  "2 mi",
  "1 mi",
  "1K",
  "Marathon",
  "Half",
  "20K",
  "10 mi",
];

/**
 * What the real best-efforts job finds in the fixture Garmin's detail samples (16.7 km, served for any run
 * of the account), on the fixture's 18 km run of Sun 27 Sep, beside the fixture's own records (1K 4:48,
 * mile 7:51, 5K 28:22, 10K 58:18, half 2:08:51). The samples reach 10 mi but not 20K.
 */
const fixtureBadges = [
  "10 mi, 1:44:08, 27 Sep 2026, New",
  "15K, 1:36:46, 27 Sep 2026, New",
  "10K, 1:04:17, 27 Sep 2026, Garmin 58:18, New",
  "5 mi, 51:08, 27 Sep 2026, New",
  "5K, 31:22, 27 Sep 2026, Garmin 28:22, New",
  "2 mi, 19:54, 27 Sep 2026, New",
  "1 mi, 9:40, 27 Sep 2026, Garmin 7:51, New",
  "1K, 5:54, 27 Sep 2026, Garmin 4:48, New",
];
/** The whole row after the sync: its badges, then the distances the samples do not reach. */
const fixtureRow = [
  "10 mi",
  "15K",
  "10K",
  "5 mi",
  "5K",
  "2 mi",
  "1 mi",
  "1K",
  "Marathon",
  "Half",
  "20K",
];
const fixtureChip = "8 PBs";

/** Under the tiles once Garmin's records are in. */
const garminCaption = "Garmin keeps records for 1K, 1 mi, 5K, 10K, half and marathon only.";

const isPersonalBests = (url: URL) => url.pathname === "/api/personal-bests";

test.beforeEach(async ({ page }) => {
  // "New" is measured from the browser's clock: pinned three days after the newest run, the badges read
  // the same whatever the date. Only Date is faked; timers, the bests' 15 s poll among them, run as usual.
  await page.clock.setFixedTime(bestsCheckedAt);
});

/** Opens Progress from the tab bar, the way a thumb gets there. */
async function openProgress(page: Page): Promise<void> {
  await page.goto("/");
  await tab(page, "Progress").click();
  await expect(page.getByRole("heading", { name: "Progress", level: 1 })).toBeVisible();
}

function tab(page: Page, name: string): Locator {
  return page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name });
}

function bestsCard(page: Page): Locator {
  return page.getByRole("region", { name: "Personal bests" });
}

/** The badges as one row of tiles that scrolls sideways under the heading. */
function tileRow(card: Locator): Locator {
  return card.getByRole("list", { name: "Personal bests" });
}

/**
 * A tile by its label ("5K", "Half"), in Personal bests or a run's Best efforts: on Progress whether it
 * links to a run or says no run reached it.
 */
function tile(section: Locator, label: string): Locator {
  return section
    .getByRole("listitem")
    .filter({ has: section.page().getByText(label, { exact: true }) });
}

/** Every badge that opens a run, in order, by its accessible name. */
async function expectBadgeLinks(card: Locator, names: readonly string[]): Promise<void> {
  const links = card.getByRole("link");
  await expect(links).toHaveCount(names.length);
  for (const [position, name] of names.entries()) {
    await expect(links.nth(position)).toHaveAccessibleName(name);
  }
}

/** Every tile of the row, left to right, by the distance it shows. */
async function expectRowOrder(card: Locator, labels: readonly string[]): Promise<void> {
  const tiles = tileRow(card).getByRole("listitem");
  await expect(tiles).toHaveCount(labels.length);
  for (const [position, label] of labels.entries()) {
    await expect(tiles.nth(position).getByText(label, { exact: true })).toHaveCount(1);
  }
}

/** Distances no run has reached, and only those: each badge says so and opens nothing. */
async function expectNoRunYet(card: Locator, labels: readonly string[]): Promise<void> {
  for (const label of labels) {
    await expect(tile(card, label)).toContainText("No run yet");
    await expect(tile(card, label).getByRole("link")).toHaveCount(0);
  }
  await expect(card.getByText("No run yet", { exact: true })).toHaveCount(labels.length);
}

function week(page: Page, range: string): Locator {
  return page.getByRole("region", { name: range, exact: true });
}

function section(page: Page, title: string): Locator {
  return page.getByRole("region", { name: title, exact: true });
}

/** The run screen's line above the stats: start time, then the Race and PB chips, each with its own dot. */
function startLine(page: Page): Locator {
  return section(page, "Summary").locator("p", { has: page.locator("time") });
}

/**
 * The run screen's Best efforts, tile by tile from the left: distance, time cut to the second, pace, and the
 * PB chip on a current best. A screen reader hears each tile as one sentence instead (run-screen.test.tsx).
 */
async function expectBestEfforts(
  page: Page,
  tiles: readonly (readonly [string, string, string, "PB" | ""])[],
): Promise<void> {
  const items = section(page, "Best efforts")
    .getByRole("list", { name: "Best efforts" })
    .getByRole("listitem");
  await expect(items).toHaveCount(tiles.length);
  for (const [position, [label, time, pace, chip]] of tiles.entries()) {
    // The tile's lines as drawn, hidden from screen readers: the distance with the chip on its right, the
    // time, the pace. The chip sits beside the distance with no space between, so the line reads "5KPB".
    const lines = items.nth(position).locator(':scope > * > [aria-hidden="true"]');
    await expect(lines).toHaveText([`${label}${chip}`, time, pace]);
    await expect(lines.first().locator(":scope > span")).toHaveText(chip ? [label, chip] : [label]);
  }
}

/** A run's row link on Progress by its local day ("Thu 10 Sep"), which starts its accessible name. */
function runRow(section: Locator, day: string): Locator {
  return section.getByRole("link", { name: new RegExp(`^${day},`) });
}

async function personalBests(request: APIRequestContext): Promise<PersonalBestsResponse> {
  const response = await request.get("/api/personal-bests");
  expect(response.ok()).toBe(true);
  return personalBestsResponseSchema.parse(await response.json());
}

// Garmin's records need a Garmin connection, and the API allows six connects a minute per user, which the
// flows already spend (this file's sync, the imports, the run detail fetches, Today's sync). So the seeded
// bests here come without them; the sync below shows the captions from the fixture account's records, and
// progress.screen.spec.ts captures seeded ones.
test("Progress shows a badge per distance with its time and date, and a badge opens its run", async ({
  page,
}) => {
  await seedRunHistory();
  await seedBestEfforts(historyBestEfforts);
  await seedRunDetail(historyRunIds.race, "outdoor");

  await openProgress(page);
  const card = bestsCard(page);
  await expect(card.getByRole("heading", { name: "Personal bests", level: 2 })).toBeVisible();
  await expectBadgeLinks(card, historyBadges);
  await expectNoRunYet(card, ["10 mi", "20K", "Half", "Marathon"]);
  await expect(card).not.toContainText("Garmin");
  // Only the newest run's bests are within a week of the clock.
  await expect(card.getByText("New", { exact: true })).toHaveCount(2);
  // No pending line ("Checking N runs ...", "The next sync checks N runs ...") and no stopped alert.
  await expect(card).not.toContainText("best efforts");
  await expect(card.getByRole("alert")).toHaveCount(0);

  // One row of tiles, the longest best first and the distances no run has reached at the end, each kind
  // longest first: the row reads one way.
  await expectRowOrder(card, historyRow);

  // 15K and 10K whole, 5 mi cut at the screen's edge to say the row goes on, the rest a swipe away. A
  // sideways wheel over the row is the swipe: the desktop browser has no touch.
  const row = tileRow(card);
  await expect(tile(card, "15K")).toBeInViewport({ ratio: 1 });
  await expect(tile(card, "10K")).toBeInViewport({ ratio: 1 });
  await expect(tile(card, "5 mi")).toBeInViewport();
  await expect(tile(card, "5 mi")).not.toBeInViewport({ ratio: 1 });
  await expect(tile(card, "10 mi")).not.toBeInViewport();
  await row.hover();
  await page.mouse.wheel(2000, 0);
  await expect(tile(card, "10 mi")).toBeInViewport({ ratio: 1 });
  await expect(tile(card, "15K")).not.toBeInViewport();
  // The row scrolls on its own: the heading stays where it was.
  await expect(card.getByRole("heading", { name: "Personal bests", level: 2 })).toBeInViewport({
    ratio: 1,
  });

  // The runs holding a best carry its chip in the weeks below; a newer, slower run does not.
  await expect(runRow(week(page, "21–27 Sep"), "Sun 27 Sep")).toHaveAccessibleName(
    "Sun 27 Sep, PB 10K, 15K, 16.0 km, 1:32:00, 5:45 /km",
  );
  await expect(runRow(week(page, "21–27 Sep"), "Tue 22 Sep")).toHaveAccessibleName(
    "Tue 22 Sep, 8.0 km, 44:00, 5:30 /km",
  );
  await expect(runRow(week(page, "7–13 Sep"), "Sun 13 Sep")).toHaveAccessibleName(
    "Sun 13 Sep, PB 5 mi, 12.0 km, 1:09:00, 5:45 /km",
  );
  await expect(runRow(week(page, "7–13 Sep"), "Thu 10 Sep")).toHaveAccessibleName(
    "Thu 10 Sep, Race · 3 PBs, 5.0 km, 27:30, 5:30 /km",
  );
  await expect(runRow(week(page, "31 Aug – 6 Sep"), "Wed 2 Sep")).toHaveAccessibleName(
    "Wed 2 Sep, PB 1K, 7.0 km, 38:30, 5:30 /km",
  );

  const stored = await personalBests(page.request);
  expect(stored.pendingRuns).toBe(0);
  expect(stored.bests.map((best) => [best.distanceKey, best.timeS, best.startLocal])).toEqual([
    ["1k", 298.6, "2026-09-02T18:30:00"],
    ["1mi", 492.9, "2026-09-10T18:30:00"],
    ["2mi", 1041.4, "2026-09-10T18:30:00"],
    ["5k", 1649.7, "2026-09-10T18:30:00"],
    ["5mi", 2710.2, "2026-09-13T08:00:00"],
    ["10k", 3401.8, "2026-09-27T08:00:00"],
    ["15k", 5152.3, "2026-09-27T08:00:00"],
  ]);
  expect(stored.garmin).toBeNull();
  const race = stored.bests.find((best) => best.distanceKey === "5k");
  if (!race) throw new Error("No 5K best stored");

  // Swiped to the end, the 5K tile is off the left edge; the tap brings it back into view first.
  await card.getByRole("link", { name: "5K, 27:29, 10 Sep 2026" }).click();

  await expect(page.getByRole("heading", { name: "Thu 10 Sep", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/runs/${race.activityId}$`));
  // The race holds three bests: the chip counts them and the tiles mark them. Its 1K (5:00) is beaten by
  // the 4:58 of Wed 2 Sep. Pace is worked out from the time as shown: 8:12 over a mile is 5:06 /km.
  await expect(startLine(page)).toHaveText("18:30Race3 PBs");
  await expect(startLine(page).getByText("3 PBs", { exact: true })).toBeVisible();
  await expectBestEfforts(page, [
    ["5K", "27:29", "5:30 /km", "PB"],
    ["2 mi", "17:21", "5:23 /km", "PB"],
    ["1 mi", "8:12", "5:06 /km", "PB"],
    ["1K", "5:00", "5:00 /km", ""],
  ]);
  // The same row as on Progress: 5K and 2 mi whole, 1 mi cut at the screen's edge. The tiles open nothing,
  // as the runner is on the run already.
  const efforts = section(page, "Best efforts");
  await expect(tile(efforts, "5K")).toBeInViewport({ ratio: 1 });
  await expect(tile(efforts, "2 mi")).toBeInViewport({ ratio: 1 });
  await expect(tile(efforts, "1 mi")).toBeInViewport();
  await expect(tile(efforts, "1 mi")).not.toBeInViewport({ ratio: 1 });
  await expect(efforts.getByRole("link")).toHaveCount(0);

  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Progress", level: 1 })).toBeVisible();
  await expectBadgeLinks(bestsCard(page), historyBadges);
});

test("Sync now flags the run that set new bests: its PB chip on Today, then its badges on Progress", async ({
  page,
}) => {
  // From the pinned cursor the sync stores one run, the fixture's 18 km of Sun 27 Sep; the best-efforts
  // job it queues fetches that run's samples and Garmin's records from the fixture service.
  await connectGarmin(page.request);
  await page.goto("/");
  await expect(
    page.getByText("Sync now to bring in your latest run from Garmin.", { exact: true }),
  ).toBeVisible();

  const synced = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/sync"),
  );
  await page.getByRole("button", { name: "Sync now" }).click();
  expect((await synced).ok()).toBe(true);

  const latest = page.getByRole("region", { name: "Latest run" });
  await expect(latest.locator("time")).toHaveText("Sun 27 Sep, 08:00");
  // The sync queues the job before it answers, so the read after it says checking; the worker takes the
  // job within 2 s and Today reads the bests again every 15 s while checking, so the chip shows by the
  // second read at the latest.
  await expect(latest.getByText(fixtureChip, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(latest.getByRole("link")).toHaveAccessibleName(
    `Open the latest run, Sun 27 Sep, 08:00, ${fixtureChip}, 18.0 km, 1:42:00`,
  );

  await tab(page, "Progress").click();
  const card = bestsCard(page);
  await expectBadgeLinks(card, fixtureBadges);
  await expectRowOrder(card, fixtureRow);
  await expectNoRunYet(card, ["20K", "Half", "Marathon"]);
  await expect(tile(card, "Half")).toContainText("Garmin 2:08:51");
  // Garmin's records are in, so the caption under the tiles says why 2 mi, 5 mi, 15K and 10 mi have none.
  await expect(card.getByText(garminCaption, { exact: true })).toBeVisible();
  // No pending line ("Checking N runs ...", "The next sync checks N runs ...") and no stopped alert.
  await expect(card).not.toContainText("best efforts");
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(runRow(week(page, "21–27 Sep"), "Sun 27 Sep")).toHaveAccessibleName(
    `Sun 27 Sep, ${fixtureChip}, 18.0 km, 1:42:00, 5:40 /km`,
  );

  const run = latestActivityResponseSchema.parse(
    await (await page.request.get("/api/activities/latest")).json(),
  ).activity;
  const stored = await personalBests(page.request);
  expect(stored.pendingRuns).toBe(0);
  expect(stored.bests).toHaveLength(fixtureBadges.length);
  expect(stored.bests.every((best) => best.activityId === run?.id)).toBe(true);
  expect(stored.garmin?.records.map((record) => record.distanceKey)).toEqual([
    "1k",
    "1mi",
    "5k",
    "10k",
    "half",
  ]);
});

test("treadmill and manual runs never get a badge or a PB chip, even with faster efforts stored on them", async ({
  page,
}) => {
  await seedRunHistory();
  await seedBestEfforts([...historyBestEfforts, ...indoorAndManualEfforts]);
  await seedRunDetail(historyRunIds.treadmill, "treadmill");

  await openProgress(page);

  // The treadmill run of Thu 24 Sep and the manual one of Thu 17 Sep hold faster efforts than any outdoor
  // run at 1K to 5K, yet every badge names an outdoor run.
  const card = bestsCard(page);
  await expectBadgeLinks(card, historyBadges);
  await expect(runRow(week(page, "21–27 Sep"), "Thu 24 Sep")).toHaveAccessibleName(
    "Thu 24 Sep, Indoor, 6.0 km, 33:00, 5:30 /km",
  );
  await expect(runRow(week(page, "14–20 Sep"), "Thu 17 Sep")).toHaveAccessibleName(
    "Thu 17 Sep, Manual, 5.0 km, 30:00, 6:00 /km",
  );
  await expect(week(page, "21–27 Sep").getByText(/\bPBs?\b/)).toHaveText(["PB 10K, 15K"]);
  await expect(week(page, "14–20 Sep").getByText(/\bPBs?\b/)).toHaveCount(0);

  // Opened, the treadmill run shows neither its stored efforts nor a PB chip. Both come with the run, so
  // once its start line reads Indoor the section's absence is final.
  await runRow(week(page, "21–27 Sep"), "Thu 24 Sep").click();
  await expect(page.getByRole("heading", { name: "Thu 24 Sep", level: 1 })).toBeVisible();
  await expect(startLine(page)).toHaveText("18:45·Indoor");
  await expect(section(page, "Best efforts")).toHaveCount(0);
  await expect(section(page, "Splits")).toBeVisible();
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Progress", level: 1 })).toBeVisible();

  const stored = await personalBests(page.request);
  const excluded = new Set(["2026-09-24T18:45:00", "2026-09-17T07:00:00"]);
  expect(stored.bests).toHaveLength(historyBadges.length);
  expect(stored.bests.filter((best) => excluded.has(best.startLocal))).toEqual([]);
});

test("a treadmill run as the latest run gets no PB chip on Today and no badge", async ({
  page,
}) => {
  await seedTreadmillRun();
  await seedBestEfforts([
    { garminActivityId: fixtureRunIds.treadmill, efforts: { "1k": 290, "1mi": 480, "5k": 1630 } },
  ]);

  await openProgress(page);
  const card = bestsCard(page);
  await expect(card.getByRole("link")).toHaveCount(0);
  // With no best at all, every tile says so, still longest first.
  await expectRowOrder(card, [
    "Marathon",
    "Half",
    "20K",
    "10 mi",
    "15K",
    "10K",
    "5 mi",
    "5K",
    "2 mi",
    "1 mi",
    "1K",
  ]);
  await expectNoRunYet(card, [
    "1K",
    "1 mi",
    "2 mi",
    "5K",
    "5 mi",
    "10K",
    "15K",
    "10 mi",
    "20K",
    "Half",
    "Marathon",
  ]);

  // Today reads the bests Progress just loaded, so the card is drawn with them from its first frame.
  await tab(page, "Today").click();
  const latest = page.getByRole("region", { name: "Latest run" });
  await expect(latest).toContainText("Indoor");
  await expect(latest.getByRole("link")).toHaveAccessibleName(
    "Open the latest run, Thu 24 Sep, 18:30, 8.0 km, 45:00",
  );
  await expect(latest.getByText(/\bPBs?\b/)).toHaveCount(0);

  expect(await personalBests(page.request)).toEqual({
    bests: [],
    garmin: null,
    pendingRuns: 0,
    checking: false,
    errorCode: null,
  });
});

test("keeps the weeks when the bests do not load, says what failed, and Retry brings the badges and chips", async ({
  page,
}) => {
  await seedRunHistory();
  await seedBestEfforts(historyBestEfforts);
  const failure = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: ErrorCode.internal,
    requestId: "e2e-personal-bests-failure",
  } satisfies Problem;
  await page.route(isPersonalBests, (route) =>
    route.fulfill({
      status: failure.status,
      contentType: "application/problem+json",
      body: JSON.stringify(failure),
    }),
  );

  await page.goto("/progress");
  const card = bestsCard(page);
  // The query retries server errors three times with jittered backoff (at most 1 + 2 + 4 s) before the
  // section shows its error, so the wait covers that instead of the default 5 s.
  await expect(card.getByRole("alert")).toHaveText(errorMessages.internal, { timeout: 20_000 });
  await expect(card.getByRole("link")).toHaveCount(0);
  // The weeks load on their own and stay usable, without chips until the bests arrive.
  const race = runRow(week(page, "7–13 Sep"), "Thu 10 Sep");
  await expect(race).toHaveAccessibleName("Thu 10 Sep, Race, 5.0 km, 27:30, 5:30 /km");
  await expect(page.getByRole("alert")).toHaveCount(1);

  await page.unroute(isPersonalBests);
  await card.getByRole("button", { name: "Retry" }).click();

  await expectBadgeLinks(card, historyBadges);
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(race).toHaveAccessibleName("Thu 10 Sep, Race · 3 PBs, 5.0 km, 27:30, 5:30 /km");
});
