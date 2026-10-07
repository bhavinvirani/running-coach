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

/** The longest step anyone runs: 100 km or 6 hours. Caps what a custom workout can ask of the watch. */
export const STEP_MAX_DISTANCE_M = 100_000;
export const STEP_MAX_DURATION_S = 6 * 3600;
/** Garmin's repeat count tops out well above this; past 50 a runner means a different workout. */
export const REPEAT_MAX = 50;
export const REPEAT_STEPS_MAX = 10;

/**
 * One block of a session, by distance or by time, never both. The engine's `garminWorkout` turns it into
 * a Garmin step: run and work steps carry their zone's pace band, the others go out without a target.
 */
export const stepSchema = z
  .object({
    kind: stepKindSchema,
    zone: paceZoneSchema,
    distanceM: z.number().int().positive().max(STEP_MAX_DISTANCE_M).nullable(),
    durationS: z.number().int().positive().max(STEP_MAX_DURATION_S).nullable(),
  })
  .strict()
  .refine(
    (step) => (step.distanceM === null) !== (step.durationS === null),
    "A step is by distance or by time",
  );
export type Step = z.infer<typeof stepSchema>;

export const repeatSchema = z
  .object({
    repeat: z.number().int().min(2).max(REPEAT_MAX),
    steps: z.array(stepSchema).min(1).max(REPEAT_STEPS_MAX),
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

/**
 * planned: as the engine or the runner made it. moved: planned, then moved by the runner to another day
 * of its week. skipped: dropped by the runner, by the coach (a rest), or by a pause, never made up (a
 * custom one is hidden instead). done: a run on its local date completed it. missed: its date passed with
 * no run; it stays on that date and is never rescheduled.
 */
export const sessionStatusSchema = z.enum(["planned", "done", "missed", "moved", "skipped"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * plan: a session of a plan version, replaced when the goal is saved again. custom: a workout the runner
 * built; it belongs to the runner, not to a plan version, so a new plan keeps it.
 */
export const sessionSourceSchema = z.enum(["plan", "custom"]);
export type SessionSource = z.infer<typeof sessionSourceSchema>;

export const planPhaseSchema = z.enum(["base", "build", "peak", "taper", "race"]);
export type PlanPhase = z.infer<typeof planPhaseSchema>;

export const SESSION_TITLE_MAX = 60;

/**
 * The one place a session type becomes a word: the web app's chips and the workout name on the watch both
 * read it, so the two never disagree.
 */
export const SESSION_TYPE_NAMES: Readonly<Record<SessionType, string>> = {
  easy: "Easy",
  intervals: "Intervals",
  tempo: "Tempo",
  long: "Long run",
  race_practice: "Race practice",
  race: "Race",
  strength: "Strength",
  rest: "Rest",
};

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

/**
 * Who changed a session after the plan was made. coach: the coach's proposal after a run, as the engine
 * accepted or clamped it. pause: the re-entry when the runner ended a pause. gap: the re-entry after a run
 * that followed 7 or more days without one, with no pause.
 */
export const adjustmentSourceSchema = z.enum(["coach", "pause", "gap"]);
export type AdjustmentSource = z.infer<typeof adjustmentSourceSchema>;

/**
 * scale: shorter or longer by a factor (a quality session loses reps instead). easy: a quality session
 * turned into an easy run of the same time. rest: the session skipped. re_entry: eased for the return after
 * time off, with walk-run in the first week after illness or injury.
 */
export const adjustmentKindSchema = z.enum(["scale", "easy", "rest", "re_entry"]);
export type AdjustmentKind = z.infer<typeof adjustmentKindSchema>;

/**
 * A change proposed for one session; `validateDelta` in the engine accepts, clamps or rejects it. A scale's
 * factor is the share of the planned session, unbounded here because the engine clamps it to its caps.
 */
export const planDeltaSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scale"), factor: z.number() }).strict(),
  z.object({ kind: z.literal("easy") }).strict(),
  z.object({ kind: z.literal("rest") }).strict(),
]);
export type PlanDelta = z.infer<typeof planDeltaSchema>;

/**
 * Why a proposed change was dropped. race: a race is never changed. custom: the runner's own workouts
 * stay as built. locked: past, done, missed or skipped. adjusted: the coach already changed this session.
 * paused: training is paused. stale_run: only the newest run of the last 7 days may change the plan.
 * no_session: nothing is planned after the run. no_change: the change would leave the session as it is.
 * invalid: a scale without a usable factor.
 */
export const deltaRejectionSchema = z.enum([
  "race",
  "custom",
  "locked",
  "adjusted",
  "paused",
  "stale_run",
  "no_session",
  "no_change",
  "invalid",
]);
export type DeltaRejection = z.infer<typeof deltaRejectionSchema>;

/** applied: as proposed. clamped: applied after the engine pulled it inside its caps. rejected: dropped. */
export const adjustmentOutcomeSchema = z.enum(["applied", "clamped", "rejected"]);
export type AdjustmentOutcome = z.infer<typeof adjustmentOutcomeSchema>;

/** A session as it stood before or after a change: enough to say "Tempo 8.0 km → Easy 6.4 km". */
export const sessionSnapshotSchema = z
  .object({
    type: sessionTypeSchema,
    title: z.string().min(1).max(SESSION_TITLE_MAX).nullable(),
    status: sessionStatusSchema,
    target: sessionTargetSchema,
  })
  .strict();
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

/** The latest change made to a session since its plan was made. */
export const sessionAdjustmentSchema = z
  .object({
    source: adjustmentSourceSchema,
    kind: adjustmentKindSchema,
    /** The run that prompted it: the reviewed run (coach) or the run that ended the gap; null for a pause. */
    activityId: z.uuid().nullable(),
    /** The session as the plan had it before its first change. */
    original: sessionSnapshotSchema,
    at: z.iso.datetime(),
  })
  .strict();
export type SessionAdjustment = z.infer<typeof sessionAdjustmentSchema>;

/** One session the coach changed after a run, as the engine applied it: shown on the run's coach card. */
export const planChangeSchema = z
  .object({
    sessionId: z.uuid(),
    date: z.iso.date(),
    kind: adjustmentKindSchema,
    /** The engine pulled the proposal inside its caps. */
    clamped: z.boolean(),
    before: sessionSnapshotSchema,
    after: sessionSnapshotSchema,
  })
  .strict();
export type PlanChange = z.infer<typeof planChangeSchema>;

export const planSessionSchema = generatedSessionSchema
  .extend({
    id: z.uuid(),
    status: sessionStatusSchema,
    source: sessionSourceSchema,
    /** The runner's name for a custom workout, or the engine's for a changed one ("Walk-run"); null names it by its type. */
    title: z.string().min(1).max(SESSION_TITLE_MAX).nullable(),
    /** The run that completed it (status done). */
    activityId: z.uuid().nullable(),
    /** The latest change the coach or a re-entry made to it; null while it is as planned. */
    adjustment: sessionAdjustmentSchema.nullable(),
    /**
     * On or after the start of the runner's open pause and not done: off the watch, and skipped when the
     * pause ends.
     */
    paused: z.boolean(),
    /**
     * True when Garmin holds this session as it is now: its workout uploaded with the current steps and
     * paces, and scheduled on its date. The push status (calendar.ts) says why one in the window is not.
     */
    onGarmin: z.boolean(),
  })
  .strict();
export type PlanSession = z.infer<typeof planSessionSchema>;

const weekFieldsSchema = z.object({
  /** 1 for the plan's first week. */
  number: z.number().int().min(1),
  /** The week's Monday as a local date. */
  startDate: z.iso.date(),
  phase: planPhaseSchema,
  /** Sum of the target distances of the week's sessions that are not skipped, custom ones and the race included. */
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

/** The longest plan the engine makes: past a year the baseline is stale before the build starts. The form caps the race date with it. */
export const MAX_PLAN_WEEKS = 52;

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
  /** Recent volume is under what the requested days need: week 1 is lifted to the smallest week that holds them. */
  z
    .object({
      code: z.literal("start_volume_lifted"),
      recentWeeklyM: z.number().int().nonnegative(),
      startVolumeM: z.number().int().positive(),
    })
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
  /**
   * The smallest week that holds a 20 min run on this many days, beside the long run and the quality
   * sessions, is more than 10% above the runner's recent volume; fewer days would fit.
   */
  z
    .object({
      code: z.literal("too_many_days"),
      daysPerWeek: z.number().int().positive(),
      maxDaysPerWeek: z.number().int().positive(),
      /** The runner's recent weekly volume the 10% applies to. */
      recentWeeklyM: z.number().int().nonnegative(),
      /** The smallest week this many days need. */
      neededWeeklyM: z.number().int().positive(),
    })
    .strict(),
  /** The race is further out than the longest plan the engine makes. */
  z
    .object({
      code: z.literal("race_too_far"),
      raceDate: z.iso.date(),
      latestRaceDate: z.iso.date(),
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
