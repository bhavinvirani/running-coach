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

/** A 4xx or 5xx answer; problem is its problem+json body when it sent one that parses. */
export interface FailedResponse<P extends Problem = Problem> {
  status: number;
  headers: Headers;
  problem: P | undefined;
}

export interface FetchJsonOptions<T extends z.ZodType, P extends Problem = Problem> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** Serialized as JSON. A function is called before every attempt, so a retry can send a changed body. */
  body?: unknown;
  /** Parses a 2xx body. */
  schema: T;
  /** Parses a 4xx or 5xx body; the shared problemSchema by default. */
  problemSchema?: z.ZodType<P>;
  /**
   * Awaited for every 4xx or 5xx answer, retried ones included, before the next attempt or the return. A
   * rejection ends the call with that error.
   */
  onErrorResponse?: (failed: FailedResponse<P>) => void | Promise<void>;
  timeoutMs: number;
  /** Extra attempts after the first, only for what `retryOn` names. */
  retries?: number;
  /**
   * "network_and_5xx" (default): no answer at all, or a 5xx. "network": no answer at all (refused, or the
   * connection dropped before a response), for an upstream that already retried behind its own answers.
   */
  retryOn?: "network" | "network_and_5xx";
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export type FetchJsonResult<T, P extends Problem = Problem> =
  | { ok: true; status: number; headers: Headers; data: T }
  /** The upstream answered with 4xx or 5xx (after any retries). */
  | ({ ok: false } & FailedResponse<P>);

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

async function readProblem<P extends Problem>(
  response: globalThis.Response,
  schema: z.ZodType<P>,
): Promise<P | undefined> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * JSON over fetch with a timeout per attempt and the retry policy from the api rule: retries with exponential
 * backoff and full jitter on network errors and, unless `retryOn` is "network", 5xx. 4xx (429 included)
 * returns at once. A timeout is not retried, because the callers' timeouts are already long and they hold a
 * per-user lock meanwhile. Forwards x-request-id from the current request or job.
 */
export async function fetchJson<T extends z.ZodType, P extends Problem = Problem>(
  url: string,
  options: FetchJsonOptions<T, P>,
): Promise<FetchJsonResult<z.output<T>, P>> {
  const {
    retries = 2,
    retryOn = "network_and_5xx",
    baseDelayMs = 250,
    maxDelayMs = 4000,
  } = options;
  // Without a schema of its own, P is Problem.
  const errorSchema = options.problemSchema ?? (problemSchema as unknown as z.ZodType<P>);
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  const requestId = currentRequestId();
  if (requestId) headers["x-request-id"] = requestId;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const serializeBody = (): string | undefined => {
    const value: unknown =
      typeof options.body === "function" ? (options.body as () => unknown)() : options.body;
    return value === undefined ? undefined : JSON.stringify(value);
  };

  for (let attempt = 0; ; attempt += 1) {
    const canRetry = attempt < retries;
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body: serializeBody(),
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

    if (!response.ok) {
      const failed: FailedResponse<P> = {
        status: response.status,
        headers: response.headers,
        problem: await readProblem(response, errorSchema),
      };
      await options.onErrorResponse?.(failed);
      if (response.status >= 500 && retryOn === "network_and_5xx" && canRetry) {
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      return { ok: false, ...failed };
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
