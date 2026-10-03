import {
  calendarQuerySchema,
  calendarResponseSchema,
  garminPushResponseSchema,
  unscheduleGarminRequestSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { createRateLimiter, garminRouteLimit, limitPerUser } from "../lib/rate-limit";
import { getCalendar } from "../services/calendar";
import { requestWorkoutPush, unscheduleOthers } from "../services/workout-push";

export const calendarRouter = Router();

// A push queues a Garmin login and an unschedule makes one in the request: six a minute each, as for /sync.
export const calendarPushLimiter = createRateLimiter(garminRouteLimit);
export const calendarUnscheduleLimiter = createRateLimiter(garminRouteLimit);

calendarRouter.get("/calendar", async (req, res) => {
  const query = parse(calendarQuerySchema, req.query);
  respond(res, calendarResponseSchema, await getCalendar(req.user.id, query));
});

calendarRouter.post("/calendar/push", limitPerUser(calendarPushLimiter), async (req, res) => {
  respond(res, garminPushResponseSchema, await requestWorkoutPush(req.user.id));
});

calendarRouter.post(
  "/calendar/unschedule",
  limitPerUser(calendarUnscheduleLimiter),
  async (req, res) => {
    const { scheduleIds } = parse(unscheduleGarminRequestSchema, req.body);
    respond(res, garminPushResponseSchema, await unscheduleOthers(req.user.id, scheduleIds));
  },
);
