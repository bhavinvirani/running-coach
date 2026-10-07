import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";

test("claude shows the owner's coach on the Claude plan, with no key form", async ({ page }) => {
  const chosen = await page.request.patch("/api/me/settings", {
    data: { coachCredential: "plan" },
  });
  expect(chosen.ok()).toBe(true);

  await page.goto("/settings/claude");
  const claude = page.getByRole("region", { name: "Claude", exact: true });
  await expect(claude.getByRole("radio", { name: "Claude plan", exact: true })).toBeChecked();
  // The last row on the screen, in place of the key form.
  await expect(claude.getByText(/^The coach runs on your Claude plan/)).toBeVisible();

  await fitViewportToPage(page);
  await expect(page).toHaveScreenshot("claude-plan.png", { fullPage: true });
});
