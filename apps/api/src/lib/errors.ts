import { STATUS_CODES } from "node:http";
import { ErrorCode, type Problem } from "@running-coach/shared";
import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { currentRequestId, logger } from "./logger";

export interface DomainErrorExtra {
  retryAfterSeconds?: number;
  issues?: { path: string; message: string }[];
  cause?: unknown;
}

/** An expected failure with a code from the shared list; rendered as problem+json by errorHandler. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly issues: { path: string; message: string }[] | undefined;

  constructor(code: ErrorCode, status: number, detail?: string, extra: DomainErrorExtra = {}) {
    super(detail ?? code, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.issues = extra.issues;
  }
}

export function zodIssues(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/** Builds a problem+json body; requestId comes from the current request context. */
export function toProblem(
  code: ErrorCode,
  status: number,
  detail?: string,
  extra: Omit<DomainErrorExtra, "cause"> = {},
): Problem {
  const requestId = currentRequestId();
  return {
    type: "about:blank",
    title: STATUS_CODES[status] ?? "Error",
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(extra.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: extra.retryAfterSeconds }),
    ...(extra.issues === undefined ? {} : { issues: extra.issues }),
  };
}

export function sendProblem(res: Response, problem: Problem): void {
  if (problem.retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(problem.retryAfterSeconds));
  }
  res.status(problem.status).type("application/problem+json").send(JSON.stringify(problem));
}

// body-parser marks its client errors with a `type` and an exposable 4xx status.
function bodyParserError(err: unknown): { status: number; type: string } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { status, type, expose } = err as { status?: unknown; type?: unknown; expose?: unknown };
  if (typeof status !== "number" || typeof type !== "string" || expose !== true) return undefined;
  return status >= 400 && status < 500 ? { status, type } : undefined;
}

const BODY_ERROR_DETAILS: Record<string, string> = {
  "entity.parse.failed": "The request body is not valid JSON.",
  "entity.too.large": "The request body is larger than 1 MB.",
};

function problemFor(err: unknown): Problem {
  if (err instanceof DomainError) {
    return toProblem(err.code, err.status, err.detail, {
      ...(err.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: err.retryAfterSeconds }),
      ...(err.issues === undefined ? {} : { issues: err.issues }),
    });
  }
  if (err instanceof ZodError) {
    return toProblem(ErrorCode.validation, 400, "The request is not valid.", {
      issues: zodIssues(err),
    });
  }
  const bodyError = bodyParserError(err);
  if (bodyError) {
    return toProblem(
      ErrorCode.validation,
      bodyError.status,
      BODY_ERROR_DETAILS[bodyError.type] ?? "The request body could not be read.",
    );
  }
  return toProblem(ErrorCode.internal, 500, "Something went wrong on our side. Try again.");
}

/** The one error middleware: every error leaves the API as problem+json. Register it last. */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const problem = problemFor(err);
  if (problem.status >= 500) {
    // Unknown errors keep their stack in the log only; the body never carries it or upstream text.
    logger.error({ err, code: problem.code }, "request failed");
  }
  sendProblem(res, problem);
};

/** 404 for anything no route matched. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  sendProblem(res, toProblem(ErrorCode.notFound, 404, "Nothing here."));
};
