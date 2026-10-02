import {
  activityWeeksQuerySchema,
  activityWeeksResponseSchema,
  latestActivityResponseSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { getLatestActivity, listActivityWeeks } from "../services/activities";

export const activitiesRouter = Router();

activitiesRouter.get("/activities/latest", async (req, res) => {
  respond(res, latestActivityResponseSchema, await getLatestActivity(req.user.id));
});

activitiesRouter.get("/activities", async (req, res) => {
  const query = parse(activityWeeksQuerySchema, req.query);
  respond(res, activityWeeksResponseSchema, await listActivityWeeks(req.user.id, query));
});
