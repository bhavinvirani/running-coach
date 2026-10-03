import { planResponseSchema } from "@running-coach/shared";
import { Router } from "express";
import { respond } from "../lib/http";
import { getPlan } from "../services/plan";

// The goal and its active plan. No rate limit: it calls neither Garmin nor Claude.

export const planRouter = Router();

planRouter.get("/plan", async (req, res) => {
  respond(res, planResponseSchema, await getPlan(req.user.id));
});
