import { ErrorCode, problemSchema, type Problem } from "@running-coach/shared";
import type { z } from "zod";
import { parseResponse } from "./parse-response";

type ApiErrorInit = {
  status: number;
  code: ErrorCode;
  detail?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  network?: boolean;
  contractMismatch?: ContractMismatch;
  cause?: unknown;
};

/**
 * Which request got a 2xx this version of the app cannot read: a read (GET), or a write the server may have
 * carried out.
 */
type ContractMismatch = "read" | "write";

/** Every failed call to the API, whatever went wrong, ends up as one of these. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** True when the request never reached the server (offline, DNS, CORS, server asleep). */
  readonly network: boolean;
  /**
   * Set when the server answered 2xx with a body this version of the app cannot read, even with the fields it
   * does not know dropped (parse-response.ts): the server runs another version, so asking again gets the same
   * answer and only loading the server's version helps (src/app/app-update.ts).
   */
  readonly contractMismatch: ContractMismatch | undefined;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.code, { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.network = init.network ?? false;
    this.contractMismatch = init.contractMismatch;
  }

  static fromProblem(problem: Problem, fallbackRequestId?: string): ApiError {
    return new ApiError({
      status: problem.status,
      code: problem.code,
      detail: problem.detail,
      requestId: problem.requestId ?? fallbackRequestId,
      retryAfterSeconds: problem.retryAfterSeconds,
    });
  }
}

/** Fallback when an error response is not problem+json (a proxy page, a crashed process). */
export function codeForStatus(status: number): ErrorCode {
  if (status === 400 || status === 422) return ErrorCode.validation;
  if (status === 401) return ErrorCode.unauthorized;
  if (status === 404) return ErrorCode.notFound;
  if (status === 429) return ErrorCode.rateLimited;
  return ErrorCode.internal;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** A 2xx this version of the app cannot read: retrying gets the same answer. */
export function isContractMismatch(error: unknown): error is ApiError {
  return isApiError(error) && error.contractMismatch !== undefined;
}

/** A 4xx means the request itself is wrong or unauthorized: retrying will not help. */
export function isClientError(error: unknown): boolean {
  return isApiError(error) && error.status >= 400 && error.status < 500;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiRequest<T> = {
  method?: Method;
  body?: unknown;
  /** The zod contract from @running-coach/shared that the response must satisfy. */
  schema: z.ZodType<T>;
  signal?: AbortSignal;
};

function newRequestId(): string {
  return crypto.randomUUID();
}

/** Retry-After in seconds; the HTTP-date form is not used by our services. */
function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

/** A body that is not JSON: a captive portal's or a proxy's page, never our API. */
const notJson = Symbol("not JSON");

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return notJson;
  }
}

/**
 * The one way the web app talks to the API: same-origin cookies, a fresh request id for log correlation,
 * problem+json mapped to ApiError, and the response validated against the caller's contract, with the fields
 * this version does not know dropped.
 */
export async function apiFetch<T>(path: string, request: ApiRequest<T>): Promise<T> {
  const requestId = newRequestId();
  const method = request.method ?? "GET";
  const headers = new Headers({ accept: "application/json", "x-request-id": requestId });
  if (request.body !== undefined) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal,
    });
  } catch (error) {
    // A cancelled query is not a failure; let TanStack Query see the abort as it is.
    if (request.signal?.aborted) throw error;
    throw new ApiError({
      status: 0,
      code: ErrorCode.internal,
      requestId,
      network: true,
      cause: error,
    });
  }

  const responseRequestId = response.headers.get("x-request-id") ?? requestId;

  if (!response.ok) {
    const problem = parseResponse(problemSchema, await readJson(response));
    if (problem.success) throw ApiError.fromProblem(problem.data, responseRequestId);
    throw new ApiError({
      status: response.status,
      code: codeForStatus(response.status),
      requestId: responseRequestId,
      retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")),
    });
  }

  const body = response.status === 204 ? undefined : await readJson(response);
  if (body === notJson) {
    // Something between here and the API answered (a captive portal's login page): no answer from the API.
    throw new ApiError({
      status: response.status,
      code: ErrorCode.internal,
      requestId: responseRequestId,
      network: true,
    });
  }
  const parsed = parseResponse(request.schema, body);
  if (!parsed.success) {
    throw new ApiError({
      status: response.status,
      code: ErrorCode.internal,
      detail: "The server response did not match the contract.",
      requestId: responseRequestId,
      contractMismatch: method === "GET" ? "read" : "write",
      cause: parsed.error,
    });
  }
  return parsed.data;
}
