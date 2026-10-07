import type { Locator, Page } from "@playwright/test";
import {
  ErrorCode,
  PUSH_WINDOW_DAYS,
  calendarResponseSchema,
  distanceInUnits,
  endPauseResponseSchema,
  pauseResponseSchema,
  type CalendarResponse,
  type PauseResponse,
  type PlanSession,
  type Problem,
} from "@running-coach/shared";
import { addDays } from "../src/lib/dates";
import { errorMessages } from "../src/lib/errors";
import { formatDistance, formatDuration } from "../src/lib/format";
import type { GarminCaption } from "../src/lib/garmin-state";
import { adjustmentLine } from "../src/lib/session-adjustment";
import { sessionTypeName } from "../src/lib/session-type";
import { sessionName } from "../src/lib/workout-steps";
import { PAUSE_ADVICE, PAUSE_REASON_LABELS, todayCopy } from "../src/screens/today/today-copy";
import { expect, test } from "./fixtures/login";
import {
  connectGarmin,
  runnerToday,
  seedPlanSessions,
  seedRunOn,
  seedSessionsOnGarmin,
} from "./fixtures/seed";
import { skipSyncOnOpen } from "./fixtures/sync";

// Every flow here runs on the real clock: the API pauses from the server's own today, so the sessions are
// seeded around the runner's real today and the browser reads the same date.

/**
 * How long a push may take to show: the worker polls every 2 s, a push to the fixture Garmin takes about
 * a second, and a screen reads the push status again every 3 s while one runs.
 */
const PUSH_SHOWN_MS = 20_000;

function nextSevenDays(page: Page): Locator {
  return page.getByRole("region", { name: "Next 7 days" });
}

/** A session's link on Today's next 7 days, by its id, whatever the session is called by now. */
function sessionLink(page: Page, id: string): Locator {
  return nextSevenDays(page).locator(`a[href="/plan/sessions/${id}"]`);
}

/**
 * A session link's name as Today reads it out: its name, its type when a title took the name's place,
 * distance, time, its caption and what a change made of it: "Walk-run, Easy, 2.9 km, 20:00, On Garmin,
 * Eased for your return, was Tempo 6.5 km".
 */
function linkName(
  session: Pick<PlanSession, "title" | "type" | "target" | "adjustment">,
  caption: GarminCaption,
): string {
  const { distanceM, durationS } = session.target;
  return [
    sessionName(session),
    session.title === null ? null : sessionTypeName(session.type),
    formatDistance(distanceInUnits(distanceM, "km"), "km"),
    formatDuration(durationS),
    caption,
    adjustmentLine(session, "km"),
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/** The panel Not feeling 100% opens, named by its question. */
function pausePanel(page: Page): Locator {
  return page.getByRole("group", { name: todayCopy.pauseQuestion });
}

/** Taps a reason's segment: the radios are visually hidden, so a thumb taps the label. */
async function chooseReason(panel: Locator, label: string): Promise<void> {
  await panel
    .getByRole("group", { name: todayCopy.pauseReason })
    .getByText(label, { exact: true })
    .click();
}

/** The paused card above the week, named by its title. */
function pausedCard(page: Page, startDate: string): Locator {
  return page.getByRole("region", { name: todayCopy.pausedSince(startDate) });
}

async function readCalendar(page: Page, from: string): Promise<CalendarResponse> {
  const query = new URLSearchParams({ from, to: addDays(from, PUSH_WINDOW_DAYS - 1) });
  const response = await page.request.get(`/api/calendar?${query.toString()}`);
  expect(response.ok()).toBe(true);
  return calendarResponseSchema.parse(await response.json());
}

async function readPause(page: Page): Promise<PauseResponse> {
  const response = await page.request.get("/api/pause");
  expect(response.ok()).toBe(true);
  return pauseResponseSchema.parse(await response.json());
}

/** The calendar's sessions by id. */
function sessionsById(calendar: CalendarResponse): Map<string, PlanSession> {
  return new Map(
    calendar.days.flatMap((day) => day.sessions).map((session) => [session.id, session]),
  );
}

test("Sick pauses the week and takes it off the watch, and I'm back after 9 days off eases it to walk-run", async ({
  page,
}) => {
  // Connected first: the first connect of a worker goes through the API, whose push must not send these.
  await connectGarmin(page.request);
  const today = runnerToday();
  // The last run, 9 days before today: the return runs at 70%, and after illness its first week is
  // walk-run.
  await seedRunOn(addDays(today, -9), { distanceM: 8000, durationS: 2700 });
  const sessions = await seedPlanSessions([
    { date: today, type: "easy" },
    { date: addDays(today, 2), type: "tempo" },
    { date: addDays(today, PUSH_WINDOW_DAYS - 1), type: "long" },
  ]);
  await seedSessionsOnGarmin(sessions.map((session) => session.date));
  await skipSyncOnOpen(page);

  await page.goto("/");
  const planned = sessions.map((session) => ({ ...session, title: null, adjustment: null }));
  for (const session of planned) {
    await expect(sessionLink(page, session.id)).toHaveAccessibleName(
      linkName(session, "On Garmin"),
    );
  }

  await nextSevenDays(page).getByRole("button", { name: todayCopy.notFeeling }).click();
  const panel = pausePanel(page);
  const pauseTraining = panel.getByRole("button", { name: todayCopy.pauseTraining });
  // Nothing to send until a reason is chosen.
  await expect(pauseTraining).toBeDisabled();
  await chooseReason(panel, PAUSE_REASON_LABELS.sick);
  await expect(panel.getByText(PAUSE_ADVICE.sick, { exact: true })).toBeVisible();
  // Illness gets fixed rest advice with a pointer to a doctor, and says it is not medical advice.
  await expect(panel).toContainText("See a doctor");
  await expect(panel.getByText(todayCopy.notMedicalAdvice, { exact: true })).toBeVisible();
  await pauseTraining.click();

  // The card arrives with the week already paused; the panel and Not feeling 100% give way to it.
  const card = pausedCard(page, today);
  await expect(card.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(card.getByText(PAUSE_ADVICE.sick, { exact: true })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(nextSevenDays(page).getByRole("button", { name: todayCopy.notFeeling })).toHaveCount(
    0,
  );
  for (const session of planned) {
    await expect(sessionLink(page, session.id)).toHaveAccessibleName(linkName(session, "Paused"));
  }
  expect((await readPause(page)).pause).toMatchObject({ reason: "sick", startDate: today });
  // The pause queued a push, which takes every paused workout off Garmin.
  await expect
    .poll(
      async () => {
        const calendar = await readCalendar(page, today);
        const stored = sessionsById(calendar);
        return {
          onGarmin: sessions.map((session) => stored.get(session.id)?.onGarmin),
          paused: sessions.map((session) => stored.get(session.id)?.paused),
          pushing: calendar.garmin.pushing,
        };
      },
      { timeout: PUSH_SHOWN_MS },
    )
    .toEqual({ onGarmin: [false, false, false], paused: [true, true, true], pushing: false });

  const ended = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/pause/end",
  );
  await card.getByRole("button", { name: todayCopy.imBack }).click();
  const response = await ended;
  expect(response.ok()).toBe(true);
  expect(endPauseResponseSchema.parse(await response.json()).reEntry).toEqual({
    daysOff: 9,
    factor: 0.7,
    walkRun: true,
    fromDate: today,
    sessionsChanged: 3,
  });

  const outcome =
    "9 days off: the next sessions are eased to 70% and build back up by at most 10% a week. This week is walk-run.";
  await expect(page.getByText(outcome, { exact: true })).toBeVisible();
  await expect(pausedCard(page, today)).toHaveCount(0);
  await expect(
    nextSevenDays(page).getByRole("button", { name: todayCopy.notFeeling }),
  ).toBeVisible();

  // Every session of the first week back, quality and long run included, is now a walk-run (4 min run,
  // 1 min walk) of the eased time, logged as the pause's re-entry with the session as planned.
  const stored = sessionsById(await readCalendar(page, today));
  const eased = sessions.map((session) => {
    const after = stored.get(session.id);
    if (!after) throw new Error(`Session ${session.id} left the calendar`);
    expect(after).toMatchObject({
      type: "easy",
      title: "Walk-run",
      status: "planned",
      paused: false,
      steps: [
        {
          repeat: expect.any(Number),
          steps: [
            { kind: "run", zone: "easy", distanceM: null, durationS: 240 },
            { kind: "recovery", zone: "easy", distanceM: null, durationS: 60 },
          ],
        },
      ],
      adjustment: {
        source: "pause",
        kind: "re_entry",
        activityId: null,
        original: { type: session.type, title: null, target: session.target },
      },
    });
    return after;
  });
  // The push I'm back queued puts the walk-runs on the watch.
  for (const session of eased) {
    await expect(sessionLink(page, session.id)).toHaveAccessibleName(
      linkName(session, "On Garmin"),
      { timeout: PUSH_SHOWN_MS },
    );
  }

  // The plan keeps what I'm back did; the line about it was for the tap and goes with a reload.
  await page.reload();
  await expect(
    nextSevenDays(page).getByRole("button", { name: todayCopy.notFeeling }),
  ).toBeVisible();
  for (const session of eased) {
    await expect(sessionLink(page, session.id)).toHaveAccessibleName(
      linkName(session, "On Garmin"),
    );
  }
  await expect(pausedCard(page, today)).toHaveCount(0);
  await expect(page.getByText(outcome, { exact: true })).toHaveCount(0);
  expect((await readPause(page)).pause).toBeNull();
});

test("Need a break advises rest without a medical pointer, and Pain or injury points to a physio and pauses", async ({
  page,
}) => {
  const today = runnerToday();
  const [session] = await seedPlanSessions([{ date: addDays(today, 1), type: "easy" }]);
  if (!session) throw new Error("No session was seeded");
  // Garmin is not connected, so opening the app does not sync.
  await page.goto("/");
  const notFeeling = nextSevenDays(page).getByRole("button", { name: todayCopy.notFeeling });

  // Keep training closes the panel and sends nothing.
  await notFeeling.click();
  await pausePanel(page).getByRole("button", { name: todayCopy.keepTraining }).click();
  await expect(pausePanel(page)).toHaveCount(0);
  await expect(notFeeling).toBeVisible();
  expect((await readPause(page)).pause).toBeNull();

  await notFeeling.click();
  const panel = pausePanel(page);
  await chooseReason(panel, PAUSE_REASON_LABELS.break);
  await expect(panel.getByText(PAUSE_ADVICE.break, { exact: true })).toBeVisible();
  await expect(panel.getByText(todayCopy.notMedicalAdvice)).toHaveCount(0);
  await expect(panel).not.toContainText(/doctor|physio/);

  await chooseReason(panel, PAUSE_REASON_LABELS.injured);
  await expect(panel.getByText(PAUSE_ADVICE.injured, { exact: true })).toBeVisible();
  await expect(panel).toContainText("a doctor or physio");
  await expect(panel.getByText(todayCopy.notMedicalAdvice, { exact: true })).toBeVisible();
  await expect(panel.getByText(PAUSE_ADVICE.break)).toHaveCount(0);
  await panel.getByRole("button", { name: todayCopy.pauseTraining }).click();

  const card = pausedCard(page, today);
  await expect(card.getByText(PAUSE_ADVICE.injured, { exact: true })).toBeVisible();
  await expect(card.getByText(todayCopy.notMedicalAdvice, { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: todayCopy.imBack })).toBeVisible();
  await expect(sessionLink(page, session.id)).toHaveAccessibleName(
    linkName({ ...session, title: null, adjustment: null }, "Paused"),
  );
  expect((await readPause(page)).pause).toMatchObject({ reason: "injured", startDate: today });
});

test("a Pause training that fails says what failed, keeps the panel, and Retry pauses", async ({
  page,
}) => {
  const today = runnerToday();
  await seedPlanSessions([{ date: today, type: "easy" }]);
  const failure = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: ErrorCode.internal,
    requestId: "e2e-pause-failure",
  } satisfies Problem;
  // Only the start fails; reading the pause goes through.
  await page.route("**/api/pause", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: failure.status,
          contentType: "application/problem+json",
          body: JSON.stringify(failure),
        })
      : route.continue(),
  );

  await page.goto("/");
  await nextSevenDays(page).getByRole("button", { name: todayCopy.notFeeling }).click();
  const panel = pausePanel(page);
  await chooseReason(panel, PAUSE_REASON_LABELS.sick);
  await panel.getByRole("button", { name: todayCopy.pauseTraining }).click();

  await expect(panel.getByRole("alert")).toHaveText(errorMessages.internal);
  await expect(pausedCard(page, today)).toHaveCount(0);
  expect((await readPause(page)).pause).toBeNull();

  await page.unroute("**/api/pause");
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect(
    pausedCard(page, today).getByRole("button", { name: todayCopy.imBack }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await readPause(page)).pause).toMatchObject({ reason: "sick", startDate: today });
});
