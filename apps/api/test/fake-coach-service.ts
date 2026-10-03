import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { type CoachRunFailure, coachRunRequestSchema } from "@running-coach/shared";
import { type Config, config } from "../src/lib/config";

// A local stand-in for the coach service (services/coach) that runs the owner's coach on their Claude
// plan: GET /health, and POST /v1/run behind x-coach-secret, answering as its contract in packages/shared
// says. A test file starts its own; `use` picks how it wakes and what a run answers, and every request
// is recorded. `configureCoachService` points the API's config at it as the owner's coach service.

/** A fake secret, long enough for COACH_SERVICE_SECRET's 32 characters. */
export const FAKE_COACH_SECRET = "test-only-coach-service-secret-0123456789";

/** The owner in these tests: createUser's and signedInAgent's default email. */
export const PLAN_OWNER_EMAIL = "runner@example.com";

/** The card the fake Claude's "valid" fixture answers, so plan and key cards compare alike. */
export const VALID_OUTPUT = (
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures/claude/valid.json"), "utf8"),
  ) as { responses: [{ body: { content: [{ json: unknown }] } }] }
).responses[0].body.content[0].json;

/** Tokens of a plan run, unlike the key fixtures' 1180 / 164 so a test sees which path answered. */
export const PLAN_USAGE = { inputTokens: 2310, outputTokens: 188 } as const;

export type WakeScenario =
  /** /health answers 200 at once. */
  | { kind: "awake" }
  /** /health answers `status` (a booting Render instance) this many times, then 200. */
  | { kind: "booting"; failures: number; status?: 502 | 503 }
  /** The first /health is held this long (Render holds requests while it wakes), then 200. */
  | { kind: "held"; holdMs: number }
  /** /health always answers 503. */
  | { kind: "never" };

export type RunScenario =
  /** The card, written by the request's model, or its fallback model when Claude Code switched. */
  | { kind: "valid"; by?: "model" | "fallbackModel" }
  /** A card missing its fields: the API's schema parse must catch it. */
  | { kind: "schema-invalid" }
  /** The service's failure answer; usage when a model answered, unusably. */
  | { kind: "failure"; failure: CoachRunFailure; retryAfterSeconds?: number; billed?: boolean }
  /** The valid card after this delay. */
  | { kind: "slow"; delayMs: number }
  /** The service's own problem+json error. */
  | { kind: "error"; status: 400 | 500 }
  /** 200 with a body outside the response contract. */
  | { kind: "garbage" }
  /** The connection drops without an answer. */
  | { kind: "drop" };

export interface RecordedRun {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface FakeCoachService {
  url: string;
  secret: string;
  /** Sets how the service wakes and answers from the next request on; unset parts keep their value. */
  use(scenario: { wake?: WakeScenario; run?: RunScenario }): void;
  /** Every POST /v1/run, oldest first. */
  readonly runs: RecordedRun[];
  /** Every GET /health's headers, oldest first. */
  readonly healthChecks: IncomingHttpHeaders[];
  /** Back to awake and valid, with nothing recorded. */
  reset(): void;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, problem = false): void {
  if (res.destroyed) return;
  res.writeHead(status, {
    "content-type": problem ? "application/problem+json" : "application/json",
  });
  res.end(JSON.stringify(body));
}

function problem(res: ServerResponse, status: number, code: string): void {
  send(res, status, { type: "about:blank", title: "Error", status, code }, true);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function answer(scenario: RunScenario, body: Record<string, unknown>, call: number): unknown {
  const claudeRequestId = `req_plan_${call}`;
  switch (scenario.kind) {
    case "valid":
    case "slow":
      return {
        ok: true,
        output: VALID_OUTPUT,
        model:
          scenario.kind === "valid" && scenario.by === "fallbackModel"
            ? body.fallbackModel
            : body.model,
        usage: PLAN_USAGE,
        claudeRequestId,
      };
    case "schema-invalid":
      return {
        ok: true,
        output: { headline: "Nice run!" },
        model: body.model,
        usage: PLAN_USAGE,
        claudeRequestId,
      };
    case "failure":
      return {
        ok: false,
        failure: scenario.failure,
        ...(scenario.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: scenario.retryAfterSeconds }),
        usage: scenario.billed ? PLAN_USAGE : null,
        claudeRequestId,
      };
    case "garbage":
      return { ok: "maybe", text: "Here is your coach review." };
    default:
      throw new Error(`no answer body for ${scenario.kind}`);
  }
}

export async function startFakeCoachService(): Promise<FakeCoachService> {
  let wake: WakeScenario = { kind: "awake" };
  let run: RunScenario = { kind: "valid" };
  let healthFailuresLeft = 0;
  let held = false;
  const runs: RecordedRun[] = [];
  const healthChecks: IncomingHttpHeaders[] = [];

  const server = createServer((req, res) => {
    res.on("error", () => undefined);
    void (async () => {
      if (req.method === "GET" && req.url === "/health") {
        healthChecks.push(req.headers);
        if (wake.kind === "never") return send(res, 503, { status: "starting" });
        if (wake.kind === "booting" && healthFailuresLeft > 0) {
          healthFailuresLeft -= 1;
          return send(res, wake.status ?? 503, { status: "starting" });
        }
        if (wake.kind === "held" && !held) {
          held = true;
          await sleep(wake.holdMs);
        }
        return send(res, 200, { status: "ok" });
      }
      if (req.method !== "POST" || req.url !== "/v1/run") return problem(res, 404, "not_found");

      const body = (await readBody(req)) as Record<string, unknown> | undefined;
      if (req.headers["x-coach-secret"] !== FAKE_COACH_SECRET) {
        return problem(res, 401, "unauthorized");
      }
      runs.push({ headers: req.headers, body: body ?? {} });
      const call = runs.length;
      if (!coachRunRequestSchema.safeParse(body).success) return problem(res, 400, "validation");
      const scenario = run;
      if (scenario.kind === "drop") {
        req.socket.destroy();
        return;
      }
      if (scenario.kind === "error") return problem(res, scenario.status, "internal");
      if (scenario.kind === "slow") await sleep(scenario.delayMs);
      return send(res, 200, answer(scenario, body ?? {}, call));
    })().catch(() => problem(res, 500, "internal"));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const service: FakeCoachService = {
    url: `http://127.0.0.1:${address.port}`,
    secret: FAKE_COACH_SECRET,
    use(scenario) {
      if (scenario.wake) {
        wake = scenario.wake;
        healthFailuresLeft = wake.kind === "booting" ? wake.failures : 0;
        held = false;
      }
      if (scenario.run) run = scenario.run;
    },
    runs,
    healthChecks,
    reset() {
      service.use({ wake: { kind: "awake" }, run: { kind: "valid" } });
      runs.length = 0;
      healthChecks.length = 0;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return service;
}

type CoachServiceConfig = Pick<
  Config,
  | "COACH_SERVICE_URL"
  | "COACH_SERVICE_SECRET"
  | "COACH_SERVICE_WAKE_MS"
  | "COACH_SERVICE_WAKE_POLL_MS"
  | "COACH_SERVICE_TIMEOUT_MS"
  | "OWNER_EMAIL"
>;

/**
 * Points the API's config at a coach service (the fake by default) as the owner's, with waits short
 * enough for a test: wake within 2 s polling every 50 ms, an answer within 1.5 s. Returns the function
 * that puts the previous values back.
 */
export function configureCoachService(
  service: Pick<FakeCoachService, "url" | "secret">,
  overrides: Partial<CoachServiceConfig> = {},
): () => void {
  const saved: CoachServiceConfig = {
    COACH_SERVICE_URL: config.COACH_SERVICE_URL,
    COACH_SERVICE_SECRET: config.COACH_SERVICE_SECRET,
    COACH_SERVICE_WAKE_MS: config.COACH_SERVICE_WAKE_MS,
    COACH_SERVICE_WAKE_POLL_MS: config.COACH_SERVICE_WAKE_POLL_MS,
    COACH_SERVICE_TIMEOUT_MS: config.COACH_SERVICE_TIMEOUT_MS,
    OWNER_EMAIL: config.OWNER_EMAIL,
  };
  Object.assign(config, {
    COACH_SERVICE_URL: service.url,
    COACH_SERVICE_SECRET: service.secret,
    COACH_SERVICE_WAKE_MS: 2000,
    COACH_SERVICE_WAKE_POLL_MS: 50,
    COACH_SERVICE_TIMEOUT_MS: 1500,
    OWNER_EMAIL: PLAN_OWNER_EMAIL,
    ...overrides,
  } satisfies CoachServiceConfig);
  return () => Object.assign(config, saved);
}
