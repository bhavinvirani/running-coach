import {
  type PlanGenerationInput,
  type PlanPaces,
  type PlanPhase,
  type PlanStatus,
  type PlanWarning,
  planPhaseSchema,
  planStatusSchema,
  type SessionStatus,
  type SessionSteps,
  type SessionTarget,
  type SessionType,
  sessionStatusSchema,
  sessionTypeSchema,
  type VdotSource,
} from "@running-coach/shared";
import { sql } from "drizzle-orm";
import {
  check,
  date,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { activity } from "./activity";
import { user } from "./auth";
import { id, inList, timestamps } from "./columns";
import { goal } from "./goal";

// Every plan a goal has had. Saving the goal makes the next version active and marks the previous one
// superseded; old versions keep their sessions and run links, so regenerating never loses history. Weeks
// are not stored: they are the sessions grouped by Monday from start_date, with each session's phase.

export const plan = pgTable(
  "plan",
  {
    id: id(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goal.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // 1 for the goal's first plan.
    version: smallint("version").notNull(),
    // The engine's version that generated it, so a rule change can tell which plans predate it.
    engineVersion: text("engine_version").notNull(),
    status: text("status").$type<PlanStatus>().notNull(),
    // Local dates: the first Monday, and the race day or a fitness plan's last Sunday.
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    vdot: doublePrecision("vdot").notNull(),
    vdotSource: jsonb("vdot_source").$type<VdotSource>().notNull(),
    paces: jsonb("paces").$type<PlanPaces>().notNull(),
    // Everything the engine was given, so the same plan can be generated again.
    inputs: jsonb("inputs").$type<PlanGenerationInput>().notNull(),
    warnings: jsonb("warnings").$type<PlanWarning[]>().notNull(),
    ...timestamps(),
  },
  (table) => [
    check("plan_status_check", sql`${table.status} in (${inList(planStatusSchema.options)})`),
    // Leads with goal_id, so it is also the goal_id index.
    unique("plan_goal_id_version_unique").on(table.goalId, table.version),
    index("plan_user_id_idx").on(table.userId),
    // At most one active plan per user: a second save racing the first fails instead of leaving two.
    uniqueIndex("plan_user_id_active_idx")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const planSession = pgTable(
  "plan_session",
  {
    id: id(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Local date in the runner's time zone.
    date: date("date", { mode: "string" }).notNull(),
    type: text("type").$type<SessionType>().notNull(),
    // Its week's phase; the plan's weeks are rebuilt from it.
    phase: text("phase").$type<PlanPhase>().notNull(),
    target: jsonb("target").$type<SessionTarget>().notNull(),
    steps: jsonb("steps").$type<SessionSteps>().notNull(),
    status: text("status").$type<SessionStatus>().notNull().default("planned"),
    // The run that completed it (slice 9). A deleted run leaves the session in place, unlinked.
    activityId: uuid("activity_id").references(() => activity.id, { onDelete: "set null" }),
    // Ids of what slice 7 pushed to Garmin, so a second push updates instead of duplicating.
    garminWorkoutId: text("garmin_workout_id"),
    garminScheduleId: text("garmin_schedule_id"),
    ...timestamps(),
  },
  (table) => [
    check("plan_session_type_check", sql`${table.type} in (${inList(sessionTypeSchema.options)})`),
    check("plan_session_phase_check", sql`${table.phase} in (${inList(planPhaseSchema.options)})`),
    check(
      "plan_session_status_check",
      sql`${table.status} in (${inList(sessionStatusSchema.options)})`,
    ),
    // A plan's sessions in date order; leads with plan_id, so it is also the plan_id index.
    index("plan_session_plan_id_date_idx").on(table.planId, table.date),
    index("plan_session_user_id_idx").on(table.userId),
    // Deleting a run nulls its sessions' link; without it that is a scan of every session.
    index("plan_session_activity_id_idx").on(table.activityId),
  ],
);

export type PlanRow = typeof plan.$inferSelect;
export type NewPlanRow = typeof plan.$inferInsert;
export type PlanSessionRow = typeof planSession.$inferSelect;
export type NewPlanSessionRow = typeof planSession.$inferInsert;
