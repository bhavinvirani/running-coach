import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/lib/config";

const valid = {
  NODE_ENV: "production",
  PORT: "10000",
  APP_URL: "https://running-coach.example.com/",
  DATABASE_URL: "postgresql://user:pass@db.example.com/app",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  BETTER_AUTH_SECRET: "x".repeat(32),
  GARMIN_SERVICE_SECRET: "",
  OWNER_EMAIL: "",
};

describe("parseConfig", () => {
  it("parses a valid environment with defaults, an origin-only APP_URL and empty values as unset", () => {
    const result = parseConfig(valid);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      NODE_ENV: "production",
      PORT: 10000,
      LOG_LEVEL: "info",
      APP_URL: "https://running-coach.example.com",
      GARMIN_SERVICE_PORT: 8765,
      GARMIN_FIXTURES: false,
      OWNER_EMAIL: undefined,
      COACH_MODEL: "claude-opus-5-5",
      COACH_FALLBACK_MODEL: "claude-sonnet-5-5",
      CLAUDE_TIMEOUT_MS: 60_000,
    });
    expect(result.config.GARMIN_SERVICE_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(result.config.CLAUDE_BASE_URL).toBeUndefined();
  });

  it("names every invalid variable without echoing its value", () => {
    const result = parseConfig({
      ...valid,
      MASTER_KEY: Buffer.alloc(16, 1).toString("base64"),
      BETTER_AUTH_SECRET: "short-secret-value",
      DATABASE_URL: "mysql://user:hunter2@db/app",
      APP_URL: undefined,
      GARMIN_FIXTURES: "yes",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.variable).sort()).toEqual([
      "APP_URL",
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
      "GARMIN_FIXTURES",
      "MASTER_KEY",
    ]);
    const text = JSON.stringify(result.problems);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("short-secret-value");
  });

  it("refuses the published dev, test and e2e secrets in production", () => {
    const result = parseConfig({
      ...valid,
      MASTER_KEY: "ZGV2LW9ubHktbWFzdGVyLWtleS0zMi1ieXRlcy1vayE=",
      BETTER_AUTH_SECRET: "dev-only-better-auth-secret-not-for-production",
      CRON_SECRET: "e2e-only-cron-secret-not-for-production",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.variable).sort()).toEqual([
      "BETTER_AUTH_SECRET",
      "CRON_SECRET",
      "MASTER_KEY",
    ]);
    expect(JSON.stringify(result.problems)).not.toContain("dev-only");
  });

  it("accepts the published dev secrets outside production", () => {
    const result = parseConfig({
      ...valid,
      NODE_ENV: "development",
      MASTER_KEY: "ZGV2LW9ubHktbWFzdGVyLWtleS0zMi1ieXRlcy1vayE=",
      BETTER_AUTH_SECRET: "dev-only-better-auth-secret-not-for-production",
      CRON_SECRET: "dev-only-cron-secret",
    });

    expect(result.ok).toBe(true);
  });
});
