import { goalInputSchema, planResponseSchema, saveGoalResponseSchema } from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { getPlan, saveGoal } from "../services/plan";

// The goal and its plan. No rate limit: neither route calls Garmin or Claude.

export const planRouter = Router();

planRouter.get("/plan", async (req, res) => {
  respond(res, planResponseSchema, await getPlan(req.user.id));
});

planRouter.put("/goal", async (req, res) => {
  const input = parse(goalInputSchema, req.body);
  respond(res, saveGoalResponseSchema, await saveGoal(req.user.id, input));
});
