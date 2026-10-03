import { DURATION_PART_LABELS } from "../../src/lib/duration-parts";
import { goalCopy, timePace } from "../../src/screens/goal/goal-copy";
import { expect, test } from "../fixtures/login";
import { planWeekTwoAt, seedPlan, seededPlanInput } from "../fixtures/seed";

test("goal shows the form filled from the seeded half marathon goal and its recent 10K", async ({
  page,
}) => {
  await seedPlan();
  // Pinned as on Plan's capture: the race date picker's range is counted from today, so the two captures
  // stay one moment whatever the date.
  await page.clock.setFixedTime(planWeekTwoAt);

  await page.goto("/plan/goal");
  // Each field holds the saved goal: a half on Sun 21 Feb 2027 with No target ticked, so the target's
  // pickers stay hidden, 4 runs a week with the long run on Sunday, and the recent 10K of 54:41.
  const target = page.getByRole("region", { name: goalCopy.target });
  await expect(
    target
      .getByRole("group", { name: goalCopy.distance })
      .getByRole("radio", { name: "Half", exact: true }),
  ).toBeChecked();
  await expect(target.getByLabel(goalCopy.raceDate, { exact: true })).toHaveValue(
    seededPlanInput.goal.raceDate ?? "",
  );
  await expect(
    target
      .getByRole("group", { name: goalCopy.targetTime, exact: true })
      .getByRole("checkbox", { name: goalCopy.noTarget }),
  ).toBeChecked();
  const week = page.getByRole("region", { name: goalCopy.week });
  await expect(
    week
      .getByRole("group", { name: goalCopy.daysPerWeek })
      .getByRole("radio", { name: "4", exact: true }),
  ).toBeChecked();
  await expect(
    week
      .getByRole("group", { name: goalCopy.longRunDay })
      .getByRole("radio", { name: "Sun", exact: true }),
  ).toBeChecked();
  const recent = page.getByRole("region", { name: goalCopy.recentRace });
  await expect(
    recent
      .getByRole("group", { name: goalCopy.distance })
      .getByRole("radio", { name: "10K", exact: true }),
  ).toBeChecked();
  // The last row on the screen above Save goal: once the recent time's pickers hold 0:54:41 under its
  // pace, every field above it holds the saved goal.
  const time = recent.getByRole("group", { name: goalCopy.time, exact: true });
  await expect(time.getByLabel(DURATION_PART_LABELS.hours, { exact: true })).toHaveValue("0");
  await expect(time.getByLabel(DURATION_PART_LABELS.minutes, { exact: true })).toHaveValue("54");
  await expect(time.getByLabel(DURATION_PART_LABELS.seconds, { exact: true })).toHaveValue("41");
  await expect(time).toHaveAccessibleDescription(timePace("10k", 54 * 60 + 41, "km") ?? "");
  await expect(page.getByRole("button", { name: goalCopy.save })).toBeVisible();

  // A page taller than the viewport would leave the sticky tab bar over a field in a full-page capture;
  // a viewport as tall as the page puts it at the bottom.
  const viewport = page.viewportSize();
  const content = await page.locator("body").boundingBox();
  if (!viewport || !content) throw new Error("The page has no viewport or no laid-out body");
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(content.height) });

  // No mask: every value on the form is the seed's, and the date field shows the seeded race date.
  await expect(page).toHaveScreenshot("goal.png", { fullPage: true });
});
