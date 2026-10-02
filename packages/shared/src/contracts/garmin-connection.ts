import { z } from "zod";
import { garminTokenBundleSchema } from "./garmin";

/**
 * PUT /api/garmin/connection: the bundle `pnpm garmin:connect` gets from a fresh Garmin login on the
 * runner's laptop. The API proves it with one Garmin call, then stores it encrypted; it never comes back out.
 */
export const connectGarminRequestSchema = z
  .object({ tokenBundle: garminTokenBundleSchema })
  .strict();
export type ConnectGarminRequest = z.infer<typeof connectGarminRequestSchema>;

export const connectGarminResponseSchema = z
  .object({
    /** Garmin's display name for the account, often an opaque handle; null when Garmin has none. */
    displayName: z.string().nullable(),
  })
  .strict();
export type ConnectGarminResponse = z.infer<typeof connectGarminResponseSchema>;
