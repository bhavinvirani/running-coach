import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { type CoachRunRequest, runInsightOutputSchema } from "@running-coach/shared";
import { z } from "zod";
import { type Config, parseConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { createRunner } from "../src/run";
import { createCoachServer } from "../src/server";

// Starts the coach service in process on a free port with the fake Claude Code; the token picks the
// fake's scenario. Every value here is fake.

export const FAKE_CLAUDE_CODE = path.join(import.meta.dirname, "fake-claude-code.mjs");
export const SECRET = "test-only-coach-service-secret-not-a-real-secret";

/** An output the fake answers with when its keys are the request's JSON Schema properties. */
export function outputFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"),
  );
}

export function testConfig(env: Record<string, string> = {}): Config {
  const result = parseConfig({
    NODE_ENV: "test",
    COACH_SERVICE_SECRET: SECRET,
    CLAUDE_CODE_EXECUTABLE: FAKE_CLAUDE_CODE,
    COACH_RUN_TIMEOUT_MS: "10000",
    ...env,
  });
  if (!result.ok) throw new Error(`invalid test config: ${JSON.stringify(result.problems)}`);
  return result.config;
}

/** One line of the fake's record (see test/fake-claude-code.mjs). */
export interface FakeEvent {
  pid: number;
  at: number;
  event: "start" | "initialize" | "user" | "played" | "sigterm" | "exit";
  /** On start: pids of the token's earlier processes still running, so an overlap shows. */
  alive?: number[];
  argv?: string[];
  envNames?: string[];
  env?: Record<string, string>;
  systemPrompt?: unknown;
  jsonSchema?: unknown;
  text?: string;
  code?: number;
  signal?: string;
  ignored?: boolean;
  /** On exit: the line the fake wrote to stderr when no output fixture, or several, matched the schema. */
  reason?: string;
}

export interface Coach {
  url: string;
  token: string;
  /** The service's log lines, parsed. */
  logs: Record<string, unknown>[];
  /** Everything the fake recorded for this service's token, in order. */
  events(): FakeEvent[];
  close(): Promise<void>;
}

export async function startCoach(
  scenario: string,
  options: { timeoutMs?: number } = {},
): Promise<Coach> {
  const nonce = randomUUID();
  const token = `test-${scenario}.${nonce}`;
  const logs: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line) logs.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  const config = testConfig({
    CLAUDE_CODE_OAUTH_TOKEN: token,
    ...(options.timeoutMs === undefined ? {} : { COACH_RUN_TIMEOUT_MS: String(options.timeoutMs) }),
  });
  const logger = createLogger("debug", destination);
  const runner = createRunner({ config, logger });
  const server = createCoachServer({ config, logger, runner });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const recordFile = path.join(tmpdir(), `fake-claude-code-${nonce}.jsonl`);
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    logs,
    events() {
      if (!existsSync(recordFile)) return [];
      return readFileSync(recordFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as FakeEvent);
    },
    async close() {
      await runner.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(recordFile, { force: true });
    },
  };
}

export const SYSTEM_PROMPT = "You are a running coach. Fake test prompt.";
export const INPUT = "Run: 8.0 km in 44:00, average heart rate 146 bpm. Fake test data.";

export function runRequest(overrides: Partial<CoachRunRequest> = {}): CoachRunRequest {
  return {
    system: SYSTEM_PROMPT,
    input: INPUT,
    jsonSchema: z.toJSONSchema(runInsightOutputSchema, { target: "draft-7" }),
    model: "claude-opus-5-5",
    fallbackModel: "claude-sonnet-5-5",
    maxTokens: 4000,
    ...overrides,
  };
}

export function postRun(
  coach: Coach,
  body: unknown = runRequest(),
  headers: Record<string, string> = { "x-coach-secret": SECRET },
): Promise<Response> {
  return fetch(`${coach.url}/v1/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-test-1", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Polls until check returns a value, or throws after timeoutMs. */
export async function waitFor<T>(
  check: () => T | undefined,
  timeoutMs = 10_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
