import { createHash, timingSafeEqual } from "node:crypto";
import { cronSyncResponseSchema, ErrorCode } from "@running-coach/shared";
import { type RequestHandler, Router } from "express";
import { config } from "../lib/config";
import { DomainError } from "../lib/errors";
import { respond } from "../lib/http";
import { queueDailySyncs } from "../services/daily-sync";

// The GitHub Actions cron's endpoint (SPEC: Scheduler). Mounted above requireUser: it has no session, only
// the CRON_SECRET bearer token. No rate limit: the secret is 256 bits and a wrong one does no work.

export const cronRouter = Router();

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Whether an Authorization header is "Bearer <secret>". Compares SHA-256 digests in constant time, so the
 * timing reveals neither the secret's bytes nor its length. False when no secret is configured.
 */
export function isCronAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match?.[1]) return false;
  return timingSafeEqual(sha256(match[1]), sha256(secret));
}

// On the route only: on the router it would also run for every other /api path that passes through.
const requireCronSecret: RequestHandler = (req, _res, next) => {
  if (!isCronAuthorized(req.get("authorization"), config.CRON_SECRET)) {
    throw new DomainError(
      ErrorCode.unauthorized,
      401,
      "Send the cron secret as an Authorization Bearer token.",
    );
  }
  next();
};

cronRouter.post("/cron/sync", requireCronSecret, async (_req, res) => {
  respond(res, cronSyncResponseSchema, await queueDailySyncs({ now: new Date() }));
});
