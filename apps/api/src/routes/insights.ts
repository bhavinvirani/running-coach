import {
  activityParamsSchema,
  insightFeedbackRequestSchema,
  insightParamsSchema,
  insightResponseSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { coachRouteLimit, createRateLimiter, limitPerUser } from "../lib/rate-limit";
import { askCoach, getInsight, setInsightFeedback } from "../services/insights";

export const insightsRouter = Router();

// Each ask queues a Claude call on the runner's key.
export const askCoachLimiter = createRateLimiter(coachRouteLimit);

insightsRouter.get("/activities/:id/insight", async (req, res) => {
  const { id } = parse(activityParamsSchema, req.params);
  respond(res, insightResponseSchema, await getInsight(req.user.id, id));
});

insightsRouter.post("/activities/:id/insight", limitPerUser(askCoachLimiter), async (req, res) => {
  const { id } = parse(activityParamsSchema, req.params);
  respond(res, insightResponseSchema, await askCoach(req.user.id, id));
});

insightsRouter.put("/insights/:id/feedback", async (req, res) => {
  const { id } = parse(insightParamsSchema, req.params);
  const { feedback } = parse(insightFeedbackRequestSchema, req.body);
  respond(res, insightResponseSchema, await setInsightFeedback(req.user.id, id, feedback));
});
