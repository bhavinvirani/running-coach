import {
  ErrorCode,
  hrZonesResponseSchema,
  type HrZonesResponse,
  type Problem,
} from "@running-coach/shared";
import type { Locator, Page, Request, Response } from "@playwright/test";
import { errorMessages } from "../src/lib/errors";
import { fixtureRunIds, seedLongRun, seedRunDetail } from "./fixtures/seed";
import { expect, test } from "./fixtures/login";

// The run's zone table follows the zones in use: Garmin's seconds as stored with the run while the zones are
// Garmin's, seconds counted from the run's stored heart-rate series once the runner saves their own.

/**
 * Garmin's zones as seedRunDetail stores them with the long run: floors 98, 118, 137, 157 and 176 bpm, read
 * back by the API with max HR 196 (zone 5's floor at Garmin's 90%), and Garmin's own 6120 s by zone.
 */
const garminZones = { maxHr: 196, lowBpm: [98, 118, 137, 157, 176] } as const;
const garminPercents = ["50", "60", "70", "80", "90"] as const;
const garminRows = [
  /^Zone\s*Time\s*Share$/,
  /^Z1 98\+\s*03:00\s*3%$/,
  /^Z2 118\+\s*21:00\s*21%$/,
  /^Z3 137\+\s*52:00\s*51%$/,
  /^Z4 157\+\s*24:00\s*24%$/,
  /^Z5 176\+\s*02:00\s*2%$/,
];

/**
 * The runner's own floors, two set by percent of max HR (zone 2 at 70%, 137 bpm; zone 5 at 82%, 161 bpm) and
 * two by bpm (zone 3 at 145, 74%; zone 4 at 152, 78%).
 */
const customZones = { maxHr: 196, lowBpm: [98, 137, 145, 152, 161] } as const;
/**
 * The long run's time in those zones, counted from the series seedRunDetail stores (600 samples from 118 to
 * 166 bpm, each held until the next): 143, 1155, 2973, 1584 and 266 s, whole seconds per zone, 6121 s in
 * all after rounding. Garmin's stored seconds play no part, so every row differs from garminRows.
 */
const customRows = [
  /^Zone\s*Time\s*Share$/,
  /^Z1 98\+\s*02:23\s*2%$/,
  /^Z2 137\+\s*19:15\s*19%$/,
  /^Z3 145\+\s*49:33\s*49%$/,
  /^Z4 152\+\s*26:24\s*26%$/,
  /^Z5 161\+\s*04:26\s*4%$/,
];

const garminCaption = "Garmin's zones, from your latest run with heart rate.";
const customCaption = "Your own zones. Each run's time in zone is counted from its heart rate.";

function heading(page: Page, title: string): Locator {
  return page.getByRole("heading", { name: title, level: 1 });
}

function tab(page: Page, name: string): Locator {
  return page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name });
}

/** Opens the long run from Progress, the way a thumb gets there. */
async function openLongRun(page: Page): Promise<void> {
  await tab(page, "Progress").click();
  await expect(heading(page, "Progress")).toBeVisible();
  await page.getByRole("link", { name: /^Sun 27 Sep,/ }).click();
  await expect(heading(page, "Sun 27 Sep")).toBeVisible();
}

/** Opens Heart rate zones from Settings. */
async function openZonesFromSettings(page: Page): Promise<void> {
  await tab(page, "Settings").click();
  await expect(heading(page, "Settings")).toBeVisible();
  await page.getByRole("link", { name: "Heart rate zones" }).click();
  await expect(heading(page, "Heart rate zones")).toBeVisible();
}

function zonesCard(page: Page): Locator {
  return page.getByRole("region", { name: "Heart rate zones", exact: true });
}

/** The run's zone table, header row first; Show table swaps it in for the bars. */
async function zoneTableRows(page: Page): Promise<Locator> {
  await zonesCard(page).getByRole("button", { name: "Show table" }).click();
  return zonesCard(page).getByRole("table", { name: "Heart rate zones" }).getByRole("row");
}

function percentField(page: Page, zone: number): Locator {
  return page.getByLabel(`Zone ${zone} lower bound, percent of max`, { exact: true });
}

function bpmField(page: Page, zone: number): Locator {
  return page.getByLabel(`Zone ${zone} lower bound, bpm`, { exact: true });
}

/** The zones form as it reads: max HR, then each zone's percent and bpm. */
async function expectForm(
  page: Page,
  maxHr: string,
  percents: readonly string[],
  bpms: readonly (string | number)[],
): Promise<void> {
  await expect(page.getByLabel("Max HR", { exact: true })).toHaveValue(maxHr);
  for (const [index, percent] of percents.entries()) {
    await expect(percentField(page, index + 1)).toHaveValue(percent);
    await expect(bpmField(page, index + 1)).toHaveValue(String(bpms[index]));
  }
}

/** The range under a zone's name: its floor to the bpm before the next zone starts, zone 5 to max HR. */
function zoneRange(page: Page, zone: number, name: string): Locator {
  return page
    .getByRole("group", { name: `Zone ${zone}, ${name}`, exact: true })
    .getByText(/^\d+-\d+ bpm$/);
}

async function getZones(page: Page): Promise<HrZonesResponse> {
  const response = await page.request.get("/api/hr-zones");
  expect(response.ok()).toBe(true);
  return hrZonesResponseSchema.parse(await response.json());
}

const isZonesWrite = (method: "PUT" | "DELETE") => (response: Response) =>
  response.request().method() === method && response.url().endsWith("/api/hr-zones");

const isZonesPut = (request: Request) =>
  request.method() === "PUT" && request.url().endsWith("/api/hr-zones");

test("zones edited by percent and bpm change the run's time in zone, and Reset to Garmin's brings Garmin's back", async ({
  page,
}) => {
  await seedLongRun();
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");
  await page.goto("/");

  // Garmin's zones: the run shows the seconds Garmin stored with it.
  await openLongRun(page);
  await expect(await zoneTableRows(page)).toHaveText(garminRows);

  await openZonesFromSettings(page);
  await expect(page.getByText(garminCaption, { exact: true })).toBeVisible();
  await expectForm(page, "196", garminPercents, garminZones.lowBpm);
  await expect(zoneRange(page, 1, "Recovery")).toHaveText("98-117 bpm");
  await expect(zoneRange(page, 5, "Anaerobic")).toHaveText("176-196 bpm");
  // Nothing to reset while the zones are Garmin's.
  await expect(page.getByRole("button", { name: "Reset to Garmin's" })).toHaveCount(0);

  // A percent moves its bpm, and a bpm moves its percent.
  await percentField(page, 2).fill("70");
  await expect(bpmField(page, 2)).toHaveValue("137");
  await bpmField(page, 3).fill("145");
  await expect(percentField(page, 3)).toHaveValue("74");
  await bpmField(page, 4).fill("152");
  await expect(percentField(page, 4)).toHaveValue("78");
  await percentField(page, 5).fill("82");
  await expect(bpmField(page, 5)).toHaveValue("161");
  await expect(zoneRange(page, 1, "Recovery")).toHaveText("98-136 bpm");
  await expect(zoneRange(page, 2, "Endurance")).toHaveText("137-144 bpm");
  await expect(zoneRange(page, 3, "Tempo")).toHaveText("145-151 bpm");
  await expect(zoneRange(page, 4, "Threshold")).toHaveText("152-160 bpm");
  await expect(zoneRange(page, 5, "Anaerobic")).toHaveText("161-196 bpm");

  const saved = page.waitForResponse(isZonesWrite("PUT"));
  await page.getByRole("button", { name: "Save zones" }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByRole("status")).toHaveText("Zones saved.");
  await expect(page.getByText(customCaption, { exact: true })).toBeVisible();
  await expectForm(page, "196", ["50", "70", "74", "78", "82"], customZones.lowBpm);
  expect(await getZones(page)).toEqual({ source: "custom", zones: customZones });

  // The run's table now counts its heart rate into the runner's zones.
  await openLongRun(page);
  await expect(await zoneTableRows(page)).toHaveText(customRows);

  // Edit zones on the run's card opens the same screen, with the runner's zones and a way back to Garmin's.
  await zonesCard(page).getByRole("link", { name: "Edit zones" }).click();
  await expect(heading(page, "Heart rate zones")).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/hr-zones$/);
  await expectForm(page, "196", ["50", "70", "74", "78", "82"], customZones.lowBpm);

  const reset = page.waitForResponse(isZonesWrite("DELETE"));
  await page.getByRole("button", { name: "Reset to Garmin's" }).click();
  expect((await reset).ok()).toBe(true);
  await expect(page.getByText(garminCaption, { exact: true })).toBeVisible();
  await expectForm(page, "196", garminPercents, garminZones.lowBpm);
  await expect(page.getByRole("button", { name: "Reset to Garmin's" })).toHaveCount(0);
  expect(await getZones(page)).toEqual({ source: "garmin", zones: garminZones });

  // Back returns to the run, which shows Garmin's seconds again.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(heading(page, "Sun 27 Sep")).toBeVisible();
  await expect(await zoneTableRows(page)).toHaveText(garminRows);
});

test("zones that do not rise say what to fix and are not sent", async ({ page }) => {
  await seedLongRun();
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");
  const puts: string[] = [];
  page.on("request", (request) => {
    if (isZonesPut(request)) puts.push(request.url());
  });
  await page.goto("/");
  await openZonesFromSettings(page);
  await expectForm(page, "196", garminPercents, garminZones.lowBpm);

  // Zone 3 typed below zone 2.
  await bpmField(page, 3).fill("110");
  await page.getByRole("button", { name: "Save zones" }).click();

  await expect(page.getByRole("alert")).toHaveText("Each zone starts above the one before it.");
  await expect(bpmField(page, 3)).toHaveValue("110");
  expect(puts).toEqual([]);
  expect(await getZones(page)).toEqual({ source: "garmin", zones: garminZones });

  // Fixed in place, the alert goes as soon as the field changes.
  await bpmField(page, 3).fill("140");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("zones the server refuses say so, keep what was typed and store nothing", async ({ page }) => {
  await seedLongRun();
  await seedRunDetail(fixtureRunIds.longRun, "outdoor");
  const refusal = {
    type: "about:blank",
    title: "Bad Request",
    status: 400,
    code: ErrorCode.validation,
    requestId: "e2e-hr-zones-refused",
  } satisfies Problem;
  await page.route("**/api/hr-zones", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({
          status: refusal.status,
          contentType: "application/problem+json",
          body: JSON.stringify(refusal),
        })
      : route.continue(),
  );
  await page.goto("/");
  await openZonesFromSettings(page);
  await expectForm(page, "196", garminPercents, garminZones.lowBpm);

  await percentField(page, 2).fill("65");
  await expect(bpmField(page, 2)).toHaveValue("127");
  const refused = page.waitForResponse(isZonesWrite("PUT"));
  await page.getByRole("button", { name: "Save zones" }).click();
  expect((await refused).status()).toBe(400);

  await expect(page.getByRole("alert")).toHaveText(errorMessages.validation);
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText(garminCaption, { exact: true })).toBeVisible();
  await expectForm(page, "196", ["50", "65", "70", "80", "90"], [98, 127, 137, 157, 176]);
  await expect(page.getByRole("button", { name: "Save zones" })).toBeEnabled();
  expect(await getZones(page)).toEqual({ source: "garmin", zones: garminZones });
});
