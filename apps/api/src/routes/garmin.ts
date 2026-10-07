import {
  connectGarminRequestSchema,
  connectGarminResponseSchema,
  disconnectGarminQuerySchema,
  disconnectGarminResponseSchema,
  finishGarminLoginRequestSchema,
  garminLoginConnectedSchema,
  startGarminLoginRequestSchema,
  startGarminLoginResponseSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { createRateLimiter, garminRouteLimit, limitPerUser } from "../lib/rate-limit";
import { disconnectGarmin } from "../services/garmin-disconnect";
import { connectGarmin } from "../services/garmin-connection";
import { finishGarminLogin, startGarminLogin } from "../services/garmin-login";

export const garminRouter = Router();

// Every connect is a Garmin login, the call Garmin rate-limits hardest, and a disconnect that removes the
// workouts is one too: one budget for all of them, refused before Garmin is called.
export const connectGarminLimiter = createRateLimiter(garminRouteLimit);
const limited = limitPerUser(connectGarminLimiter);

garminRouter.put("/garmin/connection", limited, async (req, res) => {
  const { tokenBundle } = parse(connectGarminRequestSchema, req.body);
  respond(
    res,
    connectGarminResponseSchema,
    await connectGarmin({ userId: req.user.id, tokenBundle }),
  );
});

garminRouter.post("/garmin/login", limited, async (req, res) => {
  const { email, password } = parse(startGarminLoginRequestSchema, req.body);
  respond(
    res,
    startGarminLoginResponseSchema,
    await startGarminLogin({ userId: req.user.id, email, password }),
  );
});

garminRouter.post("/garmin/login/code", limited, async (req, res) => {
  const { mfaCode } = parse(finishGarminLoginRequestSchema, req.body);
  respond(
    res,
    garminLoginConnectedSchema,
    await finishGarminLogin({ userId: req.user.id, mfaCode }),
  );
});

garminRouter.delete("/garmin/connection", limited, async (req, res) => {
  const { workouts } = parse(disconnectGarminQuerySchema, req.query);
  respond(
    res,
    disconnectGarminResponseSchema,
    await disconnectGarmin({ userId: req.user.id, workouts }),
  );
});
