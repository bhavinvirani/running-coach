import { ErrorCode, type Problem } from "@running-coach/shared";
import type { Request, RequestHandler, Response } from "express";
import { config } from "../lib/config";
import { DomainError, sendProblem, toProblem } from "../lib/errors";
import { auth, CLIENT_IP_HEADER } from "./auth";

// Serves /api/auth/* through Better Auth. Better Auth's toNodeHandler writes its own error JSON
// ({ code, message }); this adapter passes successes through untouched and turns every error into the same
// problem+json the rest of the API sends, so the web app handles one error shape. Mounted before
// express.json(): Better Auth reads the raw body itself.

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req: Request): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new DomainError(ErrorCode.validation, 413, "The request body is larger than 1 MB.");
    }
    chunks.push(chunk);
  }
  return size > 0 ? Buffer.concat(chunks) : undefined;
}

function toWebRequest(req: Request, body: Buffer | undefined): globalThis.Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  // The client IP Better Auth rate-limits on: Express derived it with `trust proxy` 1, which only trusts the
  // hop Render adds. Any value the client sent under this name is replaced.
  headers.delete(CLIENT_IP_HEADER);
  if (req.ip) headers.set(CLIENT_IP_HEADER, req.ip);
  return new globalThis.Request(new URL(req.originalUrl, config.APP_URL), {
    method: req.method,
    headers,
    body,
  });
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return ErrorCode.unauthorized;
  if (status === 404) return ErrorCode.notFound;
  if (status === 429) return ErrorCode.rateLimited;
  return ErrorCode.validation;
}

async function problemFromAuthResponse(response: globalThis.Response): Promise<Problem> {
  if (response.status >= 500) {
    return toProblem(ErrorCode.internal, 500, "Something went wrong on our side. Try again.");
  }
  let message: string | undefined;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length <= 200) message = body.message;
  } catch {
    message = undefined;
  }
  const retryAfter = Number(response.headers.get("x-retry-after"));
  return toProblem(codeForStatus(response.status), response.status, message, {
    ...(response.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0
      ? { retryAfterSeconds: Math.ceil(retryAfter) }
      : {}),
  });
}

async function send(res: Response, response: globalThis.Response): Promise<void> {
  if (response.status >= 400) {
    sendProblem(res, await problemFromAuthResponse(response));
    return;
  }
  res.status(response.status);
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

export const authHandler: RequestHandler = async (req, res) => {
  const response = await auth.handler(toWebRequest(req, await readBody(req)));
  await send(res, response);
};
