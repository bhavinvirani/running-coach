import {
  customSessionInputSchema,
  moveSessionRequestSchema,
  moveSessionResponseSchema,
  sessionDetailResponseSchema,
  sessionParamsSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import {
  createCustomSession,
  getSession,
  moveSession,
  skipSession,
  updateCustomSession,
} from "../services/sessions";

// One session of the runner's calendar. No rate limit: each change only queues a workout push, which the
// stately queue folds into the one waiting, so a burst of edits is still one Garmin login.

export const sessionsRouter = Router();

sessionsRouter.get("/sessions/:id", async (req, res) => {
  const { id } = parse(sessionParamsSchema, req.params);
  respond(res, sessionDetailResponseSchema, await getSession(req.user.id, id));
});

sessionsRouter.post("/sessions", async (req, res) => {
  const input = parse(customSessionInputSchema, req.body);
  respond(res, sessionDetailResponseSchema, await createCustomSession(req.user.id, input), 201);
});

sessionsRouter.put("/sessions/:id", async (req, res) => {
  const { id } = parse(sessionParamsSchema, req.params);
  const input = parse(customSessionInputSchema, req.body);
  respond(res, sessionDetailResponseSchema, await updateCustomSession(req.user.id, id, input));
});

sessionsRouter.post("/sessions/:id/move", async (req, res) => {
  const { id } = parse(sessionParamsSchema, req.params);
  const { date } = parse(moveSessionRequestSchema, req.body);
  respond(res, moveSessionResponseSchema, await moveSession(req.user.id, id, date));
});

sessionsRouter.delete("/sessions/:id", async (req, res) => {
  const { id } = parse(sessionParamsSchema, req.params);
  respond(res, sessionDetailResponseSchema, await skipSession(req.user.id, id));
});
