import {
  ErrorCode,
  activityResponseSchema,
  latestActivityResponseSchema,
  shoesResponseSchema,
  type Problem,
  type Shoe,
} from "@running-coach/shared";
import type { Locator, Page, Request, Response } from "@playwright/test";
import { errorMessages } from "../src/lib/errors";
import { shoeCopy, statusLines } from "../src/screens/shoe/shoe-copy";
import { shoesCopy } from "../src/screens/shoes/shoes-copy";
import {
  connectGarmin,
  fixtureRunIds,
  seedLongRun,
  seedRunDetail,
  syncGarmin,
} from "./fixtures/seed";
import { pairs, seedPair, wearPair } from "./fixtures/seed-shoes";
import { expect, test } from "./fixtures/login";

function heading(page: Page, title: string): Locator {
  return page.getByRole("heading", { name: title, level: 1 });
}

function region(page: Page, title: string): Locator {
  return page.getByRole("region", { name: title, exact: true });
}

/** Taps a tab in the tab bar, the way a thumb moves between them. */
async function openTab(page: Page, tab: "Progress" | "Settings"): Promise<void> {
  await page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: tab }).click();
  await expect(heading(page, tab)).toBeVisible();
}

/** A pair's row on a Shoes card: a link whose name starts with the pair's name. */
function pairRow(card: Locator, name: string): Locator {
  return card.getByRole("link", { name: new RegExp(`^${name}`) });
}

/** Taps a run's row on Progress by its local day ("Sun 27 Sep"), which starts its accessible name. */
async function openRun(page: Page, day: string): Promise<void> {
  await page.getByRole("link", { name: new RegExp(`^${day},`) }).click();
  await expect(heading(page, day)).toBeVisible();
}

/** The run screen's Shoes section. */
function runShoes(page: Page): Locator {
  return region(page, "Shoes");
}

/** Change, described by the pair the run wears ("None" without one). */
function changeButton(page: Page): Locator {
  return runShoes(page).getByRole("button", { name: "Change", exact: true });
}

const pathOf = (request: Request) => new URL(request.url()).pathname;

/** PUT /api/activities/:id/shoe, a run's pair; nothing else has that path. */
const isRunShoePath = (url: URL) => /^\/api\/activities\/[^/]+\/shoe$/.test(url.pathname);
const isRunShoeSave = (response: Response) =>
  response.request().method() === "PUT" && isRunShoePath(new URL(response.url()));

const isAddShoes = (response: Response) =>
  response.request().method() === "POST" && pathOf(response.request()) === "/api/shoes";

/** A change of one pair: POST /api/shoes/:id/retire, DELETE /api/shoes/:id. */
function isPairChange(method: "POST" | "DELETE", id: string, action = "") {
  return (response: Response) =>
    response.request().method() === method &&
    pathOf(response.request()) === `/api/shoes/${id}${action}`;
}

/** POST /api/activities/:id/detail, the run screen's Garmin fetch on a run's first open. */
const isDetailPost = (response: Response) =>
  response.request().method() === "POST" &&
  /^\/api\/activities\/[^/]+\/detail$/.test(pathOf(response.request()));

/**
 * Opens Change on the run screen and taps a pair, or None, by its words (the row is the radio's label, so a
 * thumb taps the words); returns the save's answer.
 */
async function chooseRunShoe(page: Page, label: string): Promise<Response> {
  await changeButton(page).click();
  await expect(changeButton(page)).toHaveAttribute("aria-expanded", "true");
  const saved = page.waitForResponse(isRunShoeSave);
  await runShoes(page)
    .getByRole("radiogroup", { name: "Shoes for this run" })
    .getByText(label, { exact: true })
    .click();
  return saved;
}

async function getShoes(page: Page): Promise<Shoe[]> {
  const response = await page.request.get("/api/shoes");
  expect(response.ok()).toBe(true);
  return shoesResponseSchema.parse(await response.json()).shoes;
}

/** The runner's pair of that model, as the API has it. */
async function storedPair(page: Page, model: string): Promise<Shoe> {
  const pair = (await getShoes(page)).find((shoe) => shoe.model === model);
  if (!pair) throw new Error(`The runner has no ${model}`);
  return pair;
}

/** The newest stored run's id. */
async function latestRunId(page: Page): Promise<string> {
  const response = await page.request.get("/api/activities/latest");
  expect(response.ok()).toBe(true);
  const { activity } = latestActivityResponseSchema.parse(await response.json());
  if (!activity) throw new Error("No run is stored");
  return activity.id;
}

/** The pair a stored run wears, by the API. */
async function runShoeId(page: Page, id: string): Promise<string | null> {
  const response = await page.request.get(`/api/activities/${id}`);
  expect(response.ok()).toBe(true);
  return activityResponseSchema.parse(await response.json()).shoeId;
}

/** The fixture's 18 km run of Sun 27 Sep, stored with its laps, wearing a pair: no Garmin call on open. */
async function seedLongRunWearing(pairId: string): Promise<void> {
  await seedLongRun();
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");
  await wearPair(fixtureRunIds.longRun, pairId);
}

// One sync for the pair it puts on the run and both changes after it.
test("a pair added from Settings goes on the next synced run, whose pair then changes to another or None", async ({
  page,
}) => {
  // A pair in use but not on new runs, to change the run to.
  await seedPair(pairs.ridge);
  const ridge = await storedPair(page, "Ridge 2");

  await page.goto("/");
  await openTab(page, "Settings");
  // Ridge 2 is not active, so no pair goes on new runs yet.
  await page.getByRole("link", { name: "Shoes, None", exact: true }).click();
  await expect(heading(page, shoesCopy.title)).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/shoes$/);
  await page.getByRole("link", { name: shoesCopy.add, exact: true }).click();
  await expect(heading(page, shoeCopy.newTitle)).toBeVisible();

  await page.getByLabel(shoeCopy.brand, { exact: true }).fill("Northpace");
  await page.getByLabel(shoeCopy.model, { exact: true }).fill("Glide 4");
  await page.getByLabel(shoeCopy.colour, { exact: true }).fill("Slate");
  // The default goal, nothing run before the app, and no active pair: the new one goes on new runs.
  await expect(page.getByLabel(shoeCopy.retireAt, { exact: true })).toHaveValue("650");
  await expect(page.getByLabel(shoeCopy.startDistance, { exact: true })).toHaveValue("0");
  await expect(page.getByRole("checkbox", { name: shoeCopy.useForNewRuns })).toBeChecked();
  const added = page.waitForResponse(isAddShoes);
  await page.getByRole("button", { name: shoeCopy.add, exact: true }).click();
  expect((await added).status()).toBe(201);

  // Back on the list, the new pair comes first as the active one, with nothing run yet.
  await expect(heading(page, shoesCopy.title)).toBeVisible();
  const inUse = region(page, shoesCopy.inUse);
  await expect(inUse.getByRole("link")).toHaveCount(2);
  const glideRow = inUse.getByRole("link").first();
  await expect(glideRow).toContainText("Northpace Glide 4");
  await expect(glideRow).toContainText(shoesCopy.active);
  await expect(glideRow).toContainText("0.0 of 650 km");
  await expect(glideRow).toContainText("0 runs");
  await expect(pairRow(inUse, "Northpace Ridge 2")).not.toContainText(shoesCopy.active);
  const glide = await storedPair(page, "Glide 4");
  expect(glide).toMatchObject({
    brand: "Northpace",
    colour: "Slate",
    nickname: null,
    active: true,
    retiredAt: null,
    retireDistanceM: 650_000,
    startDistanceM: 0,
    runs: 0,
  });

  // The fixture Garmin's 18 km run of Sun 27 Sep is new to the app: the sync puts the active pair on it.
  await connectGarmin(page.request);
  expect((await syncGarmin(page.request)).activitiesWritten).toBe(1);

  // Settings names the active pair, and its row on Shoes counts the run: 18 km in 1:42:00.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(heading(page, "Settings")).toBeVisible();
  await page.getByRole("link", { name: "Shoes, Northpace Glide 4", exact: true }).click();
  await expect(heading(page, shoesCopy.title)).toBeVisible();
  await expect(glideRow).toContainText("18.0 of 650 km");
  await expect(glideRow).toContainText("1 run");
  await expect(glideRow).toContainText("1:42:00");
  expect(await storedPair(page, "Glide 4")).toMatchObject({
    distanceM: 18_000,
    runs: 1,
    durationS: 6120,
  });

  await openTab(page, "Progress");
  const detail = page.waitForResponse(isDetailPost);
  await openRun(page, "Sun 27 Sep");
  expect((await detail).ok()).toBe(true);
  const runId = await latestRunId(page);
  await expect(runShoes(page).getByText("Northpace Glide 4", { exact: true })).toBeVisible();
  await expect(changeButton(page)).toHaveAccessibleDescription("Northpace Glide 4");
  expect(await runShoeId(page, runId)).toBe(glide.id);

  // Another pair: shown at once, saved, and still there after a reload; the run counts toward it alone.
  expect((await chooseRunShoe(page, "Northpace Ridge 2")).ok()).toBe(true);
  await expect(changeButton(page)).toHaveAccessibleDescription("Northpace Ridge 2");
  await expect(runShoes(page).getByRole("radio", { name: "Northpace Ridge 2" })).toBeChecked();
  await expect(runShoes(page).getByRole("status")).toHaveCount(0);
  expect(await runShoeId(page, runId)).toBe(ridge.id);
  await page.reload();
  await expect(changeButton(page)).toHaveAccessibleDescription("Northpace Ridge 2");
  await expect(changeButton(page)).toHaveAttribute("aria-expanded", "false");
  expect(await storedPair(page, "Ridge 2")).toMatchObject({ distanceM: 18_000, runs: 1 });
  expect(await storedPair(page, "Glide 4")).toMatchObject({ distanceM: 0, runs: 0 });

  // None: the run counts toward no pair.
  expect((await chooseRunShoe(page, "None")).ok()).toBe(true);
  await expect(changeButton(page)).toHaveAccessibleDescription("None");
  await page.reload();
  await expect(changeButton(page)).toHaveAccessibleDescription("None");
  expect(await runShoeId(page, runId)).toBeNull();
  expect(await storedPair(page, "Ridge 2")).toMatchObject({ distanceM: 0, runs: 0 });
});

test("Retire shoes moves a pair to Retired, and Delete shoes keeps its run, which then wears None", async ({
  page,
}) => {
  const glideId = await seedPair(pairs.glide, { active: true });
  await seedLongRunWearing(glideId);
  // A second pair, so the run screen still offers a choice once Glide 4 is gone.
  await seedPair(pairs.ridge);

  await page.goto("/settings/shoes");
  await expect(heading(page, shoesCopy.title)).toBeVisible();
  await pairRow(region(page, shoesCopy.inUse), "Northpace Glide 4").click();
  await expect(heading(page, shoeCopy.editTitle)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/settings/shoes/${glideId}$`));
  await expect(page.getByText(statusLines.Active, { exact: true })).toBeVisible();

  const retired = page.waitForResponse(isPairChange("POST", glideId, "/retire"));
  await page.getByRole("button", { name: shoeCopy.retire, exact: true }).click();
  expect((await retired).ok()).toBe(true);
  await expect(page.getByText(statusLines.Retired, { exact: true })).toBeVisible();
  // A retired pair can be worn again, not retired twice.
  await expect(page.getByRole("button", { name: shoeCopy.retire, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: shoeCopy.makeActive, exact: true })).toBeVisible();
  expect(await storedPair(page, "Glide 4")).toMatchObject({
    active: false,
    retiredAt: expect.any(String),
  });

  // On the list it moves to Retired and keeps its run; no pair in use is active.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(heading(page, shoesCopy.title)).toBeVisible();
  const retiredCard = region(page, shoesCopy.retired);
  await expect(retiredCard.getByRole("link")).toHaveCount(1);
  await expect(pairRow(retiredCard, "Northpace Glide 4")).toContainText("18.0 of 650 km");
  const inUse = region(page, shoesCopy.inUse);
  await expect(inUse.getByRole("link")).toHaveCount(1);
  await expect(pairRow(inUse, "Northpace Ridge 2")).toBeVisible();
  await expect(inUse).not.toContainText(shoesCopy.active);

  await pairRow(retiredCard, "Northpace Glide 4").click();
  await expect(heading(page, shoeCopy.editTitle)).toBeVisible();
  await page.getByRole("button", { name: shoeCopy.remove, exact: true }).click();
  const confirm = page.getByRole("group", { name: shoeCopy.removeQuestion });
  await expect(confirm).toBeVisible();
  const deleted = page.waitForResponse(isPairChange("DELETE", glideId));
  await confirm.getByRole("button", { name: shoeCopy.remove, exact: true }).click();
  expect((await deleted).ok()).toBe(true);

  // Back on the list without it, and without the Retired card.
  await expect(heading(page, shoesCopy.title)).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/shoes$/);
  await expect(region(page, shoesCopy.retired)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^Northpace Glide 4/ })).toHaveCount(0);
  expect((await getShoes(page)).map((shoe) => shoe.model)).toEqual(["Ridge 2"]);

  // The run stays, with no pair.
  const runId = await latestRunId(page);
  expect(await runShoeId(page, runId)).toBeNull();
  await openTab(page, "Progress");
  await openRun(page, "Sun 27 Sep");
  await expect(changeButton(page)).toHaveAccessibleDescription("None");
});

test("in miles the goal reads in mi: the default 650 km shows as 404 mi and stays 650 km", async ({
  page,
}) => {
  const units = await page.request.patch("/api/me/settings", { data: { units: "mi" } });
  expect(units.ok()).toBe(true);

  await page.goto("/settings/shoes");
  await expect(page.getByText(shoesCopy.empty, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: shoesCopy.add, exact: true }).click();
  await expect(heading(page, shoeCopy.newTitle)).toBeVisible();
  const retireAt = page.getByLabel(shoeCopy.retireAt, { exact: true });
  await expect(retireAt).toHaveValue("404");
  await expect(retireAt).toHaveAccessibleDescription(
    "In miles. Running shoes lose their cushioning at about 404 mi.",
  );

  await page.getByLabel(shoeCopy.brand, { exact: true }).fill("Northpace");
  await page.getByLabel(shoeCopy.model, { exact: true }).fill("Glide 4");
  // 100 mi before the app is 160,934 m.
  await page.getByLabel(shoeCopy.startDistance, { exact: true }).fill("100");
  const added = page.waitForResponse(isAddShoes);
  await page.getByRole("button", { name: shoeCopy.add, exact: true }).click();
  expect((await added).status()).toBe(201);

  await expect(heading(page, shoesCopy.title)).toBeVisible();
  await expect(pairRow(region(page, shoesCopy.inUse), "Northpace Glide 4")).toContainText(
    "100.0 of 404 mi",
  );
  // 404 was left as the form showed it, so the goal keeps its 650,000 m rather than 404 mi's 650,175.
  expect(await storedPair(page, "Glide 4")).toMatchObject({
    retireDistanceM: 650_000,
    startDistanceM: 160_934,
  });
});

test("a run's pair that does not save says so and goes back to the pair it wore", async ({
  page,
}) => {
  const failure = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: ErrorCode.internal,
    requestId: "e2e-run-shoe-failure",
  } satisfies Problem;
  const glideId = await seedPair(pairs.glide, { active: true });
  await seedLongRunWearing(glideId);
  await seedPair(pairs.ridge);
  await page.route(isRunShoePath, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: failure.status,
          contentType: "application/problem+json",
          body: JSON.stringify(failure),
        })
      : route.continue(),
  );

  const runId = await latestRunId(page);
  await page.goto(`/runs/${runId}`);
  await expect(changeButton(page)).toHaveAccessibleDescription("Northpace Glide 4");

  expect((await chooseRunShoe(page, "Northpace Ridge 2")).status()).toBe(500);
  await expect(runShoes(page).getByRole("alert")).toHaveText(errorMessages.internal);
  await expect(changeButton(page)).toHaveAccessibleDescription("Northpace Glide 4");
  await expect(runShoes(page).getByRole("radio", { name: "Northpace Glide 4" })).toBeChecked();
  expect(await runShoeId(page, runId)).toBe(glideId);
});
