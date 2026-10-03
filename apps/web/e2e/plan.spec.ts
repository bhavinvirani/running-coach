import type { Locator, Page } from "@playwright/test";
import { addDays, daysBetween, nextMonday } from "@running-coach/engine";
import {
  ErrorCode,
  distanceInUnits,
  planResponseSchema,
  recentTimeSchema,
  saveGoalResponseSchema,
  type GeneratedWeek,
  type PlanWeek,
  type Problem,
} from "@running-coach/shared";
import {
  DURATION_PART_LABELS,
  durationSeconds,
  type DurationParts,
} from "../src/lib/duration-parts";
import { errorMessages } from "../src/lib/errors";
import {
  formatDistance,
  formatDistanceValue,
  formatLocalDate,
  formatLocalDay,
  formatTwoDigits,
} from "../src/lib/format";
import { phaseName, weekTitle } from "../src/lib/plan-week";
import { sessionTypeName } from "../src/lib/session-type";
import { conflictSentence, goalCopy, timePace } from "../src/screens/goal/goal-copy";
import { goalPaceFacts, goalWeeks, planCopy } from "../src/screens/plan/plan-copy";
import { planWeekCopy } from "../src/screens/plan-week/plan-week-copy";
import { expect, test } from "./fixtures/login";
import { seedPlan } from "./fixtures/seed";

/** The runner's default zone is UTC, so the API's today is the UTC date. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

type GoalEntry = {
  /** The distance's label on the form: "Half", "Marathon". */
  distance: string;
  raceDate: string;
  /** Left out, No target stays ticked. */
  targetTime?: DurationParts;
  /** Runs a week as the form labels them: "3" to "6". */
  days: string;
  longRunDay: string;
  recent: { distance: string; time: DurationParts };
};

/** Picks a time on a time field's three wheels by the figures they show: "1", "43", "00". */
async function pickTime(field: Locator, time: DurationParts): Promise<void> {
  const shown = {
    hours: String(time.hours),
    minutes: formatTwoDigits(time.minutes),
    seconds: formatTwoDigits(time.seconds),
  };
  for (const part of ["hours", "minutes", "seconds"] as const) {
    const picker = field.getByLabel(DURATION_PART_LABELS[part], { exact: true });
    await picker.selectOption({ label: shown[part] });
    await expect(picker).toHaveValue(String(time[part]));
  }
}

/** A distance as the plan screens print it in the default unit: 22000 → "22.0 km". */
function km(meters: number): string {
  return formatDistance(distanceInUnits(meters, "km"), "km");
}

/**
 * Fills the goal form as a thumb would: taps on the segment labels and the No target box, a date typed in
 * the date field, and times picked on the wheels.
 */
async function fillGoal(page: Page, entry: GoalEntry): Promise<void> {
  const target = page.getByRole("region", { name: goalCopy.target });
  const kind = target.getByRole("group", { name: goalCopy.trainingFor });
  // The radios are visually hidden; a thumb taps their labels.
  await kind.getByText(goalCopy.race, { exact: true }).click();
  await expect(kind.getByRole("radio", { name: goalCopy.race, exact: true })).toBeChecked();
  const distance = target.getByRole("group", { name: goalCopy.distance });
  await distance.getByText(entry.distance, { exact: true }).click();
  await expect(distance.getByRole("radio", { name: entry.distance, exact: true })).toBeChecked();
  await target.getByLabel(goalCopy.raceDate, { exact: true }).fill(entry.raceDate);
  const targetTime = target.getByRole("group", { name: goalCopy.targetTime, exact: true });
  const noTarget = targetTime.getByRole("checkbox", { name: goalCopy.noTarget });
  await expect(noTarget).toBeChecked();
  if (entry.targetTime) {
    await noTarget.uncheck();
    await pickTime(targetTime, entry.targetTime);
  }

  const week = page.getByRole("region", { name: goalCopy.week });
  const days = week.getByRole("group", { name: goalCopy.daysPerWeek });
  await days.getByText(entry.days, { exact: true }).click();
  await expect(days.getByRole("radio", { name: entry.days, exact: true })).toBeChecked();
  const longRunDay = week.getByRole("group", { name: goalCopy.longRunDay });
  await longRunDay.getByText(entry.longRunDay, { exact: true }).click();
  await expect(
    longRunDay.getByRole("radio", { name: entry.longRunDay, exact: true }),
  ).toBeChecked();

  await page.getByRole("button", { name: goalCopy.addRecentRace }).click();
  const recent = page.getByRole("region", { name: goalCopy.recentRace });
  const recentDistance = recent.getByRole("group", { name: goalCopy.distance });
  await recentDistance.getByText(entry.recent.distance, { exact: true }).click();
  await expect(
    recentDistance.getByRole("radio", { name: entry.recent.distance, exact: true }),
  ).toBeChecked();
  await pickTime(
    recent.getByRole("group", { name: goalCopy.time, exact: true }),
    entry.recent.time,
  );
}

/** Taps Save goal and returns the API's answer to it. */
async function saveGoal(page: Page) {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/goal",
  );
  await page.getByRole("button", { name: goalCopy.save }).click();
  const response = await answered;
  expect(response.ok()).toBe(true);
  return saveGoalResponseSchema.parse(await response.json());
}

/** A week card's accessible name up to its date range: "Week 1, Base, 22.0 km,". */
function weekCardName(week: PlanWeek | GeneratedWeek): string {
  return `${weekTitle(week.number)}, ${phaseName(week.phase)}, ${km(week.distanceM)},`;
}

/** What a week's day rows say, Monday to Sunday: the date, then each session's type and distance. */
function dayRowTexts(week: PlanWeek | GeneratedWeek): { day: string; parts: string[] }[] {
  return Array.from({ length: 7 }, (_, offset) => {
    const date = addDays(week.startDate, offset);
    const sessions = week.sessions.filter((session) => session.date === date);
    return {
      day: formatLocalDay(date),
      parts:
        sessions.length === 0
          ? [sessionTypeName("rest")]
          : sessions.flatMap((session) => [
              sessionTypeName(session.type),
              km(session.target.distanceM),
            ]),
    };
  });
}

test("sets a goal and sees the plan", async ({ page }) => {
  const today = todayUtc();
  const raceDate = addDays(today, 20 * 7);
  // The plan starts on the first Monday from today and runs to race week, as the API counts them.
  const startDate = nextMonday(today);
  const weekCount = Math.ceil((daysBetween(startDate, raceDate) + 1) / 7);

  await page.goto("/plan");
  await expect(page.getByText(planCopy.empty, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: planCopy.setGoal }).click();
  await expect(page).toHaveURL(/\/plan\/goal$/);
  await expect(page.getByRole("heading", { name: goalCopy.title, level: 1 })).toBeVisible();

  // The owner's case: a target well ahead of what the recent 10K predicts.
  const targetTime = { hours: 1, minutes: 43, seconds: 0 };
  await fillGoal(page, {
    distance: "Half",
    raceDate,
    targetTime,
    days: "4",
    longRunDay: "Sun",
    recent: { distance: "10K", time: { hours: 0, minutes: 54, seconds: 41 } },
  });
  // Under each time, the pace it means over its distance: 1:43:00 over a half is 4:53 /km.
  await expect(
    page.getByRole("group", { name: goalCopy.targetTime, exact: true }),
  ).toHaveAccessibleDescription(timePace("half", durationSeconds(targetTime), "km") ?? "");
  await expect(
    page.getByRole("group", { name: goalCopy.time, exact: true }),
  ).toHaveAccessibleDescription(timePace("10k", 54 * 60 + 41, "km") ?? "");
  const saved = await saveGoal(page);
  expect(saved.ok).toBe(true);

  await expect(page).toHaveURL(/\/plan$/);
  const goal = page.getByRole("region", { name: planCopy.goal });
  await expect(goal).toContainText("Half");
  await expect(goal).toContainText(`Race on ${formatLocalDate(raceDate)}`);
  // The figure is the weeks to the race, every one of them before the plan starts; its unit is drawn
  // apart, so the two read as one string with no space between them: "20weeks".
  const figure = goalWeeks(weekCount);
  await expect(goal).toContainText(`${figure.value}${figure.unit}`);
  const weeks = page.getByRole("region", { name: planCopy.weeks });
  await expect(weeks.getByRole("link")).toHaveCount(weekCount);

  const { goal: storedGoal, plan } = planResponseSchema.parse(
    await (await page.request.get("/api/plan")).json(),
  );
  expect(storedGoal).toMatchObject({
    kind: "race",
    distanceKey: "half",
    raceDate,
    daysPerWeek: 4,
    longRunDay: "sun",
    targetTimeS: durationSeconds(targetTime),
    recentTime: { distanceKey: "10k", timeS: 54 * 60 + 41 },
  });
  expect(plan?.startDate).toBe(startDate);
  expect(plan?.endDate).toBe(raceDate);
  expect(plan?.weeks).toHaveLength(weekCount);
  if (!plan) throw new Error("The saved goal has no plan");
  if (!storedGoal) throw new Error("The plan has no goal");

  // The target beside the race pace the plan trains at and the finish time it means.
  for (const fact of goalPaceFacts(storedGoal, plan.paces, "km")) {
    await expect(goal).toContainText(fact);
  }
  await expect(goal).toContainText("Target 1:43:00");

  // Every card shows its week's total; the figure is drawn apart from its unit, the name says both.
  for (const week of plan.weeks) {
    await expect(weeks.getByRole("link", { name: weekCardName(week) })).toBeVisible();
  }
  const [firstWeek] = plan.weeks;
  if (!firstWeek) throw new Error("The plan has no weeks");
  const firstCard = weeks.getByRole("link", { name: weekCardName(firstWeek) });
  await expect(firstCard).toContainText(
    formatDistanceValue(distanceInUnits(firstWeek.distanceM, "km")),
  );

  await firstCard.click();
  await expect(page).toHaveURL(/\/plan\/weeks\/1$/);
  await expect(page.getByRole("heading", { name: weekTitle(1), level: 1 })).toBeVisible();
  const rows = page.getByRole("region", { name: planWeekCopy.days }).getByRole("listitem");
  const expected = dayRowTexts(firstWeek);
  await expect(rows.locator("time")).toHaveText(expected.map((row) => row.day));
  for (const [index, row] of expected.entries()) {
    for (const part of row.parts) await expect(rows.nth(index)).toContainText(part);
  }
});

test("reports a conflict and saves nothing", async ({ page }) => {
  await page.goto("/plan/goal");
  await expect(page.getByRole("heading", { name: goalCopy.title, level: 1 })).toBeVisible();

  await fillGoal(page, {
    distance: "Marathon",
    raceDate: addDays(todayUtc(), 20 * 7),
    days: "3",
    longRunDay: "Sun",
    recent: { distance: "10K", time: { hours: 0, minutes: 54, seconds: 41 } },
  });
  const answer = await saveGoal(page);
  expect(answer.ok).toBe(false);

  // The engine's long-run cap: a marathon's long run needs at least 4 runs a week to stay under it.
  await expect(page.getByRole("alert")).toHaveText(
    conflictSentence(
      { code: "long_run_cap", distanceKey: "marathon", daysPerWeek: 3, minDaysPerWeek: 4 },
      "km",
    ),
  );
  await expect(page).toHaveURL(/\/plan\/goal$/);
  await expect(page.getByRole("button", { name: goalCopy.save })).toBeEnabled();

  const stored = planResponseSchema.parse(await (await page.request.get("/api/plan")).json());
  expect(stored).toEqual({ goal: null, plan: null });
});

test("refuses a recent time no run could take under its pickers and sends nothing", async ({
  page,
}) => {
  // Every goal sent from here on, counted where the browser hands it to the network.
  const sent: string[] = [];
  await page.route("**/api/goal", (route) => {
    sent.push(route.request().method());
    return route.continue();
  });
  // The contract's own sentence for a 5K in 5:00, 1:00 /km: the form refuses it with the same words.
  const refused = recentTimeSchema.safeParse({ distanceKey: "5k", timeS: 5 * 60 });
  if (refused.success) throw new Error("The contract takes a 5K in 0:05:00");
  const sentence = refused.error.issues[0]?.message ?? "";

  await page.goto("/plan/goal");
  await expect(page.getByRole("heading", { name: goalCopy.title, level: 1 })).toBeVisible();
  await fillGoal(page, {
    distance: "Half",
    raceDate: addDays(todayUtc(), 20 * 7),
    days: "4",
    longRunDay: "Sun",
    recent: { distance: "5K", time: { hours: 0, minutes: 5, seconds: 0 } },
  });
  await page.getByRole("button", { name: goalCopy.save }).click();

  // Said under the time it is about, and nowhere else: the goal above Save goal has nothing to fix.
  const time = page
    .getByRole("region", { name: goalCopy.recentRace })
    .getByRole("group", { name: goalCopy.time, exact: true });
  await expect(time.getByRole("alert")).toHaveText(sentence);
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page).toHaveURL(/\/plan\/goal$/);
  expect(sent).toEqual([]);
  const stored = planResponseSchema.parse(await (await page.request.get("/api/plan")).json());
  expect(stored).toEqual({ goal: null, plan: null });

  // A time a runner could take clears the sentence, and the same Save goal now sends the goal.
  await pickTime(time, { hours: 0, minutes: 25, seconds: 0 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  const saved = await saveGoal(page);
  expect(saved.ok).toBe(true);
  // One PUT in all, the second Save goal's: one sent by the first would have been routed before it.
  expect(sent).toEqual(["PUT"]);
  await expect(page).toHaveURL(/\/plan$/);
});

test("shows the plan's error state with Retry", async ({ page }) => {
  const seeded = await seedPlan();
  const failure = {
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    code: ErrorCode.internal,
    requestId: "e2e-plan-failure",
  } satisfies Problem;
  // Every try fails until Retry: one failed answer alone would be hidden by the query's retries.
  await page.route("**/api/plan", (route) =>
    route.fulfill({
      status: failure.status,
      contentType: "application/problem+json",
      body: JSON.stringify(failure),
    }),
  );

  await page.goto("/plan");
  // The query retries server errors three times with jittered backoff (at most 2 + 4 + 8 s) before the
  // screen shows its error, so the wait covers that instead of the default 5 s.
  await expect(page.getByRole("alert")).toHaveText(errorMessages.internal, { timeout: 20_000 });
  await expect(page.getByRole("region", { name: planCopy.weeks })).toHaveCount(0);

  await page.unroute("**/api/plan");
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByRole("region", { name: planCopy.goal })).toContainText("Half");
  await expect(page.getByRole("region", { name: planCopy.weeks }).getByRole("link")).toHaveCount(
    seeded.weeks.length,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("shows the week view", async ({ page }) => {
  const seeded = await seedPlan();
  const [firstWeek] = seeded.weeks;
  if (!firstWeek) throw new Error("The seeded plan has no weeks");

  await page.goto("/plan/weeks/1");
  await expect(page.getByRole("heading", { name: weekTitle(1), level: 1 })).toBeVisible();
  await expect(page.getByRole("main")).toContainText(
    formatDistanceValue(distanceInUnits(firstWeek.distanceM, "km")),
  );

  const rows = page.getByRole("region", { name: planWeekCopy.days }).getByRole("listitem");
  await expect(rows.locator("time")).toHaveText([
    "Mon 5 Oct",
    "Tue 6 Oct",
    "Wed 7 Oct",
    "Thu 8 Oct",
    "Fri 9 Oct",
    "Sat 10 Oct",
    "Sun 11 Oct",
  ]);
  // The goal's long run day.
  await expect(rows.last()).toContainText(sessionTypeName("long"));
  for (const [index, row] of dayRowTexts(firstWeek).entries()) {
    for (const part of row.parts) await expect(rows.nth(index)).toContainText(part);
  }

  // Opened from a link, Back has no earlier entry in the app and goes to the plan.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByRole("heading", { name: planCopy.title, level: 1 })).toBeVisible();
});
