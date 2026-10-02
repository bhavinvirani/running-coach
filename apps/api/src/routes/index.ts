import { type Express, Router } from "express";
import { requireUser } from "../auth/require-user";
import { notFoundHandler } from "../lib/errors";
import { activitiesRouter } from "./activities";
import { garminRouter } from "./garmin";
import { healthRouter } from "./health";
import { importRouter } from "./import";
import { meRouter } from "./me";
import { personalBestsRouter } from "./personal-bests";
import { syncRouter } from "./sync";

/**
 * Registers every router. /api/auth/* is served by Better Auth before this (src/app.ts). Public /api routes
 * (the cron endpoint in slice 5) go above requireUser; everything below it needs a session.
 */
export function registerRoutes(app: Express): void {
  app.use(healthRouter);

  const api = Router();
  api.use(requireUser);
  api.use(meRouter);
  api.use(garminRouter);
  api.use(syncRouter);
  api.use(activitiesRouter);
  api.use(importRouter);
  api.use(personalBestsRouter);
  api.use(notFoundHandler);
  app.use("/api", api);
}
