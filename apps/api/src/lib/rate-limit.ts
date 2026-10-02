import { ErrorCode } from "@running-coach/shared";
import type { RequestHandler } from "express";
import { config } from "./config";
import { DomainError } from "./errors";

// In-memory limits for the per-user routes that log in to Garmin. One process serves the app (SPEC), so
// memory is enough; a second instance would need the limits in Postgres.

/**
 * Each route that logs in to Garmin (Sync now, connect, import, a run's detail): six a minute per user by
 * default, far above a runner's taps, since every request is a Garmin login. config.GARMIN_ROUTE_LIMIT
 * raises it for e2e only.
 */
export const garminRouteLimit = { limit: config.GARMIN_ROUTE_LIMIT, windowMs: 60_000 } as const;

export interface RateLimitOptions {
  /** Requests allowed per key within any window. */
  limit: number;
  windowMs: number;
  /** Milliseconds since the epoch; tests pass their own clock. */
  now?: () => number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  /** Counts a request for key, unless it is over the limit; a refused request is not counted. */
  take(key: string): RateLimitDecision;
  /** Forgets every key; tests call it so files and cases stay independent. */
  reset(): void;
}

/**
 * A sliding window: a key may make `limit` requests in any `windowMs`, so a burst at the end of one minute
 * cannot add a second burst at the start of the next, as a fixed window would allow.
 */
export function createRateLimiter({
  limit,
  windowMs,
  now = Date.now,
}: RateLimitOptions): RateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = now();

  // Drops keys with no request in the window, at most once per window, so idle users do not pile up.
  function sweep(at: number): void {
    if (at - lastSweep < windowMs) return;
    lastSweep = at;
    for (const [key, times] of hits) {
      if ((times.at(-1) ?? 0) <= at - windowMs) hits.delete(key);
    }
  }

  return {
    take(key) {
      const at = now();
      sweep(at);
      const recent = (hits.get(key) ?? []).filter((time) => time > at - windowMs);
      const oldest = recent[0];
      if (oldest !== undefined && recent.length >= limit) {
        hits.set(key, recent);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - at) / 1000)),
        };
      }
      recent.push(at);
      hits.set(key, recent);
      return { allowed: true };
    },
    reset() {
      hits.clear();
      lastSweep = now();
    },
  };
}

/** 429 rate_limited with Retry-After once the signed-in user is over `limiter`. Mount after requireUser. */
export function limitPerUser(limiter: RateLimiter): RequestHandler {
  return (req, _res, next) => {
    const decision = limiter.take(req.user.id);
    if (!decision.allowed) {
      throw new DomainError(
        ErrorCode.rateLimited,
        429,
        "Too many requests. Wait a minute and try again.",
        { retryAfterSeconds: decision.retryAfterSeconds },
      );
    }
    next();
  };
}
