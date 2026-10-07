import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";

test("units shows kilometers chosen, each choice with the same run in its unit", async ({
  page,
}) => {
  await page.goto("/settings/units");
  await expect(page.getByRole("radio", { name: "Kilometers" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Miles" })).not.toBeChecked();
  // The last row on the screen, the caption under the card.
  await expect(
    page.getByText("Distance, pace and elevation everywhere in the app.", { exact: true }),
  ).toBeVisible();

  await fitViewportToPage(page);
  // Nothing here depends on the clock: the helper lines are one fixed example run.
  await expect(page).toHaveScreenshot("units.png", { fullPage: true });
});
