import { type Express, Router } from "express";
import { requireUser } from "../auth/require-user";
import { notFoundHandler } from "../lib/errors";
import { healthRouter } from "./health";
import { meRouter } from "./me";

/**
 * Registers every router. /api/auth/* is served by Better Auth before this (src/app.ts). Public /api routes
 * (the cron endpoint in slice 5) go above requireUser; everything below it needs a session.
 */
export function registerRoutes(app: Express): void {
  app.use(healthRouter);

  const api = Router();
  api.use(requireUser);
  api.use(meRouter);
  api.use(notFoundHandler);
  app.use("/api", api);
}
