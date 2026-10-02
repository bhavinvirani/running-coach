import { defineProject } from "vitest/config";

// Integration tests on the real compose Postgres: test/global-setup.ts migrates a template database once per
// run, test/setup-database.ts gives every test file its own clone of it. The global setup also starts the
// Garmin service in fixture mode and a fake Claude API; the setup file points GARMIN_SERVICE_PORT and
// CLAUDE_BASE_URL at them.
export default defineProject({
  test: {
    name: "api",
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup-database.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Fake values only. DATABASE_URL is set per file by the setup; DATABASE_URL_TEST picks the server.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_URL: "http://localhost:5173",
      MASTER_KEY: "dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMhISE=",
      BETTER_AUTH_SECRET: "test-only-better-auth-secret-not-a-real-secret",
      GARMIN_SERVICE_SECRET: "test-only-garmin-service-secret",
      GARMIN_FIXTURES: "1",
      // The fake Claude's "timeout" fixture answers after 5 s.
      CLAUDE_TIMEOUT_MS: "1500",
      CRON_SECRET: "test-only-cron-secret",
      OWNER_EMAIL: "",
      OWNER_PASSWORD: "",
      OWNER_NAME: "",
    },
  },
});
