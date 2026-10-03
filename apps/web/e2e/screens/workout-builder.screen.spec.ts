import { builderCopy } from "../../src/screens/workout-builder/builder-copy";
import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { planWeekTwoAt, seedPlan } from "../fixtures/seed";

test("workout builder shows the intervals preset at the seeded plan's paces", async ({ page }) => {
  await seedPlan();
  // Pinned in week 2, so Thu 15 Oct is a day from today on, as Add on its row opens the builder.
  await page.clock.setFixedTime(planWeekTwoAt);

  await page.goto("/plan/sessions/new?date=2026-10-15");
  const type = page.getByRole("group", { name: builderCopy.type, exact: true });
  // The radios are visually hidden; a thumb taps the chip.
  await type.getByText("Intervals", { exact: true }).click();
  await expect(type.getByRole("radio", { name: "Intervals", exact: true })).toBeChecked();
  await expect(page.getByLabel(builderCopy.timesOf("2"), { exact: true })).toHaveValue("5");
  await expect(page.getByRole("region", { name: builderCopy.summary, exact: true })).toBeVisible();
  // The last row on the screen: once it shows, the form above it has rendered.
  await expect(page.getByRole("button", { name: builderCopy.save })).toBeVisible();

  await fitViewportToPage(page);
  // No mask: the date is the link's, the zones' paces are the seeded plan's.
  await expect(page).toHaveScreenshot("workout-builder.png", { fullPage: true });
});
