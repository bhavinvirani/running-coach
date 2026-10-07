---
name: e2e-flow
description: Use when adding a Playwright flow or screenshot test in apps/web/e2e for a slice.
---

# E2E flow and screenshot

Copy `apps/web/e2e/settings.spec.ts`, `apps/web/e2e/screens/settings.screen.spec.ts` and `apps/web/e2e/fixtures/login.ts`.

1. Seed: when the flow needs data, add it to a per-feature file `e2e/fixtures/seed-<feature>.ts`, deterministic and fictional. `e2e/fixtures/seed.ts` holds the fictional runner, `resetRunner()` and the shared helpers, and only gains `resetRunner` delete lines, so parallel lanes never edit the same lines.
2. Flow spec: import `test` and `expect` from `./fixtures/login` (signs the runner in once per worker through `storageState` and resets the runner before each test: default settings, no runs, no Garmin connection; a test that logs out uses plain Playwright `test` and signs in itself, as `login.spec.ts` does), drive the UI the way a thumb would (taps and typing, no `page.evaluate`), assert on visible text and on the resulting API state through `page.request`, and cover the error state the issue names through `page.route` interception. `/api/me` is preloaded by the route loader, so failing it tests `ScreenErrorBoundary`; a screen's own error state is tested by failing an endpoint that screen fetches.
3. Screenshot spec `e2e/screens/<name>.screen.spec.ts`: navigate, wait for the last row with `toBeVisible`, then `await expect(page).toHaveScreenshot("<name>.png", { fullPage: true })` with `mask` on anything time-dependent. A page taller than the viewport sets the viewport to the page height first, or the fixed tab bar is drawn mid-page (`progress.screen.spec.ts`).
4. `pnpm test:screens` (`e2e/run-screens.ts`) runs the browser in the linux/amd64 Playwright image (CI's architecture, emulated on arm64); `--update` (Playwright's `--update-snapshots=all`) rewrites `e2e/screens/<spec>-snapshots/<name>.png`; pass the spec too (`pnpm test:screens --update e2e/screens/<name>.screen.spec.ts`) so only its baselines change. The screens project exists only under that script, so a bare local Playwright run can neither compare nor write a baseline. Open every changed PNG, then commit what it writes; a baseline is never merged by hand.
5. Both commands start their own API from `playwright.config.ts` on this folder's e2e slot (`e2e/fixtures/slot.ts`): the production web build on port 4173 (4173 + 10·N in slot N), the `running_coach_e2e` database (`running_coach_e2e_N`), recreated before every run, `GARMIN_FIXTURES=1`, the runner from `seed.ts` as owner. Locally that database is in the compose Postgres; in CI, a Postgres service container with the same port.
