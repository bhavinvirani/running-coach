import { createHash, timingSafeEqual } from "node:crypto";
import { ErrorCode } from "@running-coach/shared";
import type { RequestHandler } from "express";
import { config } from "../lib/config";
import { DomainError } from "../lib/errors";

// The GitHub Actions cron's guard (SPEC: Scheduler): it has no session, only the CRON_SECRET bearer token.
// No rate limit: the secret is a long random value (openssl rand -hex 32, issue #20) and a wrong one does no
// work.

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Whether an Authorization header is "Bearer <secret>". Compares SHA-256 digests in constant time, so the
 * timing reveals neither the secret's bytes nor its length. False when no secret is configured.
 */
function isCronAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match?.[1]) return false;
  return timingSafeEqual(sha256(match[1]), sha256(secret));
}

/**
 * 401 problem unless the request carries the cron secret. Put it on the route, not the router: on the
 * router it would also run for every other /api path that passes through.
 */
export const requireCronSecret: RequestHandler = (req, _res, next) => {
  if (!isCronAuthorized(req.get("authorization"), config.CRON_SECRET)) {
    throw new DomainError(
      ErrorCode.unauthorized,
      401,
      "Send the cron secret as an Authorization Bearer token.",
    );
  }
  next();
};
