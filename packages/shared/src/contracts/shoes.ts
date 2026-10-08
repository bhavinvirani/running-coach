import { z } from "zod";

/** A new pair's retire goal: 650 km, about where running shoes lose their cushioning. */
export const DEFAULT_SHOE_RETIRE_DISTANCE_M = 650_000;
export const MIN_SHOE_RETIRE_DISTANCE_M = 50_000;
export const MAX_SHOE_RETIRE_DISTANCE_M = 5_000_000;
/** The most a pair may carry from before the app. */
export const MAX_SHOE_START_DISTANCE_M = 5_000_000;
export const SHOE_TEXT_MAX = 40;

const requiredTextSchema = z.string().trim().min(1).max(SHOE_TEXT_MAX);
/** Blank is null: the web app sends null for an empty field. */
const optionalTextSchema = requiredTextSchema.nullable();

/**
 * What the runner types for a pair (POST /api/shoes, PUT /api/shoes/:id). Distances in meters: the web app
 * converts from km or mi.
 */
export const shoeInputSchema = z
  .object({
    brand: requiredTextSchema,
    model: requiredTextSchema,
    colour: optionalTextSchema,
    nickname: optionalTextSchema,
    retireDistanceM: z
      .number()
      .int()
      .min(MIN_SHOE_RETIRE_DISTANCE_M)
      .max(MAX_SHOE_RETIRE_DISTANCE_M),
    /** Distance the pair already had before the app counted its runs. */
    startDistanceM: z.number().int().min(0).max(MAX_SHOE_START_DISTANCE_M),
  })
  .strict();
export type ShoeInput = z.infer<typeof shoeInputSchema>;

/** POST /api/shoes: active makes the new pair the one the sync puts on new runs. */
export const createShoeRequestSchema = shoeInputSchema.extend({ active: z.boolean() }).strict();
export type CreateShoeRequest = z.infer<typeof createShoeRequestSchema>;

export const shoeParamsSchema = z.object({ id: z.uuid() }).strict();
export type ShoeParams = z.infer<typeof shoeParamsSchema>;

/**
 * One pair with its totals. distanceM is startDistanceM plus the distance of the runs that wear it; runs
 * and durationS count those runs alone. Summed when read, so a re-synced or edited run never counts twice.
 */
export const shoeSchema = z
  .object({
    id: z.uuid(),
    brand: z.string().min(1),
    model: z.string().min(1),
    colour: z.string().min(1).nullable(),
    nickname: z.string().min(1).nullable(),
    retireDistanceM: z.number().int().positive(),
    startDistanceM: z.number().int().nonnegative(),
    /** The pair the sync puts on new runs; at most one per runner, never a retired one. */
    active: z.boolean(),
    retiredAt: z.iso.datetime().nullable(),
    distanceM: z.number().nonnegative(),
    runs: z.number().int().nonnegative(),
    durationS: z.number().nonnegative(),
  })
  .strict();
export type Shoe = z.infer<typeof shoeSchema>;

/**
 * GET /api/shoes, and the answer to every change of a pair (POST /api/shoes, PUT and DELETE
 * /api/shoes/:id, POST /api/shoes/:id/active and /retire): every pair, the active one first, then the
 * pairs in use newest first, then the retired ones, latest retired first.
 */
export const shoesResponseSchema = z.object({ shoes: z.array(shoeSchema) }).strict();
export type ShoesResponse = z.infer<typeof shoesResponseSchema>;

/**
 * PUT /api/activities/:id/shoe, and its answer: the pair the run wore, null for none. Any pair of the
 * runner's, a retired one too, since an old run may have worn it.
 */
export const activityShoeSchema = z.object({ shoeId: z.uuid().nullable() }).strict();
export type ActivityShoe = z.infer<typeof activityShoeSchema>;
