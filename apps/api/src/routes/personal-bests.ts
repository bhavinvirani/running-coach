import { personalBestsResponseSchema } from "@running-coach/shared";
import { Router } from "express";
import { respond } from "../lib/http";
import { getPersonalBests } from "../services/best-efforts";

export const personalBestsRouter = Router();

// Reads stored rows only; the best-efforts job is what calls Garmin.
personalBestsRouter.get("/personal-bests", async (req, res) => {
  respond(res, personalBestsResponseSchema, await getPersonalBests(req.user.id));
});
