import { meResponseSchema, updateSettingsRequestSchema } from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { getMe, updateSettings } from "../services/settings";

export const meRouter = Router();

meRouter.get("/me", async (req, res) => {
  respond(res, meResponseSchema, await getMe(req.user.id));
});

meRouter.patch("/me/settings", async (req, res) => {
  const patch = parse(updateSettingsRequestSchema, req.body);
  respond(res, meResponseSchema, await updateSettings(req.user.id, patch));
});
