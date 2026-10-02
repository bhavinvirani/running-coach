import { setTimeout as sleep } from "node:timers/promises";
import { type Problem, problemSchema } from "@running-coach/shared";
import type { Response } from "express";
import type { z } from "zod";
import { currentRequestId } from "./logger";

/** Parses an input at the edge; a ZodError becomes a 400 validation problem in errorHandler. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  return schema.parse(value);
}

/** Sends data after parsing it with the response schema, so a route never leaks a field the contract lacks. */
export function respond<T extends z.ZodType>(
  res: Response,
  schema: T,
  data: z.input<T>,
  status = 200,
): void {
  const result = schema.safeParse(data);
  if (!result.success) {
    // A response that breaks its own contract is our bug: a 500, never a 400.
    throw new Error("Response does not match its schema", { cause: result.error });
  }
  res.status(status).json(result.data);
}

// ---- Outgoing calls -------------------------------------------------------------------------

export interface FetchJsonOptions<T extends z.ZodType> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** Serialized as JSON. */
  body?: unknown;
  /** Parses a 2xx body. */
  schema: T;
  timeoutMs: number;
  /** Extra attempts after the first, only for network errors and 5xx. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export type FetchJsonResult<T> =
  | { ok: true; status: number; headers: Headers; data: T }
  /** The upstream answered with 4xx or 5xx; problem is its problem+json body when it sent one. */
  | { ok: false; status: number; headers: Headers; problem: Problem | undefined };

export type FetchFailureKind = "network" | "timeout" | "invalid_response";

/** The call produced no usable answer: unreachable, too slow, or a 2xx body outside its schema. */
export class FetchFailure extends Error {
  readonly kind: FetchFailureKind;
  readonly url: string;

  constructor(kind: FetchFailureKind, url: string, cause?: unknown) {
    super(`${kind} calling ${url}`, cause === undefined ? undefined : { cause });
    this.name = "FetchFailure";
    this.kind = kind;
    this.url = url;
  }
}

/** Full jitter: a random delay in [0, min(max, base * 2^attempt)). */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

async function readProblem(response: globalThis.Response): Promise<Problem | undefined> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = problemSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * JSON over fetch with a timeout per attempt and the retry policy from the api rule: retries with exponential
 * backoff and full jitter on network errors and 5xx only. 4xx (429 included) returns at once. A timeout is
 * not retried, because the callers' timeouts are already long and they hold a per-user lock meanwhile.
 * Forwards x-request-id from the current request or job.
 */
export async function fetchJson<T extends z.ZodType>(
  url: string,
  options: FetchJsonOptions<T>,
): Promise<FetchJsonResult<z.output<T>>> {
  const { retries = 2, baseDelayMs = 250, maxDelayMs = 4000 } = options;
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  const requestId = currentRequestId();
  if (requestId) headers["x-request-id"] = requestId;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  for (let attempt = 0; ; attempt += 1) {
    const canRetry = attempt < retries;
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) throw new FetchFailure("timeout", url, error);
      if (canRetry) {
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      throw new FetchFailure("network", url, error);
    }

    if (response.status >= 500 && canRetry) {
      await response.body?.cancel().catch(() => undefined);
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
      continue;
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        headers: response.headers,
        problem: await readProblem(response),
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new FetchFailure(isTimeout(error) ? "timeout" : "invalid_response", url, error);
    }
    const parsed = options.schema.safeParse(json);
    if (!parsed.success) throw new FetchFailure("invalid_response", url, parsed.error);
    return { ok: true, status: response.status, headers: response.headers, data: parsed.data };
  }
}
