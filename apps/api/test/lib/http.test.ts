import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FetchFailure, fetchJson } from "../../src/lib/http";
import { withRequestId } from "../../src/lib/logger";

// A local stand-in for the Garmin service: each test queues the responses it should give.
type Reply = (req: IncomingMessage, res: ServerResponse) => void;
let replies: Reply[] = [];
let seen: IncomingMessage[] = [];
let server: Server;
let baseUrl: string;

const json = (status: number, body: unknown, contentType = "application/json"): Reply => {
  return (_req, res) => {
    res.writeHead(status, { "content-type": contentType }).end(JSON.stringify(body));
  };
};

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    const reply = replies.shift() ?? json(500, { error: "no reply queued" });
    reply(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  replies = [];
  seen = [];
});

const okSchema = z.object({ status: z.literal("ok") });
const fast = { timeoutMs: 2000, baseDelayMs: 1, maxDelayMs: 5, schema: okSchema };

describe("fetchJson", () => {
  it("parses a 2xx body with the schema and forwards the current request id", async () => {
    replies = [json(200, { status: "ok" })];

    const result = await withRequestId("req-7", () => fetchJson(`${baseUrl}/health`, fast));

    expect(result).toMatchObject({ ok: true, status: 200, data: { status: "ok" } });
    expect(seen[0]?.headers["x-request-id"]).toBe("req-7");
  });

  it("retries a 5xx twice, then succeeds", async () => {
    replies = [json(502, {}), json(503, {}), json(200, { status: "ok" })];

    const result = await fetchJson(`${baseUrl}/sync`, { ...fast, method: "POST", body: {} });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(3);
  });

  it("returns the last 5xx problem after the retries run out", async () => {
    const problem = {
      type: "about:blank",
      title: "Bad Gateway",
      status: 502,
      code: "garmin_unavailable",
    };
    replies = [
      json(502, problem),
      json(502, problem),
      json(502, problem, "application/problem+json"),
    ];

    const result = await fetchJson(`${baseUrl}/sync`, fast);

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      problem: { code: "garmin_unavailable" },
    });
    expect(seen).toHaveLength(3);
  });

  it("never retries a 429 and hands back its problem", async () => {
    replies = [
      json(429, {
        type: "about:blank",
        title: "Too Many Requests",
        status: 429,
        code: "garmin_rate_limited",
        retryAfterSeconds: 3600,
      }),
    ];

    const result = await fetchJson(`${baseUrl}/sync`, fast);

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      problem: { code: "garmin_rate_limited", retryAfterSeconds: 3600 },
    });
    expect(seen).toHaveLength(1);
  });

  it("never retries a 4xx; a body that is not problem+json gives an undefined problem", async () => {
    replies = [json(401, { message: "nope" })];

    const result = await fetchJson(`${baseUrl}/profile`, fast);

    expect(result).toMatchObject({ ok: false, status: 401, problem: undefined });
    expect(seen).toHaveLength(1);
  });

  it("throws FetchFailure invalid_response when a 2xx body breaks the schema", async () => {
    replies = [json(200, { status: "weird" })];

    await expect(fetchJson(`${baseUrl}/health`, fast)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("throws FetchFailure timeout without retrying", async () => {
    replies = [() => undefined];

    const failure = fetchJson(`${baseUrl}/slow`, { ...fast, timeoutMs: 100 });

    await expect(failure).rejects.toBeInstanceOf(FetchFailure);
    await expect(failure).rejects.toMatchObject({ kind: "timeout" });
    expect(seen).toHaveLength(1);
  });

  it("retries network errors, then throws FetchFailure network", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    await expect(fetchJson(`http://127.0.0.1:${port}/`, fast)).rejects.toMatchObject({
      kind: "network",
    });
  });
});
