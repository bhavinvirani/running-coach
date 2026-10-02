import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

// A local stand-in for the Claude Messages API, started once per run by global-setup.ts. The API key
// picks the behaviour: "test-<fixture>.<nonce>" replays test/fixtures/claude/<fixture>.json, one entry of
// its "responses" per call (the last one repeats). Requests are recorded per key and readable at
// GET /__requests/<key>, so a test can see exactly what the coach sent.

interface FixtureResponse {
  status: number;
  delayMs?: number;
  body: unknown;
}

interface Fixture {
  responses: FixtureResponse[];
}

export interface FakeClaude {
  url: string;
  close(): Promise<void>;
}

const KEY_PATTERN = /^test-([a-z0-9-]+)\.[\w-]+$/;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown, requestId?: string): void {
  if (res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json",
    ...(requestId ? { "request-id": requestId } : {}),
  });
  res.end(JSON.stringify(body));
}

/** Fixture text blocks may hold `json` instead of `text`; the model's answer is that JSON as a string. */
function materialize(body: unknown, model: unknown, call: number): unknown {
  if (typeof body !== "object" || body === null || !("content" in body)) return body;
  const message = body as { content: unknown[] };
  return {
    id: `msg_fake_${call}`,
    type: "message",
    role: "assistant",
    model,
    stop_sequence: null,
    stop_details: null,
    ...message,
    content: message.content.map((block) =>
      typeof block === "object" && block !== null && "json" in block
        ? { type: "text", text: JSON.stringify(block.json) }
        : block,
    ),
  };
}

export async function startFakeClaude(fixturesDir: string): Promise<FakeClaude> {
  const requests = new Map<string, unknown[]>();

  const server = createServer((req, res) => {
    res.on("error", () => undefined);
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      if (req.method === "GET" && url.pathname.startsWith("/__requests/")) {
        const key = decodeURIComponent(url.pathname.slice("/__requests/".length));
        send(res, 200, requests.get(key) ?? []);
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/messages") {
        send(res, 404, { type: "error", error: { type: "not_found_error", message: "no route" } });
        return;
      }

      const key = req.headers["x-api-key"];
      const body = await readBody(req);
      const match = typeof key === "string" ? KEY_PATTERN.exec(key) : null;
      if (typeof key !== "string" || !match?.[1]) {
        send(res, 401, {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        });
        return;
      }
      const recorded = requests.get(key) ?? [];
      recorded.push({ headers: { "x-request-id": req.headers["x-request-id"] ?? null }, body });
      requests.set(key, recorded);

      const fixture = JSON.parse(
        readFileSync(path.join(fixturesDir, `${match[1]}.json`), "utf8"),
      ) as Fixture;
      const call = recorded.length;
      const response = fixture.responses[Math.min(call, fixture.responses.length) - 1];
      if (!response) throw new Error(`Fixture ${match[1]} has no responses`);
      if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      const model = (body as { model?: unknown } | undefined)?.model;
      send(res, response.status, materialize(response.body, model, call), `req_fake_${call}`);
    })().catch((error: unknown) => {
      send(res, 500, {
        type: "error",
        error: {
          type: "api_error",
          message: error instanceof Error ? error.message : "fake failed",
        },
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
