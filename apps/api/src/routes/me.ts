import {
  claudeKeyRequestSchema,
  meResponseSchema,
  updateSettingsRequestSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import { coachRouteLimit, createRateLimiter, limitPerUser } from "../lib/rate-limit";
import { removeClaudeKey, saveClaudeKey } from "../services/claude-key";
import { getMe, updateSettings } from "../services/settings";

export const meRouter = Router();

// Each save asks Claude about the key; refused before Claude is called.
export const claudeKeyLimiter = createRateLimiter(coachRouteLimit);

meRouter.get("/me", async (req, res) => {
  respond(res, meResponseSchema, await getMe(req.user.id));
});

meRouter.patch("/me/settings", async (req, res) => {
  const patch = parse(updateSettingsRequestSchema, req.body);
  respond(res, meResponseSchema, await updateSettings(req.user.id, patch));
});

meRouter.put("/me/claude-key", limitPerUser(claudeKeyLimiter), async (req, res) => {
  const { key } = parse(claudeKeyRequestSchema, req.body);
  respond(res, meResponseSchema, await saveClaudeKey(req.user.id, key));
});

meRouter.delete("/me/claude-key", async (req, res) => {
  respond(res, meResponseSchema, await removeClaudeKey(req.user.id));
});
