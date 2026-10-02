import { ErrorCode, type Problem } from "@running-coach/shared";
import { vi } from "vitest";

export type FakeRequest = {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
};

type Handler = (request: FakeRequest) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function problem(status: number, code: ErrorCode, extra: Partial<Problem> = {}): Response {
  const body: Problem = { type: "about:blank", title: code, status, code, ...extra };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/** A promise that never settles: keeps a query in its loading state for the whole test. */
export function never(): Promise<Response> {
  return new Promise<Response>(() => {});
}

/**
 * Replaces global fetch for one test (unstubGlobals restores it). Unit tests never reach a server:
 * every request goes to `handler`, and `calls` records what the app sent.
 */
export function stubFetch(handler: Handler): FakeRequest[] {
  const calls: FakeRequest[] = [];
  // Reads the arguments instead of building a Request: Node's Request rejects jsdom's AbortSignal.
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const original = input instanceof Request ? input : undefined;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const text = typeof init?.body === "string" ? init.body : original ? await original.text() : "";
    const call: FakeRequest = {
      method: (init?.method ?? original?.method ?? "GET").toUpperCase(),
      path: new URL(url, window.location.origin).pathname,
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
      headers: new Headers(init?.headers ?? original?.headers),
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fake);
  return calls;
}

export function notFound(): Response {
  return problem(404, ErrorCode.notFound);
}
