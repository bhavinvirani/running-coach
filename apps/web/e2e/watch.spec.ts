import type { Locator, Page } from "@playwright/test";
import {
  PUSH_WINDOW_DAYS,
  calendarResponseSchema,
  distanceInUnits,
  sessionDetailResponseSchema,
  type CalendarResponse,
  type SessionDetailResponse,
  type SessionSteps,
} from "@running-coach/shared";
import { addDays, weekStart } from "../src/lib/dates";
import { errorMessages } from "../src/lib/errors";
import { formatDistance, formatDuration, formatLocalDay, formatShortDay } from "../src/lib/format";
import type { GarminCaption } from "../src/lib/garmin-state";
import { sessionTypeName } from "../src/lib/session-type";
import { goalCopy } from "../src/screens/goal/goal-copy";
import { sessionCopy } from "../src/screens/session/session-copy";
import { builderCopy } from "../src/screens/workout-builder/builder-copy";
import { expect, test } from "./fixtures/login";
import {
  connectGarmin,
  runnerToday,
  seedPlanSessions,
  seedSessionsOnGarmin,
  type StoredSession,
} from "./fixtures/seed";
import { skipSyncOnOpen } from "./fixtures/sync";

// Every flow here runs on the real clock: the API keeps the server's own today and the next six days on
// Garmin, so the sessions are seeded around the runner's real today and the browser reads the same date.

/**
 * How long a push may take to show: the worker polls every 2 s, a push to the fixture Garmin takes about
 * a second, and a screen reads the push status again every 3 s while one runs.
 */
const PUSH_SHOWN_MS = 20_000;

const NEXT_SEVEN_DAYS = "Next 7 days";
const OTHER_WORKOUTS = "Also on your Garmin calendar";
const SENDING_LINE = "Sending workouts to Garmin.";

function nextSevenDays(page: Page): Locator {
  return page.getByRole("region", { name: NEXT_SEVEN_DAYS });
}

/** One day's row on Today's next 7 days, found by the date its time element carries. */
function dayRow(page: Page, date: string): Locator {
  return nextSevenDays(page)
    .getByRole("listitem")
    .filter({ has: page.locator(`time[datetime="${date}"]`) });
}

/** The link to a seeded plan session on its day's row; its name starts with the type: "Easy, …". */
function sessionLink(page: Page, session: StoredSession, date = session.date): Locator {
  return dayRow(page, date).getByRole("link", {
    name: new RegExp(`^${sessionTypeName(session.type)},`),
  });
}

/**
 * A session link's name with its Garmin caption, as Today reads it out: "Easy, 2.9 km, 20:00, On Garmin".
 * A skipped session keeps only its name and the caption: "Tempo, Skipped".
 */
function linkName(session: StoredSession, caption: GarminCaption): string {
  const name = sessionTypeName(session.type);
  if (caption === "Skipped") return `${name}, ${caption}`;
  const { distanceM, durationS } = session.target;
  return [
    name,
    formatDistance(distanceInUnits(distanceM, "km"), "km"),
    formatDuration(durationS),
    caption,
  ].join(", ");
}

/** The session screen's Garmin card, which holds the session's caption and the push line. */
function garminCard(page: Page): Locator {
  return page.getByRole("region", { name: sessionCopy.garmin, exact: true });
}

async function readCalendar(page: Page, from: string): Promise<CalendarResponse> {
  const query = new URLSearchParams({ from, to: addDays(from, PUSH_WINDOW_DAYS - 1) });
  const response = await page.request.get(`/api/calendar?${query.toString()}`);
  expect(response.ok()).toBe(true);
  return calendarResponseSchema.parse(await response.json());
}

async function readSession(page: Page, id: string): Promise<SessionDetailResponse> {
  const response = await page.request.get(`/api/sessions/${id}`);
  expect(response.ok()).toBe(true);
  return sessionDetailResponseSchema.parse(await response.json());
}

/** The calendar's sessions by id, for comparing with what was seeded. */
function sessionsById(calendar: CalendarResponse) {
  return new Map(
    calendar.days.flatMap((day) => day.sessions).map((session) => [session.id, session]),
  );
}

test("Send to Garmin puts the next 7 days on the watch and Unschedule clears another app's workout", async ({
  page,
}) => {
  // Connected first: the first connect of a worker goes through the API, whose push must not send these.
  await connectGarmin(page.request);
  const today = runnerToday();
  const sessions = await seedPlanSessions([
    { date: today, type: "easy" },
    { date: addDays(today, 2), type: "intervals" },
    { date: addDays(today, PUSH_WINDOW_DAYS - 1), type: "long" },
  ]);
  // The tap is under test: the app opens without its own sync, and the push request is held until the
  // busy state has been seen, then goes through to the API unchanged.
  await skipSyncOnOpen(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/calendar/push", async (route) => {
    await held;
    await route.continue();
  });

  await page.goto("/");
  for (const session of sessions) {
    await expect(sessionLink(page, session)).toHaveAccessibleName(
      linkName(session, "Waiting to send"),
    );
  }
  await nextSevenDays(page).getByRole("button", { name: "Send to Garmin" }).click();

  await expect(nextSevenDays(page).getByText(SENDING_LINE, { exact: true })).toBeVisible();
  for (const session of sessions) {
    await expect(sessionLink(page, session)).toHaveAccessibleName(linkName(session, "Sending"));
  }
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/calendar/push"),
  );
  release();
  expect((await sent).ok()).toBe(true);

  for (const session of sessions) {
    await expect(sessionLink(page, session)).toHaveAccessibleName(linkName(session, "On Garmin"), {
      timeout: PUSH_SHOWN_MS,
    });
  }
  await expect(nextSevenDays(page).getByText(SENDING_LINE)).toHaveCount(0);
  await expect(nextSevenDays(page).getByRole("button", { name: "Send to Garmin" })).toBeVisible();
  await expect(nextSevenDays(page).getByRole("alert")).toHaveCount(0);

  const calendar = await readCalendar(page, today);
  expect(calendar.garmin).toMatchObject({ connection: "ok", pushing: false, error: null });
  expect(calendar.garmin.pushedAt).not.toBeNull();
  const stored = sessionsById(calendar);
  expect(sessions.map((session) => stored.get(session.id)?.onGarmin)).toEqual([true, true, true]);

  // The fixture Garmin's calendar holds other apps' workouts on fixed days of every month, so every
  // window has some; each is listed with its day.
  const { others } = calendar.garmin;
  expect(others.length).toBeGreaterThan(0);
  const otherSection = page.getByRole("region", { name: OTHER_WORKOUTS });
  const unscheduleButtons = others.map((workout) =>
    otherSection.getByRole("button", {
      name: `Unschedule ${workout.title ?? "Untitled workout"} on ${formatLocalDay(workout.date)}`,
    }),
  );
  for (const button of unscheduleButtons) await expect(button).toBeVisible();

  const [first] = others;
  const [firstButton] = unscheduleButtons;
  if (!first || !firstButton) throw new Error("The fixture calendar listed no other workout");
  await firstButton.click();
  // The row stays busy until the calendar read without it lands, then goes; the others stay.
  await expect(firstButton).toHaveCount(0);
  for (const button of unscheduleButtons.slice(1)) await expect(button).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  const after = await readCalendar(page, today);
  expect(after.garmin.others.map((workout) => workout.scheduleId)).toEqual(
    others.slice(1).map((workout) => workout.scheduleId),
  );
  // Our own workouts stay where they are.
  expect([...sessionsById(after).values()].every((session) => session.onGarmin)).toBe(true);
});

test.describe("calendar edits", () => {
  test("Move puts a session on another day of its week, and the push moves it on Garmin", async ({
    page,
  }) => {
    await connectGarmin(page.request);
    const today = runnerToday();
    // A move stays in the session's Monday-to-Sunday week and never reaches before today: on a Sunday,
    // today has no later day in its week, so the session starts tomorrow, a Monday.
    const from = weekStart(addDays(today, 1)) === weekStart(today) ? today : addDays(today, 1);
    const to = addDays(from, 1);
    const [session] = await seedPlanSessions([{ date: from, type: "easy" }]);
    if (!session) throw new Error("No session was seeded");
    await seedSessionsOnGarmin([from]);
    await skipSyncOnOpen(page);

    await page.goto("/");
    const link = sessionLink(page, session);
    await expect(link).toHaveAccessibleName(linkName(session, "On Garmin"));
    await link.click();

    await expect(page.getByRole("heading", { name: formatLocalDay(from), level: 1 })).toBeVisible();
    await expect(garminCard(page).getByText("On Garmin", { exact: true })).toBeVisible();
    const move = page.getByRole("button", { name: sessionCopy.move, exact: true });
    await move.click();
    await expect(move).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("group", { name: sessionCopy.moveTo })
      .getByRole("button", { name: formatShortDay(to), exact: true })
      .click();

    // The screen follows the session to its new day; the push the move queued schedules it there.
    await expect(page.getByRole("heading", { name: formatLocalDay(to), level: 1 })).toBeVisible();
    await expect(page.getByText("Moved", { exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: sessionCopy.moveTo })).toHaveCount(0);
    await expect(garminCard(page).getByText("On Garmin", { exact: true })).toBeVisible({
      timeout: PUSH_SHOWN_MS,
    });
    // An easy run sits next to no hard session, so the move comes without a warning.
    await expect(page.getByRole("status")).toHaveCount(0);

    await page
      .getByRole("navigation", { name: "Tabs" })
      .getByRole("link", { name: "Today" })
      .click();
    await expect(sessionLink(page, session, to)).toHaveAccessibleName(
      linkName(session, "On Garmin"),
    );
    await expect(dayRow(page, from).getByRole("link", { name: /^Easy,/ })).toHaveCount(0);

    const { session: moved, garmin } = await readSession(page, session.id);
    expect(moved).toMatchObject({ date: to, status: "moved", onGarmin: true });
    expect(garmin).toMatchObject({ pushing: false, error: null });
  });

  test("Skip session marks it skipped and the push takes it off Garmin", async ({ page }) => {
    await connectGarmin(page.request);
    const date = addDays(runnerToday(), 1);
    const [session] = await seedPlanSessions([{ date, type: "tempo" }]);
    if (!session) throw new Error("No session was seeded");
    await seedSessionsOnGarmin([date]);
    await skipSyncOnOpen(page);

    await page.goto("/");
    const link = sessionLink(page, session);
    await expect(link).toHaveAccessibleName(linkName(session, "On Garmin"));
    await link.click();
    await expect(page.getByRole("heading", { name: formatLocalDay(date), level: 1 })).toBeVisible();

    await page.getByRole("button", { name: sessionCopy.skip, exact: true }).click();
    // Confirmed in place, with what a skip means; Keep session would leave it as it was.
    await expect(page.getByText(sessionCopy.skipQuestion, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: sessionCopy.keepSession })).toBeVisible();
    await page.getByRole("button", { name: sessionCopy.skip, exact: true }).click();

    // Skipped is history: no Garmin card, nothing left to move or skip.
    await expect(page.getByText("Skipped", { exact: true })).toBeVisible();
    await expect(garminCard(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: sessionCopy.move, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: sessionCopy.skip, exact: true })).toHaveCount(0);

    // The skip queued a push, which unschedules and deletes the workout and forgets its ids.
    await expect
      .poll(
        async () => {
          const { session: stored, garmin } = await readSession(page, session.id);
          return { status: stored.status, onGarmin: stored.onGarmin, pushing: garmin.pushing };
        },
        { timeout: PUSH_SHOWN_MS },
      )
      .toEqual({ status: "skipped", onGarmin: false, pushing: false });

    await page
      .getByRole("navigation", { name: "Tabs" })
      .getByRole("link", { name: "Today" })
      .click();
    await expect(sessionLink(page, session)).toHaveAccessibleName(linkName(session, "Skipped"));
  });
});

test("builds an intervals workout on a day of the next 7 and it reaches Garmin", async ({
  page,
}) => {
  await connectGarmin(page.request);
  // The builder reads the active plan's paces; the new workout goes on a day the plan leaves free.
  const today = runnerToday();
  await seedPlanSessions([{ date: today, type: "easy" }]);
  const day = addDays(today, 1);
  await skipSyncOnOpen(page);

  await page.goto("/");
  await dayRow(page, day)
    .getByRole("link", { name: `Add a workout on ${formatLocalDay(day)}` })
    .click();

  await expect(page).toHaveURL(new RegExp(`/plan/sessions/new\\?date=${day}$`));
  await expect(page.getByRole("heading", { name: builderCopy.newTitle, level: 1 })).toBeVisible();
  await expect(page.getByLabel(builderCopy.date, { exact: true })).toHaveValue(day);
  const type = page.getByRole("group", { name: builderCopy.type, exact: true });
  await expect(type.getByRole("radio", { name: "Easy", exact: true })).toBeChecked();
  // The radios are visually hidden; a thumb taps the chip.
  await type.getByText("Intervals", { exact: true }).click();
  await expect(type.getByRole("radio", { name: "Intervals", exact: true })).toBeChecked();

  // The intervals preset: 15 min warm-up, 5 x (1 km at interval pace, 3 min recovery), 10 min cool-down.
  const preset = [
    ["1", "warmup", "15", "min"],
    ["2.1", "work", "1", "km"],
    ["2.2", "recovery", "3", "min"],
    ["3", "cooldown", "10", "min"],
  ] as const;
  for (const [label, kind, amount, unit] of preset) {
    await expect(page.getByLabel(builderCopy.kindOf(label), { exact: true })).toHaveValue(kind);
    await expect(page.getByLabel(builderCopy.amountOf(label), { exact: true })).toHaveValue(amount);
    await expect(
      page
        .getByRole("group", { name: builderCopy.unitOf(label), exact: true })
        .getByRole("radio", { name: unit, exact: true }),
    ).toBeChecked();
  }
  await expect(page.getByLabel(builderCopy.zoneOf("2.1"), { exact: true })).toHaveValue("interval");
  const times = page.getByLabel(builderCopy.timesOf("2"), { exact: true });
  await expect(times).toHaveValue("5");
  await times.fill("6");

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/sessions",
  );
  await page.getByRole("button", { name: builderCopy.save }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { session } = sessionDetailResponseSchema.parse(await response.json());

  // The new workout opens in the builder's place.
  await expect(page).toHaveURL(new RegExp(`/plan/sessions/${session.id}$`));
  await expect(page.getByRole("heading", { name: formatLocalDay(day), level: 1 })).toBeVisible();
  const steps = page.getByRole("region", { name: sessionCopy.steps, exact: true });
  await expect(steps.getByRole("listitem")).toHaveText([
    /^1Warm-up15 min/,
    /^26 xWork1 km.*Recovery3 min/,
    /Work1 km/,
    /Recovery3 min/,
    /^3Cool-down10 min/,
  ]);
  await expect(garminCard(page).getByText("On Garmin", { exact: true })).toBeVisible({
    timeout: PUSH_SHOWN_MS,
  });

  const expectedSteps: SessionSteps = [
    { kind: "warmup", zone: "easy", distanceM: null, durationS: 900 },
    {
      repeat: 6,
      steps: [
        { kind: "work", zone: "interval", distanceM: 1000, durationS: null },
        { kind: "recovery", zone: "easy", distanceM: null, durationS: 180 },
      ],
    },
    { kind: "cooldown", zone: "easy", distanceM: null, durationS: 600 },
  ];
  const stored = await readSession(page, session.id);
  expect(stored.session).toMatchObject({
    date: day,
    type: "intervals",
    source: "custom",
    title: null,
    status: "planned",
    steps: expectedSteps,
    onGarmin: true,
  });
  expect(stored.garmin).toMatchObject({ pushing: false, error: null });
});

test("a Garmin outage mid-push keeps the workout that went and says which did not", async ({
  page,
}) => {
  // This login's fixture fails the second upload of every push with a 503 (fake_client.py).
  await connectGarmin(page.request, undefined, "workout_outage");
  const today = runnerToday();
  const [sent, failed] = await seedPlanSessions([
    { date: today, type: "easy" },
    { date: addDays(today, 2), type: "tempo" },
  ]);
  if (!sent || !failed) throw new Error("The two sessions were not seeded");
  await skipSyncOnOpen(page);

  await page.goto("/");
  await expect(sessionLink(page, failed)).toHaveAccessibleName(linkName(failed, "Waiting to send"));
  await nextSevenDays(page).getByRole("button", { name: "Send to Garmin" }).click();

  // The push creates in date order and stops at the failed upload, keeping the first; its retry waits
  // 5 minutes, so the stopped state holds for the rest of the test.
  await expect(nextSevenDays(page).getByRole("alert")).toHaveText(
    errorMessages.garmin_unavailable,
    { timeout: PUSH_SHOWN_MS },
  );
  await expect(sessionLink(page, sent)).toHaveAccessibleName(linkName(sent, "On Garmin"));
  await expect(sessionLink(page, failed)).toHaveAccessibleName(linkName(failed, "Not sent"));
  await expect(nextSevenDays(page).getByRole("button", { name: "Send to Garmin" })).toBeVisible();

  const calendar = await readCalendar(page, today);
  expect(calendar.garmin).toMatchObject({
    connection: "ok",
    pushing: false,
    error: "garmin_unavailable",
  });
  const stored = sessionsById(calendar);
  expect(stored.get(sent.id)?.onGarmin).toBe(true);
  expect(stored.get(failed.id)?.onGarmin).toBe(false);
});

test("without a plan, Today has no next 7 days and the builder asks for a goal", async ({
  page,
}) => {
  const calendarRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/calendar",
  );
  await page.goto("/");
  // Answered without paces, the section is left out rather than shown empty.
  expect((await calendarRead).ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  await expect(nextSevenDays(page)).toHaveCount(0);

  await page.goto("/plan/sessions/new");
  await expect(page.getByRole("heading", { name: builderCopy.newTitle, level: 1 })).toBeVisible();
  await expect(page.getByText(errorMessages.plan_missing, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: builderCopy.save })).toHaveCount(0);

  await page.getByRole("link", { name: builderCopy.setGoal }).click();
  await expect(page).toHaveURL(/\/plan\/goal$/);
  await expect(page.getByRole("heading", { name: goalCopy.title, level: 1 })).toBeVisible();
});
