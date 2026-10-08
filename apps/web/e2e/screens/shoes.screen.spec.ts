import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { seedShoesList } from "../fixtures/seed-shoes";

// Nothing on Shoes depends on the clock: each pair's totals are its start distance plus its seeded runs,
// and no date is shown.

test("shoes shows the seeded pairs: the active one first, one in use, and one retired past its goal", async ({
  page,
}) => {
  await seedShoesList();

  await page.goto("/settings/shoes");
  const inUse = page.getByRole("region", { name: "In use", exact: true });
  await expect(inUse.getByRole("link")).toHaveCount(2);
  await expect(inUse.getByRole("link").first()).toContainText("286.0 of 650 km");
  // The last pair on the screen, then Add shoes under it.
  await expect(
    page
      .getByRole("region", { name: "Retired", exact: true })
      .getByText("10.5 km past its retire distance", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Add shoes", exact: true })).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("shoes.png", { fullPage: true });
});
