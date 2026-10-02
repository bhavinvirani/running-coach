import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import pino from "pino";
import { config } from "./config";

// Keys that may hold a secret or personal data, redacted at any of the first three levels of a log object.
const SENSITIVE_KEYS = [
  "tokenBundle",
  "token",
  "password",
  "apiKey",
  "authorization",
  "cookie",
  "set-cookie",
  "email",
  "x-garmin-secret",
];
const redactPaths = SENSITIVE_KEYS.flatMap((key) => {
  const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const join = (prefix: string) =>
    segment.startsWith("[") ? `${prefix}${segment}` : `${prefix}.${segment}`;
  return [segment, join("*"), join("*.*")];
});

interface RequestContext {
  requestId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** The id of the request or job this code runs for, if any. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Runs fn with a request id that every log line and outgoing call inside it carries (jobs use this too). */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

const SANE_REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * Takes x-request-id from the caller when it looks like an id (the web app sends one), else makes one,
 * echoes it on the response and runs the rest of the request inside its context.
 */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  const requestId = incoming && SANE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("x-request-id", requestId);
  withRequestId(requestId, next);
};

/** Exported so tests can point the same options at an in-memory stream. */
export const loggerOptions: pino.LoggerOptions = {
  level: config.LOG_LEVEL,
  redact: { paths: redactPaths, censor: "[redacted]" },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  mixin() {
    const requestId = currentRequestId();
    return requestId ? { requestId } : {};
  },
};

export const logger = pino(loggerOptions);

export type Logger = pino.Logger;
