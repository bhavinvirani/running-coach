import {
  endPauseResponseSchema,
  pauseResponseSchema,
  startPauseRequestSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { endPause, getPause, startPause } from "../services/pause";

// "Not feeling 100%" on Today. No rate limit: a start or an end calls no one and only queues a workout
// push, which the stately queue folds into the one waiting.

export const pauseRouter = Router();

pauseRouter.get("/pause", async (req, res) => {
  respond(res, pauseResponseSchema, await getPause(req.user.id));
});

pauseRouter.post("/pause", async (req, res) => {
  const { reason } = parse(startPauseRequestSchema, req.body);
  respond(res, pauseResponseSchema, await startPause(req.user.id, reason));
});

pauseRouter.post("/pause/end", async (req, res) => {
  respond(res, endPauseResponseSchema, await endPause(req.user.id));
});
