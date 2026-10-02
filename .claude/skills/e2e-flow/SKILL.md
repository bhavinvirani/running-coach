---
name: e2e-flow
description: Use when adding a Playwright flow or screenshot test in apps/web/e2e for a slice.
---
# E2E flow and screenshot

Copy `apps/web/e2e/settings.spec.ts` and `apps/web/e2e/screens/settings.screen.spec.ts`.

1. Seed: extend `e2e/fixtures/seed.ts` when the flow needs data; it stays deterministic and fictional.
2. Flow spec: log in with the seeded owner through the `login` fixture, drive the UI the way a thumb would (taps and typing, no `page.evaluate`), assert on visible text and on the resulting API state, and cover the error state the issue names through `page.route` interception.
3. Screenshot spec: navigate, wait for the last figure with `toBeVisible`, then `await expect(page).toHaveScreenshot()` with `mask` on anything time-dependent.
4. `pnpm test:screens` runs inside the Playwright Docker image; `--update` rewrites the baselines under `e2e/screens/<spec>-snapshots/`. Commit what it writes and never a baseline from a bare local Playwright run.
5. Both run in CI through `pnpm test:e2e` and `pnpm test:screens` against the compose stack with `GARMIN_FIXTURES=1`.
