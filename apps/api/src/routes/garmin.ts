import { connectGarminRequestSchema, connectGarminResponseSchema } from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { createRateLimiter, garminRouteLimit, limitPerUser } from "../lib/rate-limit";
import { connectGarmin } from "../services/garmin-connection";

export const garminRouter = Router();

// Every connect is a Garmin login, the call Garmin rate-limits hardest; refused before Garmin is called.
export const connectGarminLimiter = createRateLimiter(garminRouteLimit);

garminRouter.put("/garmin/connection", limitPerUser(connectGarminLimiter), async (req, res) => {
  const { tokenBundle } = parse(connectGarminRequestSchema, req.body);
  respond(
    res,
    connectGarminResponseSchema,
    await connectGarmin({ userId: req.user.id, tokenBundle }),
  );
});
