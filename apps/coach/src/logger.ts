import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

// pino JSON lines like the API's logger. Every line inside a request carries the API's x-request-id.
// Never log the token, the prompt, the input or the model's output: only ids, counts and durations.

const SENSITIVE_KEYS = ["x-coach-secret", "authorization", "token", "CLAUDE_CODE_OAUTH_TOKEN"];
const redactPaths = SENSITIVE_KEYS.flatMap((key) => {
  const segment = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const join = (prefix: string) =>
    segment.startsWith("[") ? `${prefix}${segment}` : `${prefix}.${segment}`;
  return [segment, join("*"), join("*.*")];
});

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** The id of the request this code runs for, if any. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Runs fn with a request id that every log line inside it carries. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

export type Logger = pino.Logger;

/** The service's logger; tests pass an in-memory destination. */
export function createLogger(level: pino.LevelWithSilent, destination?: pino.DestinationStream) {
  const options: pino.LoggerOptions = {
    level,
    redact: { paths: redactPaths, censor: "[redacted]" },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const requestId = currentRequestId();
      return requestId ? { requestId } : {};
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
