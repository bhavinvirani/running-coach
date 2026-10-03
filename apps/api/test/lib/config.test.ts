import { describe, expect, it } from "vitest";
import { coachServiceOf, coachServiceWarning, parseConfig } from "../../src/lib/config";

const valid = {
  NODE_ENV: "production",
  PORT: "10000",
  APP_URL: "https://running-coach.example.com/",
  DATABASE_URL: "postgresql://user:pass@db.example.com/app",
  MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  BETTER_AUTH_SECRET: "x".repeat(32),
  CRON_SECRET: "c".repeat(64),
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
      GARMIN_ROUTE_LIMIT: 6,
      OWNER_EMAIL: undefined,
      COACH_MODEL: "claude-opus-5-5",
      COACH_FALLBACK_MODEL: "claude-sonnet-5-5",
      CLAUDE_TIMEOUT_MS: 60_000,
      COACH_SERVICE_WAKE_MS: 120_000,
      COACH_SERVICE_WAKE_POLL_MS: 5_000,
      COACH_SERVICE_TIMEOUT_MS: 150_000,
    });
    expect(result.config.GARMIN_SERVICE_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(result.config.CLAUDE_BASE_URL).toBeUndefined();
    expect(coachServiceOf(result.config)).toBeNull();
    expect(coachServiceWarning(result.config)).toBeNull();
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

  it("requires CRON_SECRET in production, so the daily sync cannot stop silently", () => {
    for (const missing of [undefined, ""]) {
      const result = parseConfig({ ...valid, CRON_SECRET: missing });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems).toEqual([
        { variable: "CRON_SECRET", message: "is required in production" },
      ]);
    }
  });

  it("leaves CRON_SECRET optional in development and test", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const result = parseConfig({ ...valid, NODE_ENV, CRON_SECRET: undefined });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.CRON_SECRET).toBeUndefined();
    }
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

describe("the coach service", () => {
  const COACH_SECRET = "k".repeat(48);

  it("turns the Claude plan on when both COACH_SERVICE_URL and COACH_SERVICE_SECRET are set, the URL as its origin", () => {
    const result = parseConfig({
      ...valid,
      COACH_SERVICE_URL: "https://coach.example.com/v1/",
      COACH_SERVICE_SECRET: COACH_SECRET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(coachServiceOf(result.config)).toEqual({
      url: "https://coach.example.com",
      secret: COACH_SECRET,
    });
    expect(coachServiceWarning(result.config)).toBeNull();
  });

  it.each([
    [
      "COACH_SERVICE_URL",
      { COACH_SERVICE_URL: "https://coach.example.com" },
      "COACH_SERVICE_SECRET",
    ],
    ["COACH_SERVICE_SECRET", { COACH_SERVICE_SECRET: COACH_SECRET }, "COACH_SERVICE_URL"],
  ])(
    "keeps the plan off and boots, with a warning naming the other variable, when only %s is set",
    (_set, env, missing) => {
      const result = parseConfig({ ...valid, ...env });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(coachServiceOf(result.config)).toBeNull();
      expect(coachServiceWarning(result.config)).toMatch(new RegExp(`^${missing} is not set`));
    },
  );

  it("refuses a published dev, test or e2e coach service secret in production, without echoing it", () => {
    const published = "dev-only-coach-service-secret-not-for-production";
    const result = parseConfig({
      ...valid,
      COACH_SERVICE_URL: "https://coach.example.com",
      COACH_SERVICE_SECRET: published,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.variable)).toEqual(["COACH_SERVICE_SECRET"]);
    expect(JSON.stringify(result.problems)).not.toContain(published);
  });

  it("accepts the published coach service secret outside production", () => {
    const result = parseConfig({
      ...valid,
      NODE_ENV: "development",
      COACH_SERVICE_SECRET: "dev-only-coach-service-secret-not-for-production",
    });

    expect(result.ok).toBe(true);
  });

  it("refuses a coach service secret under 32 characters and a URL that is not http or https (a bare host:port)", () => {
    const result = parseConfig({
      ...valid,
      COACH_SERVICE_URL: "coach-service:10000",
      COACH_SERVICE_SECRET: "too-short-secret",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.variable).sort()).toEqual([
      "COACH_SERVICE_SECRET",
      "COACH_SERVICE_URL",
    ]);
    expect(JSON.stringify(result.problems)).not.toContain("too-short-secret");
  });

  it("treats empty coach service values as unset", () => {
    const result = parseConfig({ ...valid, COACH_SERVICE_URL: "", COACH_SERVICE_SECRET: "" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(coachServiceOf(result.config)).toBeNull();
    expect(coachServiceWarning(result.config)).toBeNull();
  });
});
