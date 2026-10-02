import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isApiError, isClientError } from "@/api/client";

const MAX_RETRIES = 3;

type Options = {
  /** Called when any query or mutation gets a 401: the session expired while the app was open. */
  onUnauthorized?: () => void;
};

/** Exponential backoff with full jitter, capped at 30 s, so many tabs never retry in lockstep. */
export function retryDelay(attempt: number): number {
  return Math.random() * Math.min(1_000 * 2 ** attempt, 30_000);
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
        // A 4xx will fail the same way again; only network and server errors are worth retrying.
        retry: (failureCount, error) => !isClientError(error) && failureCount < MAX_RETRIES,
        retryDelay,
        refetchOnWindowFocus: false,
      },
    },
  });
}
