import {
  PUSH_WINDOW_DAYS,
  calendarResponseSchema,
  disconnectGarminResponseSchema,
  meResponseSchema,
  type CalendarResponse,
  type DisconnectGarminQuery,
  type MeResponse,
} from "@running-coach/shared";
import type { APIRequestContext, Locator, Page, Response } from "@playwright/test";
import { addDays } from "../src/lib/dates";
import { errorMessages } from "../src/lib/errors";
import { sessionTypeName } from "../src/lib/session-type";
import { disconnectedLine, garminCopy } from "../src/screens/garmin/garmin-copy";
import { expect, test } from "./fixtures/login";
import {
  connectGarmin,
  runnerToday,
  seedExpiredGarminLogin,
  seedPlanSessions,
  seedSessionsOnGarmin,
  type StoredSession,
} from "./fixtures/seed";
import { fixtureGarminLogin, pinGarminSyncCursor } from "./fixtures/seed-garmin-login";
import { isSyncPost, recordSyncPosts, skipSyncOnOpen } from "./fixtures/sync";

// Connecting, reconnecting and disconnecting Garmin on /settings/garmin against the fixture Garmin's
// password login (fixtureGarminLogin). A connect sends Sync now's request; every test that lets one through
// waits for its answer, so no sync writes into the next test's reset runner.

function garminCard(page: Page): Locator {
  return page.getByRole("region", { name: garminCopy.title, exact: true });
}

/** The figure beside a row's label in the Garmin card ("Status", "Last sync"). */
function figure(scope: Locator, label: string): Locator {
  return scope.getByText(label, { exact: true }).locator("xpath=following-sibling::*[1]");
}

function tab(page: Page, name: string): Locator {
  return page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name });
}

/** Opens the Garmin screen the way a thumb gets there: the Settings tab, then the Garmin row by its value. */
async function openGarmin(page: Page, rowValue: string): Promise<void> {
  await page.goto("/");
  await tab(page, "Settings").click();
  await page.getByRole("link", { name: `Garmin, ${rowValue}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: garminCopy.title, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/garmin$/);
}

function isPost(response: Response, pathname: string): boolean {
  return response.request().method() === "POST" && new URL(response.url()).pathname === pathname;
}

const isLoginStart = (response: Response) => isPost(response, "/api/garmin/login");
const isLoginCode = (response: Response) => isPost(response, "/api/garmin/login/code");
const isDisconnect = (response: Response) =>
  response.request().method() === "DELETE" &&
  new URL(response.url()).pathname === "/api/garmin/connection";

/** The workouts choice a disconnect sent, from its query. */
function workoutsChoice(response: Response): DisconnectGarminQuery["workouts"] | null {
  const workouts = new URL(response.url()).searchParams.get("workouts");
  return workouts === "remove" || workouts === "keep" ? workouts : null;
}

async function garminState(request: APIRequestContext): Promise<MeResponse["garmin"]> {
  return meResponseSchema.parse(await (await request.get("/api/me")).json()).garmin;
}

/** Types the email and password into step 1 and taps the form's button; returns the start's answer. */
async function signIn(page: Page, email: string, button: string): Promise<Response> {
  const card = garminCard(page);
  await card.getByLabel(garminCopy.email, { exact: true }).fill(email);
  await card.getByLabel(garminCopy.password, { exact: true }).fill(fixtureGarminLogin.password);
  const answered = page.waitForResponse(isLoginStart);
  await card.getByRole("button", { name: button, exact: true }).click();
  return answered;
}

/** Types a code into the code step and taps Connect Garmin; returns the code's answer. */
async function sendCode(page: Page, code: string): Promise<Response> {
  const card = garminCard(page);
  await card.getByLabel(garminCopy.code, { exact: true }).fill(code);
  const answered = page.waitForResponse(isLoginCode);
  await card.getByRole("button", { name: garminCopy.connect.idle, exact: true }).click();
  return answered;
}

/** Disconnect Garmin, then the confirm step's own Disconnect Garmin; returns the disconnect's answer. */
async function disconnect(page: Page, { removeWorkouts }: { removeWorkouts: boolean | null }) {
  const card = garminCard(page);
  await card.getByRole("button", { name: garminCopy.disconnect.idle, exact: true }).click();
  const step = card.getByRole("group", { name: garminCopy.disconnectQuestion });
  await expect(step).toBeVisible();
  const checkbox = step.getByRole("checkbox", { name: garminCopy.removeWorkouts });
  if (removeWorkouts === null) {
    // An expired login cannot remove anything, so the step says so instead of offering the choice.
    await expect(checkbox).toHaveCount(0);
    await expect(step.getByText(garminCopy.keepOnly, { exact: true })).toBeVisible();
  } else {
    // On by default: the runner leaves it as it is.
    await expect(checkbox).toBeChecked({ checked: removeWorkouts });
  }
  const answered = page.waitForResponse(isDisconnect);
  await step.getByRole("button", { name: garminCopy.disconnect.idle, exact: true }).click();
  return answered;
}

/** The fixture's 18 km run of Sun 27 Sep 2026, 08:00, the one run a sync from the pinned cursor stores. */
async function expectFixtureRun(page: Page): Promise<void> {
  const card = page.getByRole("region", { name: "Latest run" });
  await expect(card.locator("time")).toHaveText("Sun 27 Sep, 08:00");
  await expect(figure(card, "Distance")).toHaveText(/^18\.0\s*km$/);
}

test("connects with email, password and Garmin's code after a wrong one, syncs, and disconnects", async ({
  page,
}) => {
  const posts = recordSyncPosts(page);
  // The sync the connect sends is held until its cursor is pinned (pinGarminSyncCursor), then goes through
  // to the API unchanged.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/sync", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });

  await openGarmin(page, "Not connected");
  const card = garminCard(page);
  await expect(figure(card, garminCopy.status)).toHaveText("Not connected");
  await expect(card.getByText(garminCopy.connectIntro, { exact: true })).toBeVisible();

  expect((await signIn(page, fixtureGarminLogin.email, garminCopy.connect.idle)).ok()).toBe(true);

  // Garmin sent a code: the email and password make way for the code field, which takes the focus.
  await expect(card.getByText(garminCopy.codeSent, { exact: true })).toBeVisible();
  await expect(card.getByLabel(garminCopy.code, { exact: true })).toBeFocused();
  await expect(card.getByLabel(garminCopy.password, { exact: true })).toHaveCount(0);

  // A wrong code is refused, and the same login waits for another on the code step.
  expect((await sendCode(page, fixtureGarminLogin.wrongCode)).status()).toBe(422);
  await expect(card.getByRole("alert")).toHaveText(errorMessages.garmin_mfa_rejected);
  await expect(card.getByLabel(garminCopy.code, { exact: true })).toBeVisible();
  await expect(figure(card, garminCopy.status)).toHaveText("Not connected");
  expect((await garminState(page.request)).status).toBe("not_connected");

  const syncSent = page.waitForRequest(isSyncPost);
  const synced = page.waitForResponse((response) => isSyncPost(response.request()));
  expect((await sendCode(page, fixtureGarminLogin.code)).ok()).toBe(true);
  await expect(card.getByText(garminCopy.connected, { exact: true })).toBeFocused();
  await expect(figure(card, garminCopy.status)).toHaveText("Connected");
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(card.getByLabel(garminCopy.code, { exact: true })).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: garminCopy.disconnect.idle, exact: true }),
  ).toBeVisible();

  // Connected, the screen sent Sync now's request by itself.
  await syncSent;
  await pinGarminSyncCursor();
  release();
  expect((await synced).ok()).toBe(true);
  expect((await garminState(page.request)).status).toBe("ok");

  // Today shows what that sync brought in, with Sync now ready for the next one: no second sync ran.
  await tab(page, "Today").click();
  await expectFixtureRun(page);
  await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
  expect(posts).toHaveLength(1);

  await tab(page, "Settings").click();
  await page.getByRole("link", { name: "Garmin, Connected", exact: true }).click();
  // Nothing of the app's was on Garmin: no plan, so no workouts to take off.
  const disconnected = await disconnect(page, { removeWorkouts: true });
  expect(disconnected.ok()).toBe(true);
  expect(workoutsChoice(disconnected)).toBe("remove");
  expect(disconnectGarminResponseSchema.parse(await disconnected.json()).removedWorkouts).toBe(0);

  await expect(card.getByText(disconnectedLine("remove", 0), { exact: true })).toBeFocused();
  await expect(figure(card, garminCopy.status)).toHaveText("Not connected");
  await expect(card.getByText(garminCopy.lastSync, { exact: true })).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: garminCopy.connect.idle, exact: true }),
  ).toBeVisible();
  expect((await garminState(page.request)).status).toBe("not_connected");
});

test("an expired login reconnects from Today's Reconnect Garmin without a code, and Today syncs again", async ({
  page,
}) => {
  await seedExpiredGarminLogin();
  const posts = recordSyncPosts(page);

  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveText(errorMessages.garmin_auth_expired);
  await page.getByRole("link", { name: garminCopy.reconnect.idle }).click();
  await expect(page.getByRole("heading", { name: garminCopy.title, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/garmin$/);
  const card = garminCard(page);
  await expect(figure(card, garminCopy.status)).toHaveText("Login expired");
  await expect(card.getByText(garminCopy.reconnectIntro, { exact: true })).toBeVisible();

  // This account's Garmin asks for no code: the sign-in connects at once and the sync follows. The
  // reconnect keeps the seeded cursor, so the sync stores the 18 km run.
  const synced = page.waitForResponse((response) => isSyncPost(response.request()));
  expect((await signIn(page, fixtureGarminLogin.noCodeEmail, garminCopy.reconnect.idle)).ok()).toBe(
    true,
  );
  await expect(card.getByText(garminCopy.connected, { exact: true })).toBeFocused();
  await expect(figure(card, garminCopy.status)).toHaveText("Connected");
  await expect(card.getByLabel(garminCopy.code, { exact: true })).toHaveCount(0);
  await expect(card.getByLabel(garminCopy.email, { exact: true })).toHaveCount(0);
  expect((await synced).ok()).toBe(true);
  expect((await garminState(page.request)).status).toBe("ok");

  // Back on Today the expired line and Reconnect Garmin are gone, Sync now is back, and the run is in.
  await tab(page, "Today").click();
  await expectFixtureRun(page);
  await expect(page.getByText(errorMessages.garmin_auth_expired, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: garminCopy.reconnect.idle })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
  expect(posts).toHaveLength(1);
});

test("a Garmin 429 on sign-in says to wait or use the laptop, is not retried, and connects nothing", async ({
  page,
}) => {
  const posts = recordSyncPosts(page);
  const starts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/garmin/login") {
      starts.push(request.url());
    }
  });

  await openGarmin(page, "Not connected");
  const card = garminCard(page);
  expect(
    (await signIn(page, fixtureGarminLogin.rateLimitedEmail, garminCopy.connect.idle)).status(),
  ).toBe(429);

  await expect(card.getByRole("alert")).toHaveText(garminCopy.loginRateLimited);
  // Still step 1, with what was typed kept for later; the button is ready again, so nothing is in flight.
  await expect(card.getByLabel(garminCopy.email, { exact: true })).toHaveValue(
    fixtureGarminLogin.rateLimitedEmail,
  );
  await expect(card.getByLabel(garminCopy.code, { exact: true })).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: garminCopy.connect.idle, exact: true }),
  ).toBeEnabled();
  await expect(figure(card, garminCopy.status)).toHaveText("Not connected");
  expect((await garminState(page.request)).status).toBe("not_connected");
  expect(starts).toHaveLength(1);
  expect(posts).toHaveLength(0);
});

test("disconnecting an expired login only forgets it and leaves the runner not connected", async ({
  page,
}) => {
  await seedExpiredGarminLogin();

  await openGarmin(page, "Login expired");
  const card = garminCard(page);
  const disconnected = await disconnect(page, { removeWorkouts: null });
  expect(disconnected.ok()).toBe(true);
  expect(workoutsChoice(disconnected)).toBe("keep");

  await expect(card.getByText(disconnectedLine("keep", 0), { exact: true })).toBeFocused();
  await expect(figure(card, garminCopy.status)).toHaveText("Not connected");
  await expect(card.getByText(garminCopy.lastSync, { exact: true })).toHaveCount(0);
  // The form that was there to reconnect now connects.
  await expect(card.getByText(garminCopy.connectIntro, { exact: true })).toBeVisible();
  await expect(
    card.getByRole("button", { name: garminCopy.connect.idle, exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: garminCopy.disconnect.idle, exact: true }),
  ).toHaveCount(0);
  expect((await garminState(page.request)).status).toBe("not_connected");
});

/** The calendar from today over the days the API keeps on Garmin. */
async function readCalendar(request: APIRequestContext, from: string): Promise<CalendarResponse> {
  const query = new URLSearchParams({ from, to: addDays(from, PUSH_WINDOW_DAYS - 1) });
  const response = await request.get(`/api/calendar?${query.toString()}`);
  expect(response.ok()).toBe(true);
  return calendarResponseSchema.parse(await response.json());
}

/** Today's link to a seeded session on its day of the next 7; its name starts with the type: "Easy, …". */
function sessionLink(page: Page, session: StoredSession): Locator {
  return page
    .getByRole("region", { name: "Next 7 days" })
    .getByRole("listitem")
    .filter({ has: page.locator(`time[datetime="${session.date}"]`) })
    .getByRole("link", { name: new RegExp(`^${sessionTypeName(session.type)},`) });
}

test("disconnecting a working login takes the app's workouts off Garmin first and says how many", async ({
  page,
}) => {
  // Connected first: the first connect of a worker goes through the API, whose push must not send these.
  await connectGarmin(page.request);
  const today = runnerToday();
  const sessions = await seedPlanSessions([
    { date: today, type: "easy" },
    { date: addDays(today, 2), type: "intervals" },
  ]);
  await seedSessionsOnGarmin(sessions.map((session) => session.date));
  // The disconnect is under test: the app opens without its own sync.
  await skipSyncOnOpen(page);

  await page.goto("/");
  for (const session of sessions) {
    await expect(sessionLink(page, session)).toHaveAccessibleName(/, On Garmin$/);
  }

  await tab(page, "Settings").click();
  await page.getByRole("link", { name: "Garmin, Connected", exact: true }).click();
  const card = garminCard(page);
  const disconnected = await disconnect(page, { removeWorkouts: true });
  expect(disconnected.ok()).toBe(true);
  expect(workoutsChoice(disconnected)).toBe("remove");
  expect(disconnectGarminResponseSchema.parse(await disconnected.json()).removedWorkouts).toBe(
    sessions.length,
  );

  await expect(
    card.getByText(disconnectedLine("remove", sessions.length), { exact: true }),
  ).toBeFocused();
  await expect(figure(card, garminCopy.status)).toHaveText("Not connected");
  expect((await garminState(page.request)).status).toBe("not_connected");
  const stored = (await readCalendar(page.request, today)).days.flatMap((day) => day.sessions);
  expect(sessions.map((session) => stored.find((row) => row.id === session.id)?.onGarmin)).toEqual([
    false,
    false,
  ]);

  // The plan no longer shows them on the watch.
  await tab(page, "Today").click();
  for (const session of sessions) {
    await expect(sessionLink(page, session)).toHaveAccessibleName(/, Not on Garmin$/);
  }
});
