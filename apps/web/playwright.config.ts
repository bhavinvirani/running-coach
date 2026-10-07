import path from "node:path";
import { defineConfig, type Project } from "@playwright/test";
import {
  e2eDatabaseUrl,
  e2eMasterKey,
  fakeClaudeCodeToken,
  fakeClaudePort,
  fakeClaudeUrl,
  runner,
} from "./e2e/fixtures/seed";
import { e2eSlot, firstBusyPort } from "./e2e/fixtures/slot";

// Flows (`pnpm test:e2e`) drive a local Chromium. Screens (`pnpm test:screens`) drive the Chromium inside the
// official Playwright image through e2e/run-screens.ts, so host fonts and rendering never reach a baseline.
// Both hit the production web build served by the API in Garmin fixture mode, on the e2e database, and
// the coach on a local fake Claude: the Messages API for a key, and the coach service over a fake Claude
// Code CLI for the owner's Claude plan. This folder's e2e slot (e2e/fixtures/slot.ts) picks every port and
// the database, so worktrees run e2e side by side.

// A second run in this folder, or servers a killed run left behind, would hold the slot's ports: stop here,
// before Playwright clears test-results/ under a running suite. Only the runner checks, once: the workers
// and loader processes it starts (UI mode, watch mode, the VS Code extension) load this file again while
// its own servers hold the ports, and inherit the marker. Nothing is ever killed.
if (process.env.E2E_PORTS_CHECKED === undefined) {
  const busy = await firstBusyPort(e2eSlot);
  if (busy !== undefined) {
    throw new Error(
      `Port ${busy} of e2e slot ${e2eSlot.slot} is in use: another e2e run in this folder, or servers a ` +
        `killed run left behind (lsof -nP -iTCP:${busy} -sTCP:LISTEN names them). Wait for it, or stop them.`,
    );
  }
  process.env.E2E_PORTS_CHECKED = String(process.pid);
}

const PORT = e2eSlot.webPort;
const baseURL = `http://localhost:${PORT}`;

// Never dev's 8777 in any slot, so e2e runs next to `pnpm dev`.
const COACH_SERVICE_PORT = e2eSlot.coachServicePort;
// A fake value for e2e only; the API sends it to the coach service in x-coach-secret.
const coachServiceSecret = "e2e-only-coach-service-secret-not-for-production";

/** Set only by e2e/run-screens.ts, once the Playwright run-server container answers. */
const screensEndpoint = process.env.PW_SCREENS_WS_ENDPOINT;

const flows: Project = {
  name: "flows",
  testMatch: "*.spec.ts",
  testIgnore: "screens/**",
};

const screens: Project = {
  name: "screens",
  testMatch: "screens/*.screen.spec.ts",
  // The browser always runs in the same linux/amd64 image, so baselines carry no platform or project suffix
  // and a macOS laptop and CI compare against the same file.
  snapshotPathTemplate: "{testDir}/{testFileDir}/{testFileName}-snapshots/{arg}{ext}",
  use: {
    // <loopback>: the containerised browser reaches the web port on this machine's localhost through the
    // connection.
    connectOptions: { wsEndpoint: screensEndpoint ?? "", exposeNetwork: "<loopback>" },
  },
};

export default defineConfig({
  testDir: "e2e",
  // One shared owner account and database: tests run one at a time, each from a reset state.
  fullyParallel: false,
  workers: 1,
  // A flaky test is a bug to fix, never to retry.
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Baselines change only through `pnpm test:screens --update`; a missing one fails instead of being written.
  updateSnapshots: "none",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    // The PWA service worker would answer requests before page.route sees them.
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide" },
  },
  // Without the container endpoint the screens project does not exist, so a bare local run can never
  // compare against, or write, a baseline: `--project screens` fails with "Project not found".
  projects: screensEndpoint ? [flows, screens] : [flows],
  webServer: [
    {
      name: "claude",
      // The fake Claude Messages and Models APIs over apps/api/test/fixtures/claude: a fake key picks the
      // fixture (fakeClaudeKey in seed.ts), and nothing ever reaches Anthropic.
      command: `pnpm --filter @running-coach/api fake:claude --port ${fakeClaudePort}`,
      port: fakeClaudePort,
      reuseExistingServer: false,
      timeout: 30_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      // Only pnpm's banner goes to stdout; the fake writes one line to stderr once it listens, and any
      // failure to start.
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      name: "coach",
      // The coach service (apps/coach) as on Render, but running the fake Claude Code CLI instead of the
      // real one: the fake plan token picks its scenario (fakeClaudeCodeToken in seed.ts), and nothing
      // ever reaches Anthropic or a Claude plan. With it set up, the API offers the runner, its owner, the
      // Claude plan.
      command: "pnpm --filter @running-coach/coach exec tsx src/index.ts",
      port: COACH_SERVICE_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      // Its pino lines go to stdout, and at LOG_LEVEL error only a failure writes one; Node's own start-up
      // errors go to stderr.
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "test",
        PORT: String(COACH_SERVICE_PORT),
        LOG_LEVEL: "error",
        COACH_SERVICE_SECRET: coachServiceSecret,
        CLAUDE_CODE_OAUTH_TOKEN: fakeClaudeCodeToken,
        CLAUDE_CODE_EXECUTABLE: path.resolve(
          import.meta.dirname,
          "../coach/test/fake-claude-code.mjs",
        ),
      },
    },
    {
      name: "api",
      // The production bundle served by the API from apps/web/dist, as on Render. The build's progress
      // lines are dropped; its warnings and errors go to stderr and still show. First the slot's database is
      // recreated (e2e/reset-database.ts): Playwright checks each web server's port, in array order, before
      // it starts that server and before global setup, so a second run in the same folder fails on the fake
      // Claude's port before any reset, and the reset runs before the API migrates.
      command:
        "node e2e/reset-database.ts && pnpm --filter @running-coach/web build > /dev/null && pnpm --filter @running-coach/api exec tsx src/index.ts",
      // Waiting on the port fails fast when anything already listens there, instead of testing an unknown
      // server.
      port: PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NODE_ENV: "test",
        PORT: String(PORT),
        APP_URL: baseURL,
        LOG_LEVEL: "error",
        DATABASE_URL: e2eDatabaseUrl,
        // The build draws routes as a sketch, as in CI, even when the root env file holds a real token.
        VITE_MAPBOX_TOKEN: "",
        // Fake values that satisfy config.ts; nothing real is encrypted or signed in e2e.
        MASTER_KEY: e2eMasterKey,
        BETTER_AUTH_SECRET: "e2e-only-better-auth-secret-not-for-production",
        CRON_SECRET: "e2e-only-cron-secret-not-for-production",
        GARMIN_SERVICE_SECRET: "",
        GARMIN_FIXTURES: "1",
        // Every test is the one seeded runner, so the API's six Garmin requests a minute per user would fail
        // a test for what the tests before it sent. The API's integration tests cover the limit.
        GARMIN_ROUTE_LIMIT: "1000",
        // Never dev's 8765 in any slot, so e2e runs next to `pnpm dev`.
        GARMIN_SERVICE_PORT: String(e2eSlot.garminServicePort),
        CLAUDE_BASE_URL: fakeClaudeUrl,
        // As for Garmin: every test saves keys and asks the coach as the one runner, against the API's six
        // a minute per user, which its integration tests cover.
        COACH_ROUTE_LIMIT: "1000",
        COACH_SERVICE_URL: `http://127.0.0.1:${COACH_SERVICE_PORT}`,
        COACH_SERVICE_SECRET: coachServiceSecret,
        // The service is up before the first test, so the wake-up poll answers at once; should it ever not,
        // a test waits 200 ms between polls instead of the 5 s meant for Render's sleeping service.
        COACH_SERVICE_WAKE_POLL_MS: "200",
        OWNER_EMAIL: runner.email,
        OWNER_PASSWORD: runner.password,
        OWNER_NAME: runner.name,
      },
    },
  ],
});
