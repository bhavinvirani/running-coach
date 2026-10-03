import { goalInputSchema, saveGoalResponseSchema } from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { saveGoal } from "../services/plan";

// The runner's goal: saving it makes the next plan version. No rate limit: it calls neither Garmin nor
// Claude.

export const goalRouter = Router();

goalRouter.put("/goal", async (req, res) => {
  const input = parse(goalInputSchema, req.body);
  respond(res, saveGoalResponseSchema, await saveGoal(req.user.id, input));
});
