import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { seedShoeEdit } from "../fixtures/seed-shoes";

// Nothing on Edit shoes depends on the clock: the form is the stored pair, and no date is shown.

test("edit shoes shows the seeded active pair's names and distances, then where it stands and its actions", async ({
  page,
}) => {
  const id = await seedShoeEdit();

  await page.goto(`/settings/shoes/${id}`);
  await expect(page.getByRole("heading", { name: "Edit shoes", level: 1 })).toBeVisible();
  // The loaded form, read back from the stored pair rather than a new pair's defaults.
  await expect(page.getByLabel("Nickname", { exact: true })).toHaveValue("Daily trainer");
  await expect(page.getByLabel("Colour", { exact: true })).toHaveValue("Sand");
  await expect(page.getByLabel("Retire at", { exact: true })).toHaveValue("700");
  await expect(page.getByLabel("Distance before this app", { exact: true })).toHaveValue("120.5");
  await expect(
    page.getByText("Active: new runs from Garmin get these shoes.", { exact: true }),
  ).toBeVisible();
  // The active pair offers no Make active; the last row on the screen is Delete shoes.
  await expect(page.getByRole("button", { name: "Make active", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete shoes", exact: true })).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("shoe.png", { fullPage: true });
});
