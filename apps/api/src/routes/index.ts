import { type Express, Router } from "express";
import { requireUser } from "../auth/require-user";
import { notFoundHandler } from "../lib/errors";
import { activitiesRouter } from "./activities";
import { calendarRouter } from "./calendar";
import { cronRouter } from "./cron";
import { garminRouter } from "./garmin";
import { goalRouter } from "./goal";
import { healthRouter } from "./health";
import { importRouter } from "./import";
import { insightsRouter } from "./insights";
import { meRouter } from "./me";
import { personalBestsRouter } from "./personal-bests";
import { planRouter } from "./plan";
import { sessionsRouter } from "./sessions";
import { syncRouter } from "./sync";

/**
 * Registers every router. /api/auth/* is served by Better Auth before this (src/app.ts). Public /api routes
 * go above requireUser: only POST /api/cron/sync, behind its own bearer secret. Everything below it needs a
 * session, unknown /api paths included.
 */
export function registerRoutes(app: Express): void {
  app.use(healthRouter);

  const api = Router();
  api.use(cronRouter);
  api.use(requireUser);
  api.use(meRouter);
  api.use(garminRouter);
  api.use(syncRouter);
  api.use(activitiesRouter);
  api.use(insightsRouter);
  api.use(importRouter);
  api.use(personalBestsRouter);
  api.use(goalRouter);
  api.use(planRouter);
  api.use(sessionsRouter);
  api.use(calendarRouter);
  api.use(notFoundHandler);
  app.use("/api", api);
}
