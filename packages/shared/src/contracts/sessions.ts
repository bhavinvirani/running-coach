import { z } from "zod";
import {
  type Repeat,
  type SessionSteps,
  type Step,
  SESSION_TITLE_MAX,
  planPacesSchema,
  planSessionSchema,
  sessionStepsSchema,
  sessionTypeSchema,
} from "./plan";
import { garminPushStatusSchema } from "./calendar";

/** Garmin counts a plain step as one and a repeat as one plus its steps; a workout holds at most 50. */
export const GARMIN_WORKOUT_STEPS_MAX = 50;

export function garminStepCount(steps: SessionSteps): number {
  return steps.reduce(
    (sum, item: Step | Repeat) => sum + ("repeat" in item ? 1 + item.steps.length : 1),
    0,
  );
}

/** The types a runner can build: running sessions only (no race, rest or strength). */
export const customSessionTypeSchema = sessionTypeSchema.extract([
  "easy",
  "intervals",
  "tempo",
  "long",
  "race_practice",
]);
export type CustomSessionType = z.infer<typeof customSessionTypeSchema>;

/**
 * POST /api/sessions and PUT /api/sessions/:id (custom workouts only): a workout the runner builds, on a
 * local date from today on. Its steps name the active plan's zones, so it needs an active plan
 * (plan_missing otherwise); the API works out its target with the engine.
 */
export const customSessionInputSchema = z
  .object({
    date: z.iso.date(),
    type: customSessionTypeSchema,
    title: z.string().trim().min(1).max(SESSION_TITLE_MAX).nullable(),
    steps: sessionStepsSchema
      .min(1)
      .refine(
        (steps) => garminStepCount(steps) <= GARMIN_WORKOUT_STEPS_MAX,
        `A workout holds at most ${GARMIN_WORKOUT_STEPS_MAX} steps, a repeat counting one plus its steps`,
      ),
  })
  .strict();
export type CustomSessionInput = z.infer<typeof customSessionInputSchema>;

export const sessionParamsSchema = z.object({ id: z.uuid() }).strict();
export type SessionParams = z.infer<typeof sessionParamsSchema>;

/**
 * GET /api/sessions/:id, and the answer to every session change: the session, the paces its zones read
 * (from the active plan; a superseded plan's session reads its own), and where Garmin is with the push.
 */
export const sessionDetailResponseSchema = z
  .object({
    session: planSessionSchema,
    paces: planPacesSchema,
    garmin: garminPushStatusSchema,
  })
  .strict();
export type SessionDetailResponse = z.infer<typeof sessionDetailResponseSchema>;

/** POST /api/sessions/:id/move: another day of the session's Monday-to-Sunday week, from today on. */
export const moveSessionRequestSchema = z.object({ date: z.iso.date() }).strict();
export type MoveSessionRequest = z.infer<typeof moveSessionRequestSchema>;

/**
 * A move is the runner's call and is never refused for its spacing; it answers this when it leaves two
 * hard sessions within the engine's 48 h, so the web app can say so.
 */
export const moveWarningSchema = z
  .object({
    code: z.literal("hard_days_close"),
    /** The hard session the moved one now sits too close to. */
    otherType: sessionTypeSchema,
    otherDate: z.iso.date(),
  })
  .strict();
export type MoveWarning = z.infer<typeof moveWarningSchema>;

export const moveSessionResponseSchema = sessionDetailResponseSchema
  .extend({ warning: moveWarningSchema.nullable() })
  .strict();
export type MoveSessionResponse = z.infer<typeof moveSessionResponseSchema>;
