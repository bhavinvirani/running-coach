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
  "x-coach-secret",
];
const redactPaths = SENSITIVE_KEYS.flatMap((key) => {
  const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const join = (prefix: string) =>
    segment.startsWith("[") ? `${prefix}${segment}` : `${prefix}.${segment}`;
  return [segment, join("*"), join("*.*")];
});

type ErrorLike = Record<string, unknown> & { message: string };

function isErrorLike(value: unknown): value is ErrorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * The "\nparams: ..." text drizzle's DrizzleQueryError writes into its message and stack, for the error and
 * every error linked to it: its cause, AggregateError members, other error-valued properties, and the
 * original behind an error pino already serialized (pino-http passes those).
 */
function queryParamTexts(err: unknown, seen = new Set<unknown>()): string[] {
  if (!isErrorLike(err) || seen.has(err)) return [];
  seen.add(err);
  const texts =
    typeof err.query === "string" && Array.isArray(err.params)
      ? [`\nparams: ${String(err.params)}`]
      : [];
  const linked = [
    err.cause,
    (err as { raw?: unknown }).raw,
    ...(Array.isArray(err.errors) ? (err.errors as unknown[]) : []),
    ...Object.values(err),
  ];
  for (const value of linked) texts.push(...queryParamTexts(value, seen));
  return texts;
}

// Values a failed query carries: drizzle's params (session tokens, password hashes, emails, later health
// data) and pg's detail ("Key (email)=(...) already exists").
const VALUE_KEYS = ["params", "detail"];

/** Strips query values from an error pino serialized, and from the errors it serialized inside it. */
function scrubSerialized(serialized: ErrorLike, paramTexts: string[]): void {
  for (const key of ["message", "stack"]) {
    const text = serialized[key];
    if (typeof text === "string") {
      serialized[key] = paramTexts.reduce((result, params) => result.replaceAll(params, ""), text);
    }
  }
  for (const key of VALUE_KEYS) delete serialized[key];
  const nested = Array.isArray(serialized.aggregateErrors) ? serialized.aggregateErrors : [];
  // pino serializes error-valued properties into fresh objects; other values are the caller's, left as is.
  for (const value of [...(nested as unknown[]), ...Object.values(serialized)]) {
    if (isErrorLike(value) && typeof value.stack === "string") scrubSerialized(value, paramTexts);
  }
}

/**
 * pino's err serializer without SQL parameter values: drizzle puts them in a failed query's message and stack
 * and on `params`, and pino copies all three (redact matches keys, not text). Every logger here uses it.
 */
export function errSerializer(err: unknown): unknown {
  if (!isErrorLike(err)) return err;
  const serialized = pino.stdSerializers.err(err as unknown as Error) as ErrorLike;
  scrubSerialized(serialized, queryParamTexts(err));
  return serialized;
}

/** An error's message with its causes, without query values; for text printed outside the logger. */
export function safeErrorMessage(err: unknown): string {
  const serialized = errSerializer(err);
  return isErrorLike(serialized) ? serialized.message : String(err);
}

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
  serializers: { err: errSerializer },
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
