import { cronSyncResponseSchema } from "@running-coach/shared";
import { Router } from "express";
import { requireCronSecret } from "../auth/require-cron-secret";
import { respond } from "../lib/http";
import { queueDailySyncs } from "../services/daily-sync";

// The GitHub Actions cron's endpoint (SPEC: Scheduler). Mounted above requireUser: it has no session, only
// the CRON_SECRET bearer token that requireCronSecret checks.

export const cronRouter = Router();

cronRouter.post("/cron/sync", requireCronSecret, async (_req, res) => {
  respond(res, cronSyncResponseSchema, await queueDailySyncs({ now: new Date() }));
});
