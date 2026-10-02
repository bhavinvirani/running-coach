import { z } from "zod";
import { distanceKeySchema } from "../distances";

export const goalKindSchema = z.enum(["race", "fitness"]);
export type GoalKind = z.infer<typeof goalKindSchema>;

/** The distances a goal can target: the four road races the engine has plan shapes for. */
export const raceDistanceKeySchema = distanceKeySchema.extract(["5k", "10k", "half", "marathon"]);
export type RaceDistanceKey = z.infer<typeof raceDistanceKeySchema>;

/** Days as the plan and the long-run picker name them; weeks run Monday to Sunday. */
export const weekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof weekdaySchema>;

/** Fewer than 3 runs cannot hold a long run and a quality session 48 h apart; 7 leaves no rest day. */
export const DAYS_PER_WEEK_MIN = 3;
export const DAYS_PER_WEEK_MAX = 6;

/**
 * A recent race or time trial the runner types in. It overrides the recorded races and best efforts as
 * the source of the VDOT, and is the only source for a runner with no history.
 */
export const recentTimeSchema = z
  .object({
    distanceKey: distanceKeySchema,
    timeS: z.number().int().positive(),
  })
  .strict();
export type RecentTime = z.infer<typeof recentTimeSchema>;

const goalFieldsSchema = z
  .object({
    kind: goalKindSchema,
    /** The race distance; for a fitness goal, the distance the sessions are shaped around, or null for the 10K shape. */
    distanceKey: raceDistanceKeySchema.nullable(),
    /** The race day as a local date; null for a fitness goal. */
    raceDate: z.iso.date().nullable(),
    /** Optional finish time the runner wants; the engine warns when it is far ahead of the prediction. */
    targetTimeS: z.number().int().positive().nullable(),
    daysPerWeek: z.number().int().min(DAYS_PER_WEEK_MIN).max(DAYS_PER_WEEK_MAX),
    longRunDay: weekdaySchema,
    recentTime: recentTimeSchema.nullable(),
  })
  .strict();

/** PUT /api/goal body; responds with saveGoalResponseSchema. */
export const goalInputSchema = goalFieldsSchema.superRefine((goal, ctx) => {
  if (goal.kind === "race") {
    if (goal.distanceKey === null) {
      ctx.addIssue({ code: "custom", path: ["distanceKey"], message: "Pick a race distance" });
    }
    if (goal.raceDate === null) {
      ctx.addIssue({ code: "custom", path: ["raceDate"], message: "Pick a race date" });
    }
    return;
  }
  if (goal.raceDate !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["raceDate"],
      message: "A fitness goal has no race date",
    });
  }
  if (goal.targetTimeS !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["targetTimeS"],
      message: "A fitness goal has no target time",
    });
  }
});
export type GoalInput = z.infer<typeof goalInputSchema>;

/** The runner's one goal as stored: the input plus its row identity. */
export const goalSchema = goalFieldsSchema
  .extend({
    id: z.uuid(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type Goal = z.infer<typeof goalSchema>;
