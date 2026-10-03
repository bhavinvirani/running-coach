import { setTimeout as sleep } from "node:timers/promises";
import {
  type CoachRunRequest,
  type CoachRunResponse,
  coachRunResponseSchema,
} from "@running-coach/shared";
import { z } from "zod";
import { type CoachService, coachServiceOf, config } from "../lib/config";
import { currentRequestId, logger } from "../lib/logger";
import type { CoachCardFailure, CoachResult, CoachUsage } from "./client";

// The plan path of callCoach: one prompt on the owner's Claude plan through the coach service
// (apps/coach), which runs Claude Code with the plan's token in its own environment. This process
// holds only the service's URL and shared secret, and never sends the service a key or a token. Render's
// free service sleeps when idle, so every call first polls /health until it answers. No retry here:
// Claude Code retries a few times and switches to the fallback model itself, and the job retries later.
// Logs the prompt version, model, timings, Claude's request id and usage; never the input, the output
// or the secret.

const log = logger.child({ module: "coach" });

/** Seconds a run held by the plan's usage limit waits when the service names no reset time. */
export const PLAN_LIMIT_DEFAULT_RETRY_S = 60 * 60;

/** The coach service's GET /health once it is up. */
const healthSchema = z.object({ status: z.literal("ok") });

export interface PlanCall<T extends z.ZodType> {
  /** The system prompt, from the prompt's versioned file. */
  system: string;
  /** "run-insight/v1", for the log. */
  promptVersion: string;
  input: string;
  schema: T;
  maxTokens: number;
}

function requestIdHeader(requestId: string | undefined): Record<string, string> {
  return requestId ? { "x-request-id": requestId } : {};
}

function isTimeout(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

/** The system error code behind a failed fetch (ECONNREFUSED, ECONNRESET), for the log. */
function networkCode(error: unknown): string | null {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Polls GET /health until it answers 200 {status:"ok"}, true then; false when the budget runs out first.
 * A waking Render service either holds the request until it is up or answers 502/503 meanwhile, so each
 * poll may take what is left of the budget, and a refused, failed or held-then-dropped poll waits
 * pollMs before the next.
 */
async function wake(
  service: CoachService,
  budgetMs: number,
  pollMs: number,
  requestId: string | undefined,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    try {
      const response = await fetch(`${service.url}/health`, {
        headers: requestIdHeader(requestId),
        signal: AbortSignal.timeout(remaining),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && healthSchema.safeParse(body).success) return true;
    } catch {
      // Refused or reset while the instance starts, or the budget ran out during a held poll.
    }
    const wait = Math.min(pollMs, deadline - Date.now());
    if (wait <= 0) return false;
    await sleep(wait);
  }
}

/** What the service answered, or why there is no answer to use. */
type Answer =
  | { kind: "answer"; response: CoachRunResponse }
  | { kind: "failed"; failure: "timeout" | "unavailable" };

async function post(
  service: CoachService,
  body: CoachRunRequest,
  requestId: string | undefined,
  context: { promptVersion: string; wakeMs: number },
): Promise<Answer> {
  const started = Date.now();
  const durationMs = () => Date.now() - started;
  let response: Response;
  let json: unknown;
  try {
    response = await fetch(`${service.url}/v1/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-coach-secret": service.secret,
        ...requestIdHeader(requestId),
      },
      body: JSON.stringify(body),
      // Covers the answer's body too: the signal aborts a body that stalls after the headers.
      signal: AbortSignal.timeout(config.COACH_SERVICE_TIMEOUT_MS),
    });
    json = await response.json().catch(() => null);
  } catch (error) {
    if (isTimeout(error)) {
      log.warn({ ...context, durationMs: durationMs() }, "coach service took too long to answer");
      return { kind: "failed", failure: "timeout" };
    }
    log.warn(
      { ...context, durationMs: durationMs(), networkCode: networkCode(error) },
      "coach service did not answer",
    );
    return { kind: "failed", failure: "unavailable" };
  }

  const status = response.status;
  if (status === 401) {
    // Retrying cannot fix it, but the job's retries end on the fallback card, which says Claude is down;
    // this line is where the owner learns why.
    log.error(
      { ...context, status, durationMs: durationMs() },
      "coach service rejected x-coach-secret; COACH_SERVICE_SECRET differs from the coach service's",
    );
    return { kind: "failed", failure: "unavailable" };
  }
  if (!response.ok) {
    const fields = { ...context, status, durationMs: durationMs() };
    if (status >= 500) log.warn(fields, "coach service failed");
    else log.error(fields, "coach service refused the request; the API and the service disagree");
    return { kind: "failed", failure: "unavailable" };
  }
  const parsed = coachRunResponseSchema.safeParse(json);
  if (!parsed.success) {
    log.error(
      {
        ...context,
        status,
        durationMs: durationMs(),
        issues: parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"),
      },
      "coach service answered outside its contract",
    );
    return { kind: "failed", failure: "unavailable" };
  }
  return { kind: "answer", response: parsed.data };
}

/**
 * Runs one prompt on the owner's Claude plan: wakes the coach service (COACH_SERVICE_WAKE_MS), then
 * POST /v1/run with the shared secret and the request id, within COACH_SERVICE_TIMEOUT_MS. The service's
 * failures map one to one; a service that never wakes, fails, refuses our secret or cannot be reached is
 * unavailable, and no answer in time is a timeout, both worth the job's retry. The output is parsed with
 * the prompt's schema here, as on the key path.
 */
export async function callCoachOnPlan<T extends z.ZodType>(
  call: PlanCall<T>,
): Promise<CoachResult<z.output<T>>> {
  const { promptVersion } = call;
  const unavailable = (): CoachResult<z.output<T>> => ({
    ok: false,
    failure: "unavailable",
    usage: null,
    requestId: null,
  });
  const service = coachServiceOf(config);
  if (!service) {
    log.error(
      { promptVersion },
      "coach service is not set up; set COACH_SERVICE_URL and its secret",
    );
    return unavailable();
  }
  const requestId = currentRequestId();

  const wakeStarted = Date.now();
  const awake = await wake(
    service,
    config.COACH_SERVICE_WAKE_MS,
    config.COACH_SERVICE_WAKE_POLL_MS,
    requestId,
  );
  const wakeMs = Date.now() - wakeStarted;
  if (!awake) {
    log.warn({ promptVersion, wakeMs }, "coach service did not wake");
    return unavailable();
  }

  const started = Date.now();
  const answer = await post(
    service,
    {
      system: call.system,
      input: call.input,
      // Claude Code's structured output takes draft-07.
      jsonSchema: z.toJSONSchema(call.schema, { target: "draft-07" }),
      model: config.COACH_MODEL,
      fallbackModel: config.COACH_FALLBACK_MODEL,
      maxTokens: call.maxTokens,
    },
    requestId,
    { promptVersion, wakeMs },
  );
  if (answer.kind === "failed") {
    return { ok: false, failure: answer.failure, usage: null, requestId: null };
  }

  const { response } = answer;
  const usage: CoachUsage | null = response.usage;
  const context = {
    promptVersion,
    model: response.ok ? response.model : null,
    durationMs: Date.now() - started,
    wakeMs,
    claudeRequestId: response.claudeRequestId,
    usage,
  };
  if (!response.ok) {
    if (response.failure === "plan_limited") {
      const retryAfterSeconds = response.retryAfterSeconds ?? PLAN_LIMIT_DEFAULT_RETRY_S;
      log.warn({ ...context, retryAfterSeconds }, "coach plan usage limit reached");
      return {
        ok: false,
        failure: "plan_limited",
        retryAfterSeconds,
        usage,
        requestId: response.claudeRequestId,
      };
    }
    const failure: CoachCardFailure = response.failure;
    if (failure === "plan_auth_failed") {
      log.error(context, "Claude rejected the plan token; run claude setup-token and replace it");
    } else {
      log.warn({ ...context, failure }, "coach plan call failed");
    }
    return { ok: false, failure, usage, requestId: response.claudeRequestId };
  }

  const parsed = call.schema.safeParse(response.output);
  if (!parsed.success) {
    log.warn(
      {
        ...context,
        issues: parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"),
      },
      "coach output failed its schema",
    );
    return { ok: false, failure: "invalid_output", usage, requestId: response.claudeRequestId };
  }
  log.info(context, "coach answered");
  return {
    ok: true,
    output: parsed.data,
    model: response.model,
    usage: response.usage,
    requestId: response.claudeRequestId,
  };
}
