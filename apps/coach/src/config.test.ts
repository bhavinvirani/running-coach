import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, systemEnv } from "./config";

const SECRET = "4f1c2a9e7b3d5f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d";
const TOKEN = "fake-plan-token-for-tests";

function problems(env: Record<string, string>) {
  const result = parseConfig(env);
  return result.ok ? [] : result.problems.map((problem) => problem.variable);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseConfig", () => {
  it("defaults: port 8777, a 120 s run budget, development", () => {
    const result = parseConfig({ COACH_SERVICE_SECRET: SECRET });

    expect(result.ok && result.config).toMatchObject({
      NODE_ENV: "development",
      PORT: 8777,
      COACH_RUN_TIMEOUT_MS: 120_000,
    });
    expect(result.ok && result.config.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result.ok && result.config.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
  });

  it("development runs without a plan token: Claude Code uses the laptop's login", () => {
    expect(problems({ NODE_ENV: "development", COACH_SERVICE_SECRET: SECRET })).toEqual([]);
  });

  it("production requires the plan token and the shared secret", () => {
    expect(problems({ NODE_ENV: "production" })).toEqual(
      expect.arrayContaining(["COACH_SERVICE_SECRET"]),
    );
    expect(problems({ NODE_ENV: "production", COACH_SERVICE_SECRET: SECRET })).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(
      problems({
        NODE_ENV: "production",
        COACH_SERVICE_SECRET: SECRET,
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      }),
    ).toEqual([]);
  });

  it("an empty token counts as unset, so production refuses it", () => {
    expect(
      problems({
        NODE_ENV: "production",
        COACH_SERVICE_SECRET: SECRET,
        CLAUDE_CODE_OAUTH_TOKEN: "",
      }),
    ).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("production rejects a published dev or test secret", () => {
    expect(
      problems({
        NODE_ENV: "production",
        COACH_SERVICE_SECRET: "dev-only-coach-service-secret-change-me-0123",
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      }),
    ).toEqual(["COACH_SERVICE_SECRET"]);
  });

  it("rejects a secret shorter than 32 characters", () => {
    expect(problems({ COACH_SERVICE_SECRET: "too-short" })).toEqual(["COACH_SERVICE_SECRET"]);
  });

  it("rejects an API key in the plan token's place, which would bill the API", () => {
    expect(
      problems({ COACH_SERVICE_SECRET: SECRET, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-fake" }),
    ).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("problems never carry the values", () => {
    const result = parseConfig({
      COACH_SERVICE_SECRET: SECRET,
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-fake",
    });

    expect(JSON.stringify(result)).not.toContain("sk-ant-api03-fake");
  });
});

describe("systemEnv", () => {
  it("passes PATH, HOME, TMPDIR and LANG only, never an ANTHROPIC_* key or a secret", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-fake");
    vi.stubEnv("COACH_SERVICE_SECRET", SECRET);
    vi.stubEnv("USER", "runner");
    vi.stubEnv("PATH", "/usr/bin");

    const env = systemEnv({ keychainLogin: false });

    expect(Object.keys(env).every((key) => ["PATH", "HOME", "TMPDIR", "LANG"].includes(key))).toBe(
      true,
    );
    expect(env.PATH).toBe("/usr/bin");
  });

  it("adds USER and LOGNAME for the laptop's keychain login", () => {
    vi.stubEnv("USER", "runner");
    vi.stubEnv("LOGNAME", "runner");

    expect(systemEnv({ keychainLogin: true })).toMatchObject({ USER: "runner", LOGNAME: "runner" });
  });
});
