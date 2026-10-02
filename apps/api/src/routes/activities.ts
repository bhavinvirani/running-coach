import { latestActivityResponseSchema } from "@running-coach/shared";
import { Router } from "express";
import { respond } from "../lib/http";
import { getLatestActivity } from "../services/activities";

export const activitiesRouter = Router();

activitiesRouter.get("/activities/latest", async (req, res) => {
  respond(res, latestActivityResponseSchema, await getLatestActivity(req.user.id));
});
