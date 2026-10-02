---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "apps/api/test/**"
  - "apps/web/e2e/**"
  - "services/garmin/tests/**"
---
# Tests

- Unit tests sit beside the source as `<file>.test.ts` (Vitest). API integration tests live in `apps/api/test/` and run on the real Postgres from docker compose (`DATABASE_URL_TEST`), one schema per test file, truncated between tests. No DB mocks, no in-memory substitutes.
- Only the Garmin service and Claude are faked: integration tests start the Python service with `GARMIN_FIXTURES=1` and point the coach client at a local fake that replays `apps/api/test/fixtures/claude/*.json`.
- Fixtures are fake or sanitized: no real names, locations, coordinates, ids, emails, keys or tokens. Seed data for e2e and screenshots comes from `apps/web/e2e/fixtures/seed.ts`: deterministic, 12 weeks of runs for a fictional runner.
- Playwright flows in `apps/web/e2e/<flow>.spec.ts` at 390 × 844, `colorScheme: "dark"`, animations disabled. Screenshot specs in `apps/web/e2e/screens/` use `toHaveScreenshot`; `pnpm test:screens` always runs inside the Playwright Docker image (`--update` rewrites baselines) so local fonts never leak in; baselines live in `apps/web/e2e/screens/<spec>-snapshots/`, Playwright's default.
- Every screen's Vitest spec covers loading, empty and error states; its screenshot spec captures the loaded state on seed data.
- Engine: one `describe` per rule, boundary values plus a fast-check property.
- Python: pytest, fake client over `tests/fixtures`, per endpoint the success path, bad secret, 429 and expired token.
- A test that needs the network, the owner's Garmin account, a real Claude key or real data is wrong: fake the dependency or delete the test.
- Names state the behaviour: `it("returns 401 and stores nothing when the bundle is expired")`.
