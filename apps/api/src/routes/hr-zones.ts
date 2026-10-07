import { hrZonesResponseSchema, hrZonesSchema } from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { getHrZones, resetHrZones, saveHrZones } from "../services/hr-zones";

// Settings' heart-rate zones. No rate limit: they read and write the database only.

export const hrZonesRouter = Router();

hrZonesRouter.get("/hr-zones", async (req, res) => {
  respond(res, hrZonesResponseSchema, await getHrZones(req.user.id));
});

hrZonesRouter.put("/hr-zones", async (req, res) => {
  const zones = parse(hrZonesSchema, req.body);
  respond(res, hrZonesResponseSchema, await saveHrZones(req.user.id, zones));
});

// Reset to Garmin's.
hrZonesRouter.delete("/hr-zones", async (req, res) => {
  respond(res, hrZonesResponseSchema, await resetHrZones(req.user.id));
});
