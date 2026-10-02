---
name: e2e-flow
description: Use when adding a Playwright flow or screenshot test in apps/web/e2e for a slice.
---

# E2E flow and screenshot

Copy `apps/web/e2e/settings.spec.ts`, `apps/web/e2e/screens/settings.screen.spec.ts` and `apps/web/e2e/fixtures/login.ts`.

1. Seed: extend `e2e/fixtures/seed.ts` when the flow needs data; it holds the fictional runner and `resetRunner()`, and stays deterministic and fictional.
2. Flow spec: import `test` and `expect` from `./fixtures/login` (an auto fixture signs the runner in and resets settings), drive the UI the way a thumb would (taps and typing, no `page.evaluate`), assert on visible text and on the resulting API state through `page.request`, and cover the error state the issue names through `page.route` interception.
3. Screenshot spec `e2e/screens/<name>.screen.spec.ts`: navigate, wait for the last row with `toBeVisible`, then `await expect(page).toHaveScreenshot("<name>.png", { fullPage: true })` with `mask` on anything time-dependent.
4. `pnpm test:screens` (`e2e/run-screens.ts`) runs the browser in the Playwright Docker image; `--update` writes `e2e/screens/<spec>-snapshots/<name>.png`. The screens project exists only under that script, so a bare local Playwright run can neither compare nor write a baseline. Commit what it writes.
5. Both commands start their own API from `playwright.config.ts`: the production web build on port 4173, the `running_coach_e2e` database, `GARMIN_FIXTURES=1`, the runner from `seed.ts` as owner. Locally that database is in the compose Postgres; in CI, a Postgres service container with the same port and databases.
