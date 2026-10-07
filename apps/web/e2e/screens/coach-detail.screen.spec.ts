import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";

test("coach detail shows standard chosen, each level with what the coach writes", async ({
  page,
}) => {
  await page.goto("/settings/coach-detail");
  await expect(page.getByRole("radio", { name: "Standard" })).toBeChecked();
  // The last row on the screen, the caption under the card.
  await expect(
    page.getByText("How much the coach writes on each run and weekly review.", { exact: true }),
  ).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("coach-detail.png", { fullPage: true });
});
