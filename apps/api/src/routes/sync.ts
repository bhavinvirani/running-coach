import { syncResponseSchema } from "@running-coach/shared";
import { Router } from "express";
import { respond } from "../lib/http";
import { createRateLimiter, limitPerUser } from "../lib/rate-limit";
import { syncNow } from "../services/garmin-sync";

export const syncRouter = Router();

// Every Sync now is a Garmin login; six a minute is far above a runner's taps.
export const syncLimiter = createRateLimiter({ limit: 6, windowMs: 60_000 });

syncRouter.post("/sync", limitPerUser(syncLimiter), async (req, res) => {
  respond(res, syncResponseSchema, await syncNow({ userId: req.user.id }));
});
