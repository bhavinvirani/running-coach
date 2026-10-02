import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isApiError, isClientError } from "@/api/client";

const MAX_RETRIES = 3;

/** Render's free plan sleeps after 15 minutes idle and takes up to a minute to wake; allow some slack. */
const WAKE_BUDGET_MS = 90_000;
const WAKE_DELAY_CAP_MS = 5_000;

type Options = {
  /** Called when any query or mutation gets a 401: the session expired while the app was open. */
  onUnauthorized?: () => void;
};

/** Exponential backoff with full jitter, so many tabs never retry in lockstep. */
function backoff(attempt: number, capMs: number): number {
  return Math.random() * Math.min(1_000 * 2 ** attempt, capMs);
}

/** The usual delay between retries, capped at 30 s. */
export function retryDelay(attempt: number): number {
  return backoff(attempt, 30_000);
}

/** A 4xx will fail the same way again; only network and server errors are worth retrying. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  return !isClientError(error) && failureCount < MAX_RETRIES;
}

/** What a sleeping server looks like from here: no answer at all, or Render's proxy answering 502 to 504. */
function isWakingError(error: unknown): boolean {
  if (!isApiError(error)) return false;
  // Offline is not asleep: waiting a minute would only delay the "check your connection" message.
  if (error.network) return navigator.onLine;
  return error.status === 502 || error.status === 503 || error.status === 504;
}

/**
 * Retry options for the request the first screen waits on (GET /api/me in the authenticated loader): ride
 * out a wake for about 90 s, trying at least every 5 s so the app opens soon after the server is up; any
 * other error keeps the usual policy. apiFetch sets no timeout, so a request the proxy holds while the server
 * starts is never cut short. Call it per load: the budget starts when it is called.
 */
export function bootRetry(now: () => number = Date.now) {
  const deadline = now() + WAKE_BUDGET_MS;
  return {
    retry: (failureCount: number, error: unknown) =>
      (isWakingError(error) && now() < deadline) || shouldRetry(failureCount, error),
    retryDelay: (attempt: number) => backoff(attempt, WAKE_DELAY_CAP_MS),
  };
}

export function createQueryClient({ onUnauthorized }: Options = {}): QueryClient {
  const onError = (error: unknown) => {
    if (isApiError(error) && error.status === 401) onUnauthorized?.();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay,
        refetchOnWindowFocus: false,
      },
    },
  });
}
