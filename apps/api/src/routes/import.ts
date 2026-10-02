import { importProgressSchema } from "@running-coach/shared";
import { Router } from "express";
import { respond } from "../lib/http";
import { createRateLimiter, limitPerUser } from "../lib/rate-limit";
import { getImportProgress, startImport } from "../services/history-import";

export const importRouter = Router();

// A start or resume queues a Garmin login; six a minute is far above a runner's taps, as for /sync.
export const importLimiter = createRateLimiter({ limit: 6, windowMs: 60_000 });

importRouter.get("/import", async (req, res) => {
  respond(res, importProgressSchema, await getImportProgress(req.user.id));
});

importRouter.post("/import", limitPerUser(importLimiter), async (req, res) => {
  respond(res, importProgressSchema, await startImport(req.user.id));
});
