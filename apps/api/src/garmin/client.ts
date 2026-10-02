import {
  ErrorCode,
  type GarminActivityDetailRequest,
  garminActivityDetailRequestSchema,
  type GarminActivityDetailResponse,
  garminActivityDetailResponseSchema,
  garminActivitySummarySchema,
  type GarminHistoryRequest,
  garminHistoryRequestSchema,
  type GarminHistoryResponse,
  garminHistoryResponseSchema,
  type GarminProblem,
  garminProblemSchema,
  type GarminProfileRequest,
  garminProfileRequestSchema,
  type GarminProfileResponse,
  garminProfileResponseSchema,
  type GarminSyncRequest,
  garminSyncRequestSchema,
  type GarminSyncResponse,
  garminSyncResponseSchema,
  garminTokenBundleSchema,
} from "@running-coach/shared";
import { z } from "zod";
import { config } from "../lib/config";
import { DomainError } from "../lib/errors";
import { type FailedResponse, FetchFailure, type FetchJsonResult, fetchJson } from "../lib/http";

// The only caller of the Garmin service (api rule). Timeouts come from lib/http, and two retries with
// jittered backoff only when the service gave no answer at all (refused or dropped, as while its process
// restarts). Any answer, a 5xx included, comes back at once: the service already retried Garmin inside one
// session, and every new request here is another Garmin login. A 429 throws garmin_rate_limited and only a
// job reschedules itself; slower retries belong to the job too. 409 rather than 401 for an expired Garmin
// login: the web app reads 401 as "signed out".
//
// Token rotation: login can refresh the tokens, and the old refresh token then stops working. Every bundle
// the service hands back that differs from the one sent, with an answer or with an error, goes to the
// caller's onTokenBundle, awaited before the call returns, retries or throws; a retry sends the new one.

// Sync and history pages list many activities, and an activity's detail is a login plus three paced calls:
// 60 s for all three (api rule), 20 s for the rest.
const SYNC_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Garmin blocks last about an hour; the service sends 3600 when Garmin gives no delay. */
export const DEFAULT_RETRY_AFTER_S = 3600;

export interface GarminClientOptions {
  baseUrl: string;
  secret: string;
}

export interface GarminCallOptions {
  /**
   * Stores a bundle Garmin rotated. The caller runs inside withUserLock and writes it back at once: if the
   * call then fails, the stored bundle is still the live one.
   */
  onTokenBundle: (tokenBundle: string) => Promise<void>;
}

export interface GarminClient {
  /** The cheapest call that proves a bundle still works. */
  profile(
    request: GarminProfileRequest,
    options: GarminCallOptions,
  ): Promise<GarminProfileResponse>;
  /** Runs whose local start date is in [startDate, endDate]. */
  sync(request: GarminSyncRequest, options: GarminCallOptions): Promise<GarminSyncResponse>;
  /** One page of the full history: `limit` list items from offset `start`, newest first. */
  history(
    request: GarminHistoryRequest,
    options: GarminCallOptions,
  ): Promise<GarminHistoryResponse>;
  /** The laps, samples, route and HR zones of one run; not_found (404) when Garmin has no such activity. */
  activityDetail(
    garminActivityId: number,
    request: GarminActivityDetailRequest,
    options: GarminCallOptions,
  ): Promise<GarminActivityDetailResponse>;
}

// Read before the full response schema, so a 2xx body that breaks the contract still hands its bundle over.
const carriesBundleSchema = z.object({ tokenBundle: garminTokenBundleSchema }).loose();

function retryAfterSeconds(failed: FailedResponse<GarminProblem>): number {
  if (failed.problem?.retryAfterSeconds !== undefined) return failed.problem.retryAfterSeconds;
  const header = Number(failed.headers.get("retry-after"));
  return Number.isInteger(header) && header > 0 ? header : DEFAULT_RETRY_AFTER_S;
}

function toError(path: string, failed: FailedResponse<GarminProblem>): Error {
  const code = failed.problem?.code;
  if (code === ErrorCode.garminAuthExpired) {
    return new DomainError(
      ErrorCode.garminAuthExpired,
      409,
      "Garmin rejected the saved login. Connect Garmin again.",
    );
  }
  if (code === ErrorCode.garminRateLimited || failed.status === 429) {
    return new DomainError(
      ErrorCode.garminRateLimited,
      429,
      "Garmin is limiting requests. Try again later.",
      { retryAfterSeconds: retryAfterSeconds(failed) },
    );
  }
  if (code === ErrorCode.garminUnavailable || failed.status >= 500) {
    return new DomainError(
      ErrorCode.garminUnavailable,
      502,
      "Garmin is not answering. Try again later.",
    );
  }
  if (code === ErrorCode.notFound) {
    // Garmin answered that the item is gone (deleted on Garmin Connect); the caller words it for its item.
    return new DomainError(ErrorCode.notFound, 404, "Garmin Connect has no such item.");
  }
  if (failed.status === 401) {
    // Our own misconfiguration, not the runner's: a 500 with the details in the log.
    return new Error(`The Garmin service rejected the shared secret on ${path}`);
  }
  return new Error(
    `The Garmin service answered ${failed.status} (${code ?? "no problem body"}) on ${path}`,
  );
}

function noAnswer(cause: unknown): DomainError {
  return new DomainError(
    ErrorCode.garminUnavailable,
    502,
    "The Garmin connection did not answer. Try again later.",
    { cause },
  );
}

export function createGarminClient(options: GarminClientOptions): GarminClient {
  /** Parses the request with its contract (our bug if it fails), posts it, parses the answer. */
  async function post<Req extends z.ZodType<{ tokenBundle: string }>, Res extends z.ZodType>(
    path: string,
    requestSchema: Req,
    request: z.input<Req>,
    responseSchema: Res,
    timeoutMs: number,
    { onTokenBundle }: GarminCallOptions,
  ): Promise<z.output<Res>> {
    const body = requestSchema.parse(request);
    let tokenBundle = body.tokenBundle;
    const adopt = async (returned: string | undefined): Promise<void> => {
      if (returned === undefined || returned === tokenBundle) return;
      await onTokenBundle(returned);
      tokenBundle = returned;
    };

    let result: FetchJsonResult<z.output<typeof carriesBundleSchema>, GarminProblem>;
    try {
      result = await fetchJson(`${options.baseUrl}${path}`, {
        method: "POST",
        headers: { "x-garmin-secret": options.secret },
        body: () => ({ ...body, tokenBundle }),
        schema: carriesBundleSchema,
        problemSchema: garminProblemSchema,
        onErrorResponse: (failed) => adopt(failed.problem?.tokenBundle),
        timeoutMs,
        retryOn: "network",
      });
    } catch (error) {
      if (error instanceof FetchFailure) throw noAnswer(error);
      throw error;
    }
    if (!result.ok) throw toError(path, result);

    await adopt(result.data.tokenBundle);
    const parsed = responseSchema.safeParse(result.data);
    if (!parsed.success) {
      throw noAnswer(
        new FetchFailure("invalid_response", `${options.baseUrl}${path}`, parsed.error),
      );
    }
    return parsed.data;
  }

  return {
    profile: (request, callOptions) =>
      post(
        "/profile",
        garminProfileRequestSchema,
        request,
        garminProfileResponseSchema,
        DEFAULT_TIMEOUT_MS,
        callOptions,
      ),
    sync: (request, callOptions) =>
      post(
        "/sync",
        garminSyncRequestSchema,
        request,
        garminSyncResponseSchema,
        SYNC_TIMEOUT_MS,
        callOptions,
      ),
    history: (request, callOptions) =>
      post(
        "/history",
        garminHistoryRequestSchema,
        request,
        garminHistoryResponseSchema,
        SYNC_TIMEOUT_MS,
        callOptions,
      ),
    // async, so a bad id rejects like a bad body instead of throwing synchronously.
    activityDetail: async (garminActivityId, request, callOptions) =>
      post(
        // Parsed like a request body, so a bad id never reaches the URL.
        `/activities/${garminActivitySummarySchema.shape.garminActivityId.parse(garminActivityId)}/detail`,
        garminActivityDetailRequestSchema,
        request,
        garminActivityDetailResponseSchema,
        SYNC_TIMEOUT_MS,
        callOptions,
      ),
  };
}

/** The client for the service this process spawned (src/garmin/process.ts). */
export const garminClient: GarminClient = createGarminClient({
  baseUrl: `http://127.0.0.1:${config.GARMIN_SERVICE_PORT}`,
  secret: config.GARMIN_SERVICE_SECRET,
});
