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

// A session of a plan version, or a custom workout the runner built (no plan_id and no phase): a custom
// one belongs to the runner, not to a plan version, so a new plan keeps it. The garmin_* columns are what
// Garmin holds for the session (services/workout-push.ts): ids stored as text, the date its workout is
// scheduled on, and the hash of the workout uploaded, so a push that finds them equal sends nothing.

export const planSession = pgTable(
  "plan_session",
  {
    id: id(),
    // Null for a custom workout.
    planId: uuid("plan_id").references(() => plan.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Local date in the runner's time zone.
    date: date("date", { mode: "string" }).notNull(),
    type: text("type").$type<SessionType>().notNull(),
    // Its week's phase; the plan's weeks are rebuilt from it. Null for a custom workout.
    phase: text("phase").$type<PlanPhase>(),
    // The runner's name for a custom workout; null names it by its type.
    title: text("title"),
    target: jsonb("target").$type<SessionTarget>().notNull(),
    steps: jsonb("steps").$type<SessionSteps>().notNull(),
    status: text("status").$type<SessionStatus>().notNull().default("planned"),
    // The run that completed it (slice 9). A deleted run leaves the session in place, unlinked.
    activityId: uuid("activity_id").references(() => activity.id, { onDelete: "set null" }),
    // Ids of what the push made on Garmin, so a second push updates instead of duplicating.
    garminWorkoutId: text("garmin_workout_id"),
    garminScheduleId: text("garmin_schedule_id"),
    // The local date Garmin has the workout scheduled on, null while it is not scheduled.
    garminDate: date("garmin_date", { mode: "string" }),
    // sha256 of the workout uploaded (services/workout-push-plan.ts); another hash means new content.
    garminHash: text("garmin_hash"),
    ...timestamps(),
  },
  (table) => [
    check("plan_session_type_check", sql`${table.type} in (${inList(sessionTypeSchema.options)})`),
    check("plan_session_phase_check", sql`${table.phase} in (${inList(planPhaseSchema.options)})`),
    check(
      "plan_session_status_check",
      sql`${table.status} in (${inList(sessionStatusSchema.options)})`,
    ),
    check("plan_session_custom_check", sql`(${table.planId} is null) = (${table.phase} is null)`),
    // A plan's sessions in date order; leads with plan_id, so it is also the plan_id index.
    index("plan_session_plan_id_date_idx").on(table.planId, table.date),
    // The runner's sessions by date (calendar, push window, custom workouts); leads with user_id, so it is
    // also the user_id index.
    index("plan_session_user_id_date_idx").on(table.userId, table.date),
    // Deleting a run nulls its sessions' link; without it that is a scan of every session.
    index("plan_session_activity_id_idx").on(table.activityId),
  ],
);

export type PlanRow = typeof plan.$inferSelect;
export type NewPlanRow = typeof plan.$inferInsert;
export type PlanSessionRow = typeof planSession.$inferSelect;
export type NewPlanSessionRow = typeof planSession.$inferInsert;
