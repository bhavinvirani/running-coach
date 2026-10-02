import { defineConfig, type Project } from "@playwright/test";
import { e2eDatabaseUrl, runner } from "./e2e/fixtures/seed";

// Flows (`pnpm test:e2e`) drive a local Chromium. Screens (`pnpm test:screens`) drive the Chromium inside the
// official Playwright image through e2e/run-screens.ts, so host fonts and rendering never reach a baseline.
// Both hit the production web build served by the API in Garmin fixture mode, on the e2e database.

const PORT = 4173;
const baseURL = `http://localhost:${PORT}`;

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
    // <loopback>: the containerised browser reaches localhost:4173 on this machine through the connection.
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
  webServer: {
    name: "api",
    // The production bundle served by the API from apps/web/dist, as on Render. The build's progress lines
    // are dropped; its warnings and errors go to stderr and still show.
    command:
      "pnpm --filter @running-coach/web build > /dev/null && pnpm --filter @running-coach/api exec tsx src/index.ts",
    // Waiting on the port fails fast when anything already listens there, instead of testing an unknown server.
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
      MASTER_KEY: "ZTJlLW9ubHktbWFzdGVyLWtleS0zMi1ieXRlcy1vayE=",
      BETTER_AUTH_SECRET: "e2e-only-better-auth-secret-not-for-production",
      CRON_SECRET: "e2e-only-cron-secret-not-for-production",
      GARMIN_SERVICE_SECRET: "",
      GARMIN_FIXTURES: "1",
      // Not dev's 8765, so e2e runs next to `pnpm dev`.
      GARMIN_SERVICE_PORT: "8775",
      CLAUDE_BASE_URL: "",
      OWNER_EMAIL: runner.email,
      OWNER_PASSWORD: runner.password,
      OWNER_NAME: runner.name,
    },
  },
});
