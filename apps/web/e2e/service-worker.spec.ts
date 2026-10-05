import { expect, test } from "./fixtures/login";

// The other specs block service workers so that page.route sees every request; this one is about the worker
// that src/app/app-update.ts registers. No screen shows the worker, so this spec reads it with page.evaluate
// and page.waitForFunction: the one exception to e2e-flow's taps and typing.
test.use({ serviceWorkers: "allow" });

test("registers /sw.js for the whole app, takes control, and serves the next open from its cache", async ({
  page,
  baseURL,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const registration = await page.evaluate(async () => {
    const found = await navigator.serviceWorker.getRegistration();
    return { scope: found?.scope, script: found?.active?.scriptURL };
  });
  expect(registration).toEqual({ scope: `${baseURL}/`, script: `${baseURL}/sw.js` });

  const reload = await page.reload();
  expect(reload?.fromServiceWorker()).toBe(true);
  await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
});
