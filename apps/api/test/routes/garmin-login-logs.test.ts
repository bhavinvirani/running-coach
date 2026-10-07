import { ErrorCode } from "@running-coach/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startBoss, stopBoss } from "../../src/jobs/boss";
import * as pushQueue from "../../src/jobs/push-workouts-queue";
import { logger } from "../../src/lib/logger";
import { connectGarminLimiter } from "../../src/routes/garmin";
import { createTestApp, expectProblem, signedInAgent } from "../helpers";
import { captureAppLogs, FIXTURE_LOGIN } from "../seed-garmin-login";

// Every log level on for this file only (vitest.config.ts makes the API silent), before the config loads.
vi.hoisted(() => {
  vi.stubEnv("LOG_LEVEL", "trace");
});

const app = createTestApp();

beforeAll(async () => {
  const boss = await startBoss();
  await boss.createQueue(pushQueue.name, pushQueue.queue);
});

afterAll(async () => {
  await stopBoss();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  connectGarminLimiter.reset();
});

describe("web Garmin login logs", () => {
  it("never writes the email, password or code to any API log line: login, wrong code, right code, 429", async () => {
    const lines = captureAppLogs();
    const agent = await signedInAgent(app);
    const password = FIXTURE_LOGIN.password;

    expect(
      (await agent.post("/api/garmin/login").send({ email: FIXTURE_LOGIN.email, password })).status,
    ).toBe(200);
    expectProblem(
      await agent.post("/api/garmin/login/code").send({ mfaCode: FIXTURE_LOGIN.wrongCode }),
      422,
      ErrorCode.garminMfaRejected,
    );
    expect(
      (await agent.post("/api/garmin/login/code").send({ mfaCode: FIXTURE_LOGIN.code })).status,
    ).toBe(200);
    expectProblem(
      await agent
        .post("/api/garmin/login")
        .send({ email: FIXTURE_LOGIN.rateLimitedEmail, password }),
      429,
      ErrorCode.garminRateLimited,
    );

    const text = lines().join("");
    // The capture works: one access line per request, and the login's own lines.
    expect(text.match(/"path":"\/api\/garmin\/login(\/code)?"/g)).toHaveLength(4);
    expect(text).toContain("garmin login waits for a code");
    expect(text).toContain("garmin connected");
    for (const secret of [
      FIXTURE_LOGIN.email,
      FIXTURE_LOGIN.rateLimitedEmail,
      password,
      FIXTURE_LOGIN.code,
      FIXTURE_LOGIN.wrongCode,
      "fixture-token",
      "fixture-refresh",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("redacts an mfaCode, email and password logged by mistake, at the top and nested", () => {
    const lines = captureAppLogs();

    logger.info(
      {
        mfaCode: FIXTURE_LOGIN.code,
        body: { email: FIXTURE_LOGIN.email, password: FIXTURE_LOGIN.password },
        request: { body: { mfaCode: FIXTURE_LOGIN.wrongCode } },
      },
      "mistake",
    );

    const text = lines().join("");
    expect(text).toContain("mistake");
    for (const secret of [
      FIXTURE_LOGIN.code,
      FIXTURE_LOGIN.wrongCode,
      FIXTURE_LOGIN.email,
      FIXTURE_LOGIN.password,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
