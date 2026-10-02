import { ErrorCode, meResponseSchema, type Problem } from "@running-coach/shared";
import type { Page, Request } from "@playwright/test";
import { attemptStorageKey } from "../../src/api/sync-on-open";

/**
 * Opens the app without its app-open sync, for a test about Sync now or about another screen that needs
 * Garmin connected: before every page load in `page` this device records an app-open attempt made just
 * now, so useSyncOnOpen finds one within its 10 minutes and sends nothing. Written with the browser's own
 * clock, so it holds under page.clock too. Call before the first page.goto.
 */
export async function skipSyncOnOpen(page: Page): Promise<void> {
  const me = meResponseSchema.parse(await (await page.request.get("/api/me")).json());
  await page.addInitScript((key) => {
    localStorage.setItem(key, String(Date.now()));
  }, attemptStorageKey(me.user.id));
}

/** POST /api/sync from the page: Sync now, Retry or the app-open sync, whether intercepted or not. */
export function isSyncPost(request: Request): boolean {
  return request.method() === "POST" && new URL(request.url()).pathname === "/api/sync";
}

/** Every POST /api/sync the page sends from now on, in order: its length is the count so far. */
export function recordSyncPosts(page: Page): Request[] {
  const posts: Request[] = [];
  page.on("request", (request) => {
    if (isSyncPost(request)) posts.push(request);
  });
  return posts;
}

/** A problem+json answer for POST /api/sync, as the API's error middleware writes it, for route.fulfill. */
export function syncProblem(problem: Problem, headers: Record<string, string> = {}) {
  return {
    status: problem.status,
    contentType: "application/problem+json",
    headers,
    body: JSON.stringify(problem),
  };
}

/** Garmin answered a sync with a 429: the API passes on its hour, in the problem and in Retry-After. */
export const garminRateLimited = syncProblem(
  {
    type: "about:blank",
    title: "Too Many Requests",
    status: 429,
    code: ErrorCode.garminRateLimited,
    retryAfterSeconds: 3600,
    requestId: "e2e-sync-rate-limited",
  },
  { "retry-after": "3600" },
);

/** Garmin did not answer a sync, or answered with a server error. */
export const garminUnavailable = syncProblem({
  type: "about:blank",
  title: "Bad Gateway",
  status: 502,
  code: ErrorCode.garminUnavailable,
  requestId: "e2e-sync-unavailable",
});
