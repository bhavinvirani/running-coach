import {
  ErrorCode,
  type GarminProfileRequest,
  garminProfileRequestSchema,
  type GarminProfileResponse,
  garminProfileResponseSchema,
  type GarminSyncRequest,
  garminSyncRequestSchema,
  type GarminSyncResponse,
  garminSyncResponseSchema,
} from "@running-coach/shared";
import type { z } from "zod";
import { config } from "../lib/config";
import { DomainError } from "../lib/errors";
import { FetchFailure, type FetchJsonResult, fetchJson } from "../lib/http";

// The only caller of the Garmin service (api rule). Timeouts and retries come from lib/http: two retries
// with jittered backoff on network errors and 5xx, never on 4xx, so a 429 comes back at once as
// garmin_rate_limited and only a job reschedules itself. Callers run inside withUserLock and write back a
// changed bundle. 409 rather than 401 for an expired Garmin login: the web app reads 401 as "signed out".

const SYNC_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Garmin blocks last about an hour; the service sends 3600 when Garmin gives no delay. */
export const DEFAULT_RETRY_AFTER_S = 3600;

export interface GarminClientOptions {
  baseUrl: string;
  secret: string;
}

export interface GarminClient {
  /** The cheapest call that proves a bundle still works. */
  profile(request: GarminProfileRequest): Promise<GarminProfileResponse>;
  /** Runs whose local start date is in [startDate, endDate]. */
  sync(request: GarminSyncRequest): Promise<GarminSyncResponse>;
}

function retryAfterSeconds(result: Extract<FetchJsonResult<unknown>, { ok: false }>): number {
  if (result.problem?.retryAfterSeconds !== undefined) return result.problem.retryAfterSeconds;
  const header = Number(result.headers.get("retry-after"));
  return Number.isInteger(header) && header > 0 ? header : DEFAULT_RETRY_AFTER_S;
}

function toError(path: string, result: Extract<FetchJsonResult<unknown>, { ok: false }>): Error {
  const code = result.problem?.code;
  if (code === ErrorCode.garminAuthExpired) {
    return new DomainError(
      ErrorCode.garminAuthExpired,
      409,
      "Garmin rejected the saved login. Connect Garmin again.",
    );
  }
  if (code === ErrorCode.garminRateLimited || result.status === 429) {
    return new DomainError(
      ErrorCode.garminRateLimited,
      429,
      "Garmin is limiting requests. Try again later.",
      { retryAfterSeconds: retryAfterSeconds(result) },
    );
  }
  if (code === ErrorCode.garminUnavailable || result.status >= 500) {
    return new DomainError(
      ErrorCode.garminUnavailable,
      502,
      "Garmin is not answering. Try again later.",
    );
  }
  if (result.status === 401) {
    // Our own misconfiguration, not the runner's: a 500 with the details in the log.
    return new Error(`The Garmin service rejected the shared secret on ${path}`);
  }
  return new Error(
    `The Garmin service answered ${result.status} (${code ?? "no problem body"}) on ${path}`,
  );
}

export function createGarminClient(options: GarminClientOptions): GarminClient {
  /** Parses the request with its contract (our bug if it fails), posts it, parses the answer. */
  async function post<Req extends z.ZodType, Res extends z.ZodType>(
    path: string,
    requestSchema: Req,
    request: z.input<Req>,
    responseSchema: Res,
    timeoutMs: number,
  ): Promise<z.output<Res>> {
    const body = requestSchema.parse(request);
    let result: FetchJsonResult<z.output<Res>>;
    try {
      result = await fetchJson(`${options.baseUrl}${path}`, {
        method: "POST",
        headers: { "x-garmin-secret": options.secret },
        body,
        schema: responseSchema,
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof FetchFailure) {
        throw new DomainError(
          ErrorCode.garminUnavailable,
          502,
          "The Garmin connection did not answer. Try again later.",
          { cause: error },
        );
      }
      throw error;
    }
    if (result.ok) return result.data;
    throw toError(path, result);
  }

  return {
    profile: (request) =>
      post(
        "/profile",
        garminProfileRequestSchema,
        request,
        garminProfileResponseSchema,
        DEFAULT_TIMEOUT_MS,
      ),
    sync: (request) =>
      post("/sync", garminSyncRequestSchema, request, garminSyncResponseSchema, SYNC_TIMEOUT_MS),
  };
}

/** The client for the service this process spawned (src/garmin/process.ts). */
export const garminClient: GarminClient = createGarminClient({
  baseUrl: `http://127.0.0.1:${config.GARMIN_SERVICE_PORT}`,
  secret: config.GARMIN_SERVICE_SECRET,
});
