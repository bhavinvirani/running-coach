import {
  type DistanceKey,
  distanceKeySchema,
  type GoalKind,
  goalKindSchema,
  type RaceDistanceKey,
  raceDistanceKeySchema,
  type Weekday,
  weekdaySchema,
} from "@running-coach/shared";
import { sql } from "drizzle-orm";
import { check, date, integer, pgTable, smallint, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { id, inList, timestamps } from "./columns";

// The runner's one goal. Saving it again overwrites this row and makes the next plan version, so the
// history lives in plan, not here. The entered recent time (goalInputSchema's recentTime) is two flat
// columns, null together or set together.

export const goal = pgTable(
  "goal",
  {
    id: id(),
    // unique() also gives user_id its index.
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<GoalKind>().notNull(),
    // Null for a fitness goal shaped like a 10K.
    distanceKey: text("distance_key").$type<RaceDistanceKey>(),
    // Local date; null for a fitness goal.
    raceDate: date("race_date", { mode: "string" }),
    targetTimeS: integer("target_time_s"),
    daysPerWeek: smallint("days_per_week").notNull(),
    longRunDay: text("long_run_day").$type<Weekday>().notNull(),
    recentDistanceKey: text("recent_distance_key").$type<DistanceKey>(),
    recentTimeS: integer("recent_time_s"),
    ...timestamps(),
  },
  (table) => [
    check("goal_kind_check", sql`${table.kind} in (${inList(goalKindSchema.options)})`),
    check(
      "goal_distance_key_check",
      sql`${table.distanceKey} in (${inList(raceDistanceKeySchema.options)})`,
    ),
    check(
      "goal_long_run_day_check",
      sql`${table.longRunDay} in (${inList(weekdaySchema.options)})`,
    ),
    check(
      "goal_recent_distance_key_check",
      sql`${table.recentDistanceKey} in (${inList(distanceKeySchema.options)})`,
    ),
    check(
      "goal_recent_time_check",
      sql`(${table.recentDistanceKey} is null) = (${table.recentTimeS} is null)`,
    ),
  ],
);

export type GoalRow = typeof goal.$inferSelect;
export type NewGoalRow = typeof goal.$inferInsert;
