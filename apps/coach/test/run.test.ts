import { request as httpRequest } from "node:http";
import {
  coachRunResponseSchema,
  problemSchema,
  runInsightSchema,
  type CoachRunResponse,
} from "@running-coach/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Coach,
  INPUT,
  postRun,
  runRequest,
  SECRET,
  startCoach,
  SYSTEM_PROMPT,
  waitFor,
} from "./helpers";

// Every run goes through the real Agent SDK query() against test/fake-claude-code.mjs.

let coach: Coach | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  await coach?.close();
  coach = undefined;
});

async function runScenario(scenario: string, options: { timeoutMs?: number } = {}) {
  coach = await startCoach(scenario, options);
  const res = await postRun(coach);
  expect(res.status).toBe(200);
  return coachRunResponseSchema.parse(await res.json());
}

function failureOf(response: CoachRunResponse) {
  if (response.ok) throw new Error("expected a failure");
  return response;
}

describe("POST /v1/run", () => {
  it("success: returns the structured output, the model, usage and Claude's request id", async () => {
    const response = await runScenario("success");

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(runInsightSchema.parse(response.output).caution).toBe("none");
    expect(response.model).toBe("claude-opus-5-5");
    // Input counts cache writes too (6 + 1890), so it compares with an API-key call.
    expect(response.usage).toEqual({ inputTokens: 1896, outputTokens: 210 });
    expect(response.claudeRequestId).toMatch(/^req_fake_/);
  });

  it("fallback model: names the model that wrote the output", async () => {
    const response = await runScenario("fallback");

    expect(response.ok && response.model).toBe("claude-sonnet-5-5");
  });

  it("sends the system prompt and the json schema in initialize and the input as the user message", async () => {
    await runScenario("success");

    const events = coach!.events();
    const initialize = events.find((event) => event.event === "initialize");
    expect(initialize?.systemPrompt).toEqual([SYSTEM_PROMPT]);
    expect(initialize?.jsonSchema).toEqual(runRequest().jsonSchema);
    expect(events.find((event) => event.event === "user")?.text).toBe(INPUT);
  });

  it("flags: no setting sources, no tools, no session persistence, no MCP, low effort, the models and a turn bound reach the CLI argv", async () => {
    await runScenario("success");

    const argv = coach!.events().find((event) => event.event === "start")?.argv ?? [];
    expect(argv).toContain("--setting-sources=");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--mcp-config");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(argv[argv.indexOf("--fallback-model") + 1]).toBe("claude-sonnet-5-5");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("4");
    expect(argv).toEqual(expect.arrayContaining(["--output-format", "stream-json"]));
  });

  it("fallback model equal to the model: runs without a fallback instead of the SDK refusing", async () => {
    coach = await startCoach("success");
    const res = await postRun(coach, runRequest({ fallbackModel: "claude-opus-5-5" }));

    expect(coachRunResponseSchema.parse(await res.json()).ok).toBe(true);
    const argv = coach.events().find((event) => event.event === "start")?.argv ?? [];
    expect(argv).not.toContain("--fallback-model");
  });

  it("env allowlist: the token and capped retries reach the CLI; ANTHROPIC_* and the shared secret never do", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-fake-key-that-must-not-leak");
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fake-auth-token");
    vi.stubEnv("COACH_SERVICE_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "postgres://fake");

    const response = await runScenario("success");

    // The fake answers only when it got the scenario's token.
    expect(response.ok).toBe(true);
    const start = coach!.events().find((event) => event.event === "start");
    const names = start?.envNames ?? [];
    expect(names).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(names.filter((name) => name.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(names).not.toContain("COACH_SERVICE_SECRET");
    expect(names).not.toContain("DATABASE_URL");
    // No keychain login with a token.
    expect(names).not.toContain("USER");
    expect(start?.env).toEqual({
      CLAUDE_CODE_MAX_RETRIES: "2",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    // Our allowlist plus the markers the SDK adds itself, nothing else.
    const allowed = new Set([
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_MAX_RETRIES",
      "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_AUTOUPDATER",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_AGENT_SDK_VERSION",
      "CLAUDE_CODE_SDK_READS_SESSION_STATE",
    ]);
    // macOS sets __CF_USER_TEXT_ENCODING in every process it starts.
    const unexpected = names.filter(
      (name) => !allowed.has(name) && name !== "__CF_USER_TEXT_ENCODING",
    );
    expect(unexpected).toEqual([]);
  });

  it("usage limit: a rejected plan rate-limit event is plan_limited with seconds until the reset", async () => {
    const response = failureOf(await runScenario("usage-limit"));

    expect(response.failure).toBe("plan_limited");
    // The fake's limit resets in 7200 s.
    expect(response.retryAfterSeconds).toBeGreaterThan(7190);
    expect(response.retryAfterSeconds).toBeLessThanOrEqual(7200);
    expect(response.usage).toBeNull();
  });

  it("auth failure: an invalid or revoked plan token is plan_auth_failed", async () => {
    const response = failureOf(await runScenario("auth-failed"));

    expect(response.failure).toBe("plan_auth_failed");
    expect(response.retryAfterSeconds).toBeUndefined();
    expect(response.usage).toBeNull();
  });

  it("structured-output retries exhausted: invalid_output with the tokens spent", async () => {
    const response = failureOf(await runScenario("structured-retries"));

    expect(response.failure).toBe("invalid_output");
    expect(response.usage).toEqual({ inputTokens: 5688, outputTokens: 630 });
  });

  it("refusal: the model and the fallback model refused", async () => {
    const response = failureOf(await runScenario("refusal"));

    expect(response.failure).toBe("refusal");
    expect(response.claudeRequestId).toMatch(/^req_fake_refusal_2_/);
  });

  it("max tokens: the output hit CLAUDE_CODE_MAX_OUTPUT_TOKENS", async () => {
    const response = failureOf(await runScenario("max-tokens"));

    expect(response.failure).toBe("max_tokens");
    expect(response.usage?.outputTokens).toBe(4000);
  });

  it("overloaded after Claude Code's own retries: unavailable", async () => {
    const response = failureOf(await runScenario("overloaded"));

    expect(response.failure).toBe("unavailable");
  });

  it("billing error: request_rejected", async () => {
    const response = failureOf(await runScenario("billing"));

    expect(response.failure).toBe("request_rejected");
  });

  it("hang: the run is aborted after COACH_RUN_TIMEOUT_MS and answers timeout; the CLI is gone", async () => {
    const response = failureOf(await runScenario("hang", { timeoutMs: 800 }));

    expect(response.failure).toBe("timeout");
    expect(coach!.events().some((event) => event.event === "exit")).toBe(true);
  });

  it("client hang-up: aborts the running CLI", async () => {
    coach = await startCoach("hang");
    const { url } = coach;
    const req = httpRequest(`${url}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-coach-secret": SECRET },
    });
    req.on("error", () => undefined);
    req.end(JSON.stringify(runRequest()));

    await waitFor(() => coach!.events().find((event) => event.event === "user"), 10_000, "prompt");
    req.destroy();

    const exit = await waitFor(
      () => coach!.events().find((event) => event.event === "exit"),
      8_000,
      "CLI exit",
    );
    expect(exit.signal).toBe("SIGTERM");
    await waitFor(() => coach!.logs.find((line) => line.outcome === "hangup"), 5_000, "log");
  });

  it("client hang-up while queued: the waiting run never starts", async () => {
    coach = await startCoach("slow");
    const first = postRun(coach);
    const abandoned = new AbortController();
    const second = fetch(`${coach.url}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-coach-secret": SECRET },
      body: JSON.stringify(runRequest()),
      signal: abandoned.signal,
    }).catch(() => "aborted");
    await waitFor(() => coach!.events().find((event) => event.event === "user"), 10_000, "first");
    abandoned.abort();

    expect((await first).status).toBe(200);
    expect(await second).toBe("aborted");
    await waitFor(
      () => coach!.logs.find((line) => line.msg === "coach run skipped"),
      5_000,
      "skip",
    );
    expect(coach.events().filter((event) => event.event === "start")).toHaveLength(1);
  });

  it("two concurrent runs execute one at a time", async () => {
    coach = await startCoach("slow");

    const responses = await Promise.all([postRun(coach), postRun(coach)]);

    for (const res of responses) {
      expect(coachRunResponseSchema.parse(await res.json()).ok).toBe(true);
    }
    const events = coach.events();
    const starts = events.filter((event) => event.event === "start");
    const exits = events.filter((event) => event.event === "exit");
    expect(starts).toHaveLength(2);
    const [first, second] = starts as [(typeof starts)[0], (typeof starts)[0]];
    const firstExit = exits.find((event) => event.pid === first.pid);
    expect(firstExit).toBeDefined();
    expect(second.at).toBeGreaterThanOrEqual(firstExit!.at);
  });

  it("wrong secret: 401 problem and no CLI spawned", async () => {
    coach = await startCoach("success");

    const res = await postRun(coach, runRequest(), { "x-coach-secret": `${SECRET}x` });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const problem = problemSchema.parse(await res.json());
    expect(problem.code).toBe("unauthorized");
    expect(problem.requestId).toBe("req-test-1");
    expect(coach.events()).toEqual([]);
  });

  it("missing secret: 401 problem and no CLI spawned", async () => {
    coach = await startCoach("success");

    const res = await postRun(coach, runRequest(), {});

    expect(res.status).toBe(401);
    expect(problemSchema.parse(await res.json()).code).toBe("unauthorized");
    expect(coach.events()).toEqual([]);
  });

  it("invalid body: 400 validation with issues for a missing field or an unknown key, no CLI", async () => {
    coach = await startCoach("success");
    const { model: _model, ...withoutModel } = runRequest();

    const missing = await postRun(coach, withoutModel);
    const extra = await postRun(coach, { ...runRequest(), userId: "someone" });

    for (const res of [missing, extra]) {
      expect(res.status).toBe(400);
      const problem = problemSchema.parse(await res.json());
      expect(problem.code).toBe("validation");
      expect(problem.issues?.length).toBeGreaterThan(0);
    }
    expect(coach.events()).toEqual([]);
  });

  it("invalid JSON: 400 validation", async () => {
    coach = await startCoach("success");

    const res = await postRun(coach, "{not json");

    expect(res.status).toBe(400);
    expect(problemSchema.parse(await res.json()).code).toBe("validation");
  });

  it("body over 256 KB: 413 validation, no CLI", async () => {
    coach = await startCoach("success");

    const res = await postRun(coach, { ...runRequest(), input: "x".repeat(300 * 1024) });

    expect(res.status).toBe(413);
    expect(problemSchema.parse(await res.json()).code).toBe("validation");
    expect(coach.events()).toEqual([]);
  });

  it("unknown route or method: 404 problem", async () => {
    coach = await startCoach("success");

    const unknown = await fetch(`${coach.url}/v1/other`, { headers: { "x-coach-secret": SECRET } });
    const getRun = await fetch(`${coach.url}/v1/run`, { headers: { "x-coach-secret": SECRET } });

    expect(unknown.status).toBe(404);
    expect(getRun.status).toBe(404);
    expect(problemSchema.parse(await unknown.json()).code).toBe("not_found");
  });

  it("logs: one line per run with the request id, outcome, usage and turns, never the token, prompt, input or output", async () => {
    await runScenario("success");

    const run = coach!.logs.find((line) => line.msg === "coach run finished");
    expect(run).toMatchObject({
      requestId: "req-test-1",
      outcome: "ok",
      model: "claude-opus-5-5",
      usage: { inputTokens: 1896, outputTokens: 210 },
      numTurns: 2,
      rateLimit: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: { five_hour: 0.16, seven_day: 0.61 },
      },
    });
    expect(typeof run?.durationMs).toBe("number");
    const text = JSON.stringify(coach!.logs);
    expect(text).not.toContain(coach!.token);
    expect(text).not.toContain(SYSTEM_PROMPT);
    expect(text).not.toContain(INPUT);
    expect(text).not.toContain("Easy 8.0 km");
  });
});

describe("GET /health", () => {
  it("health needs no secret", async () => {
    coach = await startCoach("success");

    const res = await fetch(`${coach.url}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(coach.events()).toEqual([]);
  });
});
