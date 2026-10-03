import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  STATUS_CODES,
  type ServerResponse,
} from "node:http";
import {
  coachRunRequestSchema,
  coachRunResponseSchema,
  ErrorCode,
  type Problem,
} from "@running-coach/shared";
import type { Config } from "./config";
import { currentRequestId, type Logger, withRequestId } from "./logger";
import type { Runner } from "./run";

// GET /health for Render and the API's wake-up poll; POST /v1/run behind the shared secret. Everything
// else is 404. Errors are problem+json, as from the API and the Garmin service.

// A run's system prompt and input are at most 100k characters each (coachRunRequestSchema); the prompts
// the API sends are a few KB.
const BODY_LIMIT_BYTES = 256 * 1024;
const SANE_REQUEST_ID = /^[\w.:-]{1,128}$/;

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly detail: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(detail);
  }
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

function sendJson(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": type });
  res.end(JSON.stringify(body));
}

function sendProblem(res: ServerResponse, problem: HttpProblem) {
  const requestId = currentRequestId();
  const body: Problem = {
    type: "about:blank",
    title: STATUS_CODES[problem.status] ?? "Error",
    status: problem.status,
    code: problem.code,
    detail: problem.detail,
    ...(requestId === undefined ? {} : { requestId }),
    ...(problem.issues === undefined ? {} : { issues: problem.issues }),
  };
  sendJson(res, problem.status, body, "application/problem+json");
}

/** The body as JSON, refusing more than the limit before reading it all. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const tooLarge = new HttpProblem(
    413,
    ErrorCode.validation,
    "The request body is larger than 256 KB.",
  );
  if (Number(req.headers["content-length"] ?? 0) > BODY_LIMIT_BYTES) throw tooLarge;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw tooLarge;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpProblem(400, ErrorCode.validation, "The request body is not valid JSON.");
  }
}

export function createCoachServer({
  config,
  logger,
  runner,
}: {
  config: Config;
  logger: Logger;
  runner: Runner;
}): Server {
  const secretDigest = sha256(config.COACH_SERVICE_SECRET);

  /** SHA-256 digests compared in constant time, so the timing reveals neither the bytes nor the length. */
  function isAuthorized(header: string | string[] | undefined): boolean {
    if (typeof header !== "string" || header === "") return false;
    return timingSafeEqual(sha256(header), secretDigest);
  }

  async function handleRun(req: IncomingMessage, res: ServerResponse) {
    // Before the body is read, so a wrong secret costs no parse and starts no CLI.
    if (!isAuthorized(req.headers["x-coach-secret"])) {
      logger.warn("coach run refused: wrong or missing secret");
      throw new HttpProblem(
        401,
        ErrorCode.unauthorized,
        "Send the coach secret in x-coach-secret.",
      );
    }
    const parsed = coachRunRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new HttpProblem(
        400,
        ErrorCode.validation,
        "The run request is invalid.",
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      );
    }
    // The API hung up (its timeout, a redeploy): skip the run if it waits, abort it if it runs.
    const hangup = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) hangup.abort();
    });
    // A hang-up while the body was read closed the socket before the listener existed.
    if (req.socket.destroyed) hangup.abort();
    const response = await runner.run(parsed.data, hangup.signal);
    if (response === null || hangup.signal.aborted) return;
    sendJson(res, 200, coachRunResponseSchema.parse(response));
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = new URL(req.url ?? "/", "http://coach");
    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "POST" && pathname === "/v1/run") {
      await handleRun(req, res);
      return;
    }
    throw new HttpProblem(404, ErrorCode.notFound, "No such route.");
  }

  function fail(req: IncomingMessage, res: ServerResponse, error: unknown) {
    if (error instanceof HttpProblem) {
      sendProblem(res, error);
    } else {
      // Never the upstream text in the response; the log has the stack.
      logger.error({ err: error }, "coach request failed");
      sendProblem(res, new HttpProblem(500, ErrorCode.internal, "The coach service failed."));
    }
    // Drop the rest of a refused body instead of reading it.
    if (!req.complete) req.destroy();
  }

  return createServer((req, res) => {
    const incoming = req.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && SANE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("cache-control", "no-store");
    withRequestId(requestId, () => {
      handle(req, res).catch((error: unknown) => fail(req, res, error));
    });
  });
}
