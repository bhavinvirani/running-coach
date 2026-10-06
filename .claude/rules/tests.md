---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "apps/api/test/**"
  - "apps/coach/test/**"
  - "apps/web/e2e/**"
  - "apps/web/playwright.config.ts"
  - "services/garmin/tests/**"
---

# Tests

- Unit tests sit beside the source as `<file>.test.ts` (Vitest). API tests live in `apps/api/test/` and run on the real Postgres from docker compose: `test/global-setup.ts` migrates a template database once per run (admin connection `DATABASE_URL_TEST`), `test/setup-database.ts` clones it into one database per test file, truncated before each test. No DB mocks, no in-memory substitutes.
- Only the Garmin service and Claude are faked: the global setup starts the real Python service with `GARMIN_FIXTURES=1` and a local fake Claude (`test/fake-claude.ts`) that replays `apps/api/test/fixtures/claude/*.json`; `test/seed.ts` builds the rows and the bundle or key that picks each fixture. On the Claude plan path the API tests stand a fake coach service (`test/fake-coach-service.ts`) behind the shared contract, since api cannot import apps/coach; apps/coach's own tests and e2e run the real coach service over a fake Claude Code CLI (`apps/coach/test/fake-claude-code.mjs`) picked by the fake token.
- Fixtures are fake or sanitized: no real names, locations, coordinates, ids, emails, keys or tokens. Seed data for e2e and screenshots comes from `apps/web/e2e/fixtures/seed.ts`: deterministic, one fictional runner; it grows runs when a slice needs them.
- Playwright flows in `apps/web/e2e/<flow>.spec.ts` at 390 × 844, `colorScheme: "dark"`, reduced motion, service workers blocked so `page.route` sees every request, except in `e2e/service-worker.spec.ts`; `e2e/app-update.spec.ts` stands in for another deploy by routing `/api/me`, `/index.html` or a screen's chunk. `apps/web/playwright.config.ts` starts its own API with the production web build on port 4173, its own database (`running_coach_e2e`), fixture Garmin, the fake Claude, the real coach service over the fake Claude Code CLI, and the seeded runner as owner (offered the Claude plan; `resetRunner` puts it back on key); specs import `test` from `e2e/fixtures/login.ts`, which signs in once per worker (`storageState`) and resets the runner before each test (default settings, no runs, no Garmin connection; `seed.ts` seeds what a test needs, with a pinned `last_sync_at` so fixture runs never age out); a test that logs out uses plain Playwright `test` and signs in itself (`login.spec.ts`). Every e2e test is the same runner, so the e2e API raises the per-user Garmin route limit (`GARMIN_ROUTE_LIMIT`; integration tests cover the limit) while the auth limit stays on (sign in once per worker); `connectGarmin` spends one Garmin login per worker, and a test about anything but the sync on open opens the app without it: `skipSyncOnOpen` in `e2e/fixtures/sync.ts`, or a sync through the API (`syncGarmin` in `seed.ts`) just before, which leaves the last sync under 10 minutes old.
- Screenshot specs in `apps/web/e2e/screens/<name>.screen.spec.ts` use `toHaveScreenshot("<name>.png")` with animations disabled. `pnpm test:screens` (`e2e/run-screens.ts`) runs the browser in the linux/amd64 Playwright Docker image (CI's architecture, emulated on arm64) so local fonts never leak in (`--update` rewrites every baseline); the screens project exists only there. Baselines: `apps/web/e2e/screens/<spec>-snapshots/<name>.png`, no platform or project suffix.
- Every screen's Vitest spec covers loading, error and, when the screen can be empty, empty states; its screenshot spec captures the loaded state on seed data.
- Engine: one `describe` per rule, boundary values plus a fast-check property.
- Python: pytest over `garmin_service/fake_client.py` and `tests/fixtures`; per endpoint the success path, bad secret, 429 and expired token; `tests/test_contract.py` checks every response against the exported JSON Schema.
- A test that needs the network, the owner's Garmin account, a real Claude key or real data is wrong: fake the dependency or delete the test.
- Names state the behaviour: `it("returns 401 and stores nothing when the bundle is expired")`.
