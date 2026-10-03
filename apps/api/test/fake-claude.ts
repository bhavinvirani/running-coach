import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

// A local stand-in for the Claude Messages and Models APIs, started once per run by global-setup.ts (and
// for Playwright by fake-claude-cli.ts). The API key picks the behaviour: "test-<fixture>.<nonce>"
// replays test/fixtures/claude/<fixture>.json, one entry of its "responses" per message (the last one
// repeats). GET /v1/models, the free key check, answers as the fixture's first response would: its error
// status and body when that is an error, after its delay, else a models list. Message requests are
// recorded per key at GET /__requests/<key>, model list requests at GET /__requests/<key>/models.

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

const MODELS_LIST = {
  data: [
    {
      type: "model",
      id: "claude-opus-5-5",
      display_name: "Claude Opus 5.5",
      created_at: "2026-01-01T00:00:00Z",
    },
  ],
  has_more: false,
  first_id: "claude-opus-5-5",
  last_id: "claude-opus-5-5",
};

const AUTHENTICATION_ERROR = {
  type: "error",
  error: { type: "authentication_error", message: "invalid x-api-key" },
};

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

/** The fixture a key picks, or null for a missing, malformed or unknown key (Claude's 401). */
function fixtureFor(fixturesDir: string, key: unknown): Fixture | null {
  const name = typeof key === "string" ? KEY_PATTERN.exec(key)?.[1] : undefined;
  if (!name) return null;
  const file = path.join(fixturesDir, `${name}.json`);
  if (!existsSync(file)) return null;
  const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
  if (fixture.responses.length === 0) throw new Error(`Fixture ${name} has no responses`);
  return fixture;
}

function record(log: Map<string, unknown[]>, key: string, entry: unknown): number {
  const recorded = log.get(key) ?? [];
  recorded.push(entry);
  log.set(key, recorded);
  return recorded.length;
}

async function delay(response: FixtureResponse): Promise<void> {
  if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
}

export async function startFakeClaude(fixturesDir: string, port = 0): Promise<FakeClaude> {
  const requests = new Map<string, unknown[]>();
  const modelRequests = new Map<string, unknown[]>();

  const server = createServer((req, res) => {
    res.on("error", () => undefined);
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      if (req.method === "GET" && url.pathname.startsWith("/__requests/")) {
        const rest = url.pathname.slice("/__requests/".length);
        const models = rest.endsWith("/models");
        const key = decodeURIComponent(models ? rest.slice(0, -"/models".length) : rest);
        send(res, 200, (models ? modelRequests : requests).get(key) ?? []);
        return;
      }
      const isModels = req.method === "GET" && url.pathname === "/v1/models";
      if (!isModels && (req.method !== "POST" || url.pathname !== "/v1/messages")) {
        send(res, 404, { type: "error", error: { type: "not_found_error", message: "no route" } });
        return;
      }

      const key = req.headers["x-api-key"];
      const body = isModels ? undefined : await readBody(req);
      const fixture = fixtureFor(fixturesDir, key);
      if (typeof key !== "string" || !fixture) {
        send(res, 401, AUTHENTICATION_ERROR);
        return;
      }
      const headers = { "x-request-id": req.headers["x-request-id"] ?? null };

      if (isModels) {
        const call = record(modelRequests, key, { headers, query: url.search });
        const [first] = fixture.responses as [FixtureResponse];
        await delay(first);
        const failed = first.status >= 400;
        send(
          res,
          failed ? first.status : 200,
          failed ? first.body : MODELS_LIST,
          `req_fake_models_${call}`,
        );
        return;
      }

      const call = record(requests, key, { headers, body });
      const response = fixture.responses[Math.min(call, fixture.responses.length) - 1];
      if (!response) throw new Error("unreachable: the fixture has responses");
      await delay(response);
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
