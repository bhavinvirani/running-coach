import { z } from "zod";

// What the coach returns for one run, and the shape of its fallback card. Small and flat so structured
// outputs can hold it; the SDK drops the length limits from the JSON Schema it sends and we check them
// here (schema.safeParse in coach/client.ts).

export const runInsightCautionSchema = z.enum(["none", "easy_next", "rest_and_check"]);

export const runInsightSchema = z
  .object({
    /** One sentence with the run's main number. */
    headline: z.string().min(1).max(120),
    whatHappened: z.string().min(1).max(400),
    whatItMeans: z.string().min(1).max(400),
    nextStep: z.string().min(1).max(400),
    /** easy_next: the next run should be easy. rest_and_check: rest, and see a professional if it persists. */
    caution: runInsightCautionSchema,
  })
  .strict();

export type RunInsight = z.infer<typeof runInsightSchema>;
