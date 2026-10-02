import { z } from "zod";
import { goalInputSchema, goalSchema, raceDistanceKeySchema } from "./goal";

/**
 * What a day of the plan is. `rest` is a day with no session row: the web app labels empty days with it,
 * and the API never stores one. `strength` arrives in slice 11; the engine generates none yet.
 */
export const sessionTypeSchema = z.enum([
  "easy",
  "intervals",
  "tempo",
  "long",
  "race_practice",
  "race",
  "strength",
  "rest",
]);
export type SessionType = z.infer<typeof sessionTypeSchema>;

/**
 * Daniels' training intensities plus the goal race's own pace. A session names zones, never paces: the
 * plan carries one pace band per zone, from the runner's VDOT, so every session reads from the same table.
 */
export const paceZoneSchema = z.enum([
  "easy",
  "marathon",
  "threshold",
  "interval",
  "repetition",
  "race",
]);
export type PaceZone = z.infer<typeof paceZoneSchema>;

/** A pace band in seconds per kilometre, fast end first; the web app converts to the runner's units. */
export const paceBandSchema = z
  .object({
    fastSPerKm: z.number().int().positive(),
    slowSPerKm: z.number().int().positive(),
  })
  .strict()
  .refine(
    (band) => band.fastSPerKm <= band.slowSPerKm,
    "The fast end cannot be slower than the slow end",
  );
export type PaceBand = z.infer<typeof paceBandSchema>;

export const planPacesSchema = z
  .object({
    easy: paceBandSchema,
    marathon: paceBandSchema,
    threshold: paceBandSchema,
    interval: paceBandSchema,
    repetition: paceBandSchema,
    race: paceBandSchema,
  })
  .strict();
export type PlanPaces = z.infer<typeof planPacesSchema>;

export const stepKindSchema = z.enum(["warmup", "run", "work", "recovery", "cooldown"]);
export type StepKind = z.infer<typeof stepKindSchema>;

/** One block of a session, by distance or by time, never both; slice 7 turns it into a Garmin step. */
export const stepSchema = z
  .object({
    kind: stepKindSchema,
    zone: paceZoneSchema,
    distanceM: z.number().int().positive().nullable(),
    durationS: z.number().int().positive().nullable(),
  })
  .strict()
  .refine(
    (step) => (step.distanceM === null) !== (step.durationS === null),
    "A step is by distance or by time",
  );
export type Step = z.infer<typeof stepSchema>;

export const repeatSchema = z
  .object({
    repeat: z.number().int().min(2),
    steps: z.array(stepSchema).min(1),
  })
  .strict();
export type Repeat = z.infer<typeof repeatSchema>;

export const sessionStepsSchema = z.array(z.union([stepSchema, repeatSchema]));
export type SessionSteps = z.infer<typeof sessionStepsSchema>;

/** The session's headline: total distance and time over every step, and the zone its work is in. */
export const sessionTargetSchema = z
  .object({
    distanceM: z.number().int().nonnegative(),
    durationS: z.number().int().nonnegative(),
    zone: paceZoneSchema.nullable(),
  })
  .strict();
export type SessionTarget = z.infer<typeof sessionTargetSchema>;

export const sessionStatusSchema = z.enum(["planned", "done", "missed", "moved"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const planPhaseSchema = z.enum(["base", "build", "peak", "taper", "race"]);
export type PlanPhase = z.infer<typeof planPhaseSchema>;

/** A session as the engine emits it, before the API gives it a row. */
export const generatedSessionSchema = z
  .object({
    date: z.iso.date(),
    type: sessionTypeSchema,
    target: sessionTargetSchema,
    steps: sessionStepsSchema,
  })
  .strict();
export type GeneratedSession = z.infer<typeof generatedSessionSchema>;

export const planSessionSchema = generatedSessionSchema
  .extend({
    id: z.uuid(),
    status: sessionStatusSchema,
    /** The run that completed it, once slice 9 matches runs to sessions. */
    activityId: z.uuid().nullable(),
  })
  .strict();
export type PlanSession = z.infer<typeof planSessionSchema>;

const weekFieldsSchema = z.object({
  /** 1 for the plan's first week. */
  number: z.number().int().min(1),
  /** The week's Monday as a local date. */
  startDate: z.iso.date(),
  phase: planPhaseSchema,
  /** Sum of the sessions' target distances, the race included. */
  distanceM: z.number().int().nonnegative(),
});

export const generatedWeekSchema = weekFieldsSchema
  .extend({ sessions: z.array(generatedSessionSchema) })
  .strict();
export type GeneratedWeek = z.infer<typeof generatedWeekSchema>;

export const planWeekSchema = weekFieldsSchema
  .extend({ sessions: z.array(planSessionSchema) })
  .strict();
export type PlanWeek = z.infer<typeof planWeekSchema>;

/** Something the engine did its best with; the web app shows each one as a sentence above the weeks. */
export const planWarningSchema = z.discriminatedUnion("code", [
  /** The race leaves fewer weeks than the distance's minimum; the plan is the taper and what fits before it. */
  z
    .object({
      code: z.literal("race_date_close"),
      weeks: z.number().int().min(1),
      minimumWeeks: z.number().int().min(1),
    })
    .strict(),
  /** No runs in the baseline weeks: the plan starts from the floor volume instead of recent volume. */
  z
    .object({ code: z.literal("no_recent_runs"), startVolumeM: z.number().int().positive() })
    .strict(),
  /** The progression caps keep the peak long run under what the goal distance usually asks for. */
  z
    .object({
      code: z.literal("long_run_short"),
      peakLongRunM: z.number().int().positive(),
      requiredLongRunM: z.number().int().positive(),
    })
    .strict(),
  /** The target time is well ahead of what the recent time predicts; paces follow the prediction. */
  z
    .object({
      code: z.literal("target_time_ambitious"),
      targetTimeS: z.number().int().positive(),
      predictedTimeS: z.number().int().positive(),
    })
    .strict(),
]);
export type PlanWarning = z.infer<typeof planWarningSchema>;

/**
 * Why no plan can be made from this goal; nothing is saved. The web app turns each into a sentence with
 * the numbers and what to change. Never an error: the request was valid.
 */
export const planConflictSchema = z.discriminatedUnion("code", [
  /** The long run the distance needs would exceed the long-run share cap at this many runs a week. */
  z
    .object({
      code: z.literal("long_run_cap"),
      distanceKey: raceDistanceKeySchema,
      daysPerWeek: z.number().int().positive(),
      minDaysPerWeek: z.number().int().positive(),
    })
    .strict(),
  /** This many runs at the minimum run length is more than the 10% rule allows over the baseline. */
  z
    .object({
      code: z.literal("too_many_days"),
      daysPerWeek: z.number().int().positive(),
      maxDaysPerWeek: z.number().int().positive(),
      baselineWeeklyM: z.number().int().nonnegative(),
    })
    .strict(),
  /** The race is before the plan's first Monday. */
  z
    .object({
      code: z.literal("race_too_soon"),
      raceDate: z.iso.date(),
      earliestStart: z.iso.date(),
    })
    .strict(),
  /** No recent race, no best effort and no entered time: nothing to derive paces from. */
  z.object({ code: z.literal("no_recent_time") }).strict(),
]);
export type PlanConflict = z.infer<typeof planConflictSchema>;

export const vdotSourceOriginSchema = z.enum(["entered", "race", "best_effort"]);
export type VdotSourceOrigin = z.infer<typeof vdotSourceOriginSchema>;

/** The performance the paces come from: a typed-in time, a recorded race, or a best effort inside a run. */
export const vdotSourceSchema = z
  .object({
    origin: vdotSourceOriginSchema,
    distanceM: z.number().positive(),
    timeS: z.number().positive(),
    /** The run it came from, when recorded. */
    activityId: z.uuid().nullable(),
    /** Its local date, when recorded. */
    date: z.iso.date().nullable(),
  })
  .strict();
export type VdotSource = z.infer<typeof vdotSourceSchema>;

/** What the runner has been doing, measured by the API in the runner's time zone. */
export const planBaselineSchema = z
  .object({
    /** Running volume of the 4 Monday-to-Sunday weeks before the week that holds today, oldest first. */
    weeklyVolumesM: z.array(z.number().int().nonnegative()).length(4),
    /** The longest run of the last 30 days, 0 with none. */
    longestRunM: z.number().int().nonnegative(),
    /** Null when the runner has no runs on record. */
    daysSinceLastRun: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type PlanBaseline = z.infer<typeof planBaselineSchema>;

function isMonday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
}

/** Everything the engine needs; the API builds it and stores it on the plan so a plan can be regenerated. */
export const planGenerationInputSchema = z
  .object({
    goal: goalInputSchema,
    /** The plan's first Monday: the next one after today, or today when today is a Monday. */
    startDate: z.iso.date().refine(isMonday, "A plan starts on a Monday"),
    baseline: planBaselineSchema,
    vdotSource: vdotSourceSchema.nullable(),
  })
  .strict();
export type PlanGenerationInput = z.infer<typeof planGenerationInputSchema>;

export const generatedPlanSchema = z
  .object({
    engineVersion: z.string().min(1),
    startDate: z.iso.date(),
    /** The race day, or the last Sunday of a fitness plan. */
    endDate: z.iso.date(),
    vdot: z.number().positive(),
    paces: planPacesSchema,
    warnings: z.array(planWarningSchema),
    weeks: z.array(generatedWeekSchema).min(1),
  })
  .strict();
export type GeneratedPlan = z.infer<typeof generatedPlanSchema>;

/** The engine's answer: a plan, or the one conflict that stopped it. */
export const planGenerationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), plan: generatedPlanSchema }).strict(),
  z.object({ ok: z.literal(false), conflict: planConflictSchema }).strict(),
]);
export type PlanGenerationResult = z.infer<typeof planGenerationResultSchema>;

export const planStatusSchema = z.enum(["active", "superseded"]);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const planSchema = z
  .object({
    id: z.uuid(),
    goalId: z.uuid(),
    /** 1 for the goal's first plan; saving the goal again makes the next version and keeps the old one. */
    version: z.number().int().min(1),
    engineVersion: z.string().min(1),
    status: planStatusSchema,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    vdot: z.number().positive(),
    vdotSource: vdotSourceSchema,
    paces: planPacesSchema,
    warnings: z.array(planWarningSchema),
    weeks: z.array(planWeekSchema).min(1),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;

/** GET /api/plan: the goal and its active plan, both null until a goal is saved. */
export const planResponseSchema = z
  .object({
    goal: goalSchema.nullable(),
    plan: planSchema.nullable(),
  })
  .strict();
export type PlanResponse = z.infer<typeof planResponseSchema>;

/** PUT /api/goal: the saved goal with its new plan, or the conflict that kept the goal unsaved. */
export const saveGoalResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), goal: goalSchema, plan: planSchema }).strict(),
  z.object({ ok: z.literal(false), conflict: planConflictSchema }).strict(),
]);
export type SaveGoalResponse = z.infer<typeof saveGoalResponseSchema>;
