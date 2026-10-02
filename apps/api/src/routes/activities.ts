import {
  activityParamsSchema,
  activityResponseSchema,
  activityWeeksQuerySchema,
  activityWeeksResponseSchema,
  latestActivityResponseSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { createRateLimiter, limitPerUser } from "../lib/rate-limit";
import { getLatestActivity, listActivityWeeks } from "../services/activities";
import { fetchActivityDetail, getActivity } from "../services/activity-detail";

export const activitiesRouter = Router();

// Fetching a run's detail is a Garmin login, as Sync now is; six a minute is far above a runner's taps.
export const activityDetailLimiter = createRateLimiter({ limit: 6, windowMs: 60_000 });

// Before /activities/:id, which would read "latest" as an id and fail its uuid check.
activitiesRouter.get("/activities/latest", async (req, res) => {
  respond(res, latestActivityResponseSchema, await getLatestActivity(req.user.id));
});

activitiesRouter.get("/activities", async (req, res) => {
  const query = parse(activityWeeksQuerySchema, req.query);
  respond(res, activityWeeksResponseSchema, await listActivityWeeks(req.user.id, query));
});

activitiesRouter.get("/activities/:id", async (req, res) => {
  const { id } = parse(activityParamsSchema, req.params);
  respond(res, activityResponseSchema, await getActivity(req.user.id, id));
});

activitiesRouter.post(
  "/activities/:id/detail",
  limitPerUser(activityDetailLimiter),
  async (req, res) => {
    const { id } = parse(activityParamsSchema, req.params);
    respond(res, activityResponseSchema, await fetchActivityDetail(req.user.id, id));
  },
);
