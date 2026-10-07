import {
  type AdjustmentKind,
  type AdjustmentOutcome,
  type AdjustmentSource,
  adjustmentKindSchema,
  adjustmentOutcomeSchema,
  adjustmentSourceSchema,
  type DeltaRejection,
  deltaRejectionSchema,
  type PauseReason,
  type PlanDelta,
  pauseReasonSchema,
  type ReEntry,
  type SessionSnapshot,
  type SessionSteps,
} from "@running-coach/shared";
import { sql } from "drizzle-orm";
import { check, date, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { activity } from "./activity";
import { user } from "./auth";
import { coachMessage } from "./coach-message";
import { id, inList, timestamps } from "./columns";
import { planSession } from "./plan";

// Slice 9: how the plan adapts after it is made. Sessions change in place (no new plan version, which
// would re-create every workout on the watch), so plan_adjustment is the history of those changes.

// "Not feeling 100%": the runner's pauses, at most one open. Sessions from started_on on (not done) read
// paused; ending it skips those left in it and eases the return (plan_adjustment rows with source pause).
export const trainingPause = pgTable(
  "training_pause",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    reason: text("reason").$type<PauseReason>().notNull(),
    // Local dates in the runner's time zone: the day paused, and the day "I'm back" was tapped.
    startedOn: date("started_on", { mode: "string" }).notNull(),
    endedOn: date("ended_on", { mode: "string" }),
    ...timestamps(),
  },
  (table) => [
    // The open index below is partial, so the cascade from user needs its own.
    index("training_pause_user_id_idx").on(table.userId),
    // One open pause per user: a double tap on Sick cannot open two.
    uniqueIndex("training_pause_user_id_open_idx")
      .on(table.userId)
      .where(sql`${table.endedOn} is null`),
    check(
      "training_pause_reason_check",
      sql`${table.reason} in (${inList(pauseReasonSchema.options)})`,
    ),
    check(
      "training_pause_ended_on_check",
      sql`${table.endedOn} is null or ${table.endedOn} >= ${table.startedOn}`,
    ),
  ],
);

/** What a re-entry was asked to do, stored in requested and applied. */
export type ReEntryRequest = Pick<ReEntry, "factor" | "walkRun" | "daysOff">;
/** A session as it stood before or after a change, with its steps so the change can be shown or undone. */
export type AdjustedSession = SessionSnapshot & { steps: SessionSteps };

// Every change made to a session after its plan was made, and every coach proposal the engine rejected.
// The unique indexes make each writer idempotent: a sync or "I'm back" firing twice logs nothing new.
export const planAdjustment = pgTable(
  "plan_adjustment",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // The session changed; null for a coach proposal with no session to change (rejected no_session).
    planSessionId: uuid("plan_session_id").references(() => planSession.id, {
      onDelete: "cascade",
    }),
    source: text("source").$type<AdjustmentSource>().notNull(),
    kind: text("kind").$type<AdjustmentKind>().notNull(),
    outcome: text("outcome").$type<AdjustmentOutcome>().notNull(),
    // Why the engine rejected it; set exactly when outcome is rejected.
    reason: text("reason").$type<DeltaRejection>(),
    // The coach's delta as proposed, or the re-entry asked for.
    requested: jsonb("requested").$type<PlanDelta | ReEntryRequest>(),
    // The same after the engine clamped it; null when rejected.
    applied: jsonb("applied").$type<PlanDelta | ReEntryRequest>(),
    before: jsonb("before").$type<AdjustedSession>(),
    after: jsonb("after").$type<AdjustedSession>(),
    // The reviewed run (coach) or the run that ended the gap (gap); outlives the run, unlinked.
    activityId: uuid("activity_id").references(() => activity.id, { onDelete: "set null" }),
    // The insight that proposed it (coach).
    coachMessageId: uuid("coach_message_id").references(() => coachMessage.id, {
      onDelete: "set null",
    }),
    // The pause whose end eased the session (pause).
    pauseId: uuid("pause_id").references(() => trainingPause.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (table) => [
    index("plan_adjustment_user_id_idx").on(table.userId),
    index("plan_adjustment_plan_session_id_idx").on(table.planSessionId),
    index("plan_adjustment_activity_id_idx").on(table.activityId),
    // For the set null from coach_message and training_pause, whose deletes do not filter on source.
    index("plan_adjustment_coach_message_id_idx").on(table.coachMessageId),
    index("plan_adjustment_pause_id_idx").on(table.pauseId),
    // One coach proposal per run, rejected ones included: the insight job retrying applies nothing twice.
    uniqueIndex("plan_adjustment_coach_activity_id_idx")
      .on(table.activityId)
      .where(sql`${table.source} = 'coach'`),
    // One gap re-entry per session per run that ended the gap: a double sync is a no-op.
    uniqueIndex("plan_adjustment_gap_activity_id_session_idx")
      .on(table.activityId, table.planSessionId)
      .where(sql`${table.source} = 'gap'`),
    // One pause re-entry per session per pause: a double "I'm back" is a no-op.
    uniqueIndex("plan_adjustment_pause_id_session_idx")
      .on(table.pauseId, table.planSessionId)
      .where(sql`${table.source} = 'pause'`),
    check(
      "plan_adjustment_source_check",
      sql`${table.source} in (${inList(adjustmentSourceSchema.options)})`,
    ),
    check(
      "plan_adjustment_kind_check",
      sql`${table.kind} in (${inList(adjustmentKindSchema.options)})`,
    ),
    check(
      "plan_adjustment_outcome_check",
      sql`${table.outcome} in (${inList(adjustmentOutcomeSchema.options)})`,
    ),
    check(
      "plan_adjustment_reason_check",
      sql`${table.reason} in (${inList(deltaRejectionSchema.options)})`,
    ),
    check(
      "plan_adjustment_rejected_reason_check",
      sql`(${table.outcome} = 'rejected') = (${table.reason} is not null)`,
    ),
  ],
);

export type TrainingPauseRow = typeof trainingPause.$inferSelect;
export type NewTrainingPauseRow = typeof trainingPause.$inferInsert;
export type PlanAdjustmentRow = typeof planAdjustment.$inferSelect;
export type NewPlanAdjustmentRow = typeof planAdjustment.$inferInsert;
