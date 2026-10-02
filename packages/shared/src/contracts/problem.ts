import { z } from "zod";
import { errorCodeSchema } from "../error-codes";

/** problem+json body returned by the API and the Garmin service for every error. */
export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: errorCodeSchema,
    detail: z.string().optional(),
    requestId: z.string().optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
    issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional(),
  })
  .strict();

export type Problem = z.infer<typeof problemSchema>;
