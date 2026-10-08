import {
  createShoeRequestSchema,
  shoeInputSchema,
  shoeParamsSchema,
  shoesResponseSchema,
} from "@running-coach/shared";
import { Router } from "express";
import { parse, respond } from "../lib/http";
import {
  activateShoe,
  createShoe,
  deleteShoe,
  listShoes,
  retireShoe,
  updateShoe,
} from "../services/shoes";

// Settings > Shoes. No rate limit: they read and write the database only. Every change answers the whole
// list, so the screen shows the new order and totals without a second request.

export const shoesRouter = Router();

shoesRouter.get("/shoes", async (req, res) => {
  respond(res, shoesResponseSchema, await listShoes(req.user.id));
});

shoesRouter.post("/shoes", async (req, res) => {
  const body = parse(createShoeRequestSchema, req.body);
  respond(res, shoesResponseSchema, await createShoe(req.user.id, body), 201);
});

shoesRouter.put("/shoes/:id", async (req, res) => {
  const { id } = parse(shoeParamsSchema, req.params);
  const input = parse(shoeInputSchema, req.body);
  respond(res, shoesResponseSchema, await updateShoe(req.user.id, id, input));
});

shoesRouter.delete("/shoes/:id", async (req, res) => {
  const { id } = parse(shoeParamsSchema, req.params);
  respond(res, shoesResponseSchema, await deleteShoe(req.user.id, id));
});

shoesRouter.post("/shoes/:id/active", async (req, res) => {
  const { id } = parse(shoeParamsSchema, req.params);
  respond(res, shoesResponseSchema, await activateShoe(req.user.id, id));
});

shoesRouter.post("/shoes/:id/retire", async (req, res) => {
  const { id } = parse(shoeParamsSchema, req.params);
  respond(res, shoesResponseSchema, await retireShoe(req.user.id, id));
});
