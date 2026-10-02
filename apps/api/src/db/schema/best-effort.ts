import { type DistanceKey, distanceKeySchema } from "@running-coach/shared";
import { sql } from "drizzle-orm";
import { check, doublePrecision, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { activity } from "./activity";
import { user } from "./auth";
import { id, inList, timestamps } from "./columns";

// Each outdoor run's fastest continuous stretch at every known distance it reaches, from Garmin's 1 s
// series (services/best-efforts.ts). A personal best is the fastest row per distance, a query, so a run
// deleted or excluded later takes its bests with it. The samples themselves are never stored.

export const bestEffort = pgTable(
  "best_effort",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activity.id, { onDelete: "cascade" }),
    distanceKey: text("distance_key").$type<DistanceKey>().notNull(),
    // Timer seconds, unrounded: the engine interpolates between samples.
    timeS: doublePrecision("time_s").notNull(),
    // Timer seconds into the run where the effort starts.
    startS: doublePrecision("start_s").notNull(),
    ...timestamps(),
  },
  (table) => [
    check(
      "best_effort_distance_key_check",
      sql`${table.distanceKey} in (${inList(distanceKeySchema.options)})`,
    ),
    // One effort per run and distance; leads with activity_id, so it is also the activity_id index.
    unique("best_effort_activity_id_distance_key_unique").on(table.activityId, table.distanceKey),
    // The personal-bests query: a user's fastest per distance. Leads with user_id, so it is also the
    // user_id index.
    index("best_effort_user_id_distance_key_time_s_idx").on(
      table.userId,
      table.distanceKey,
      table.timeS,
    ),
  ],
);

export type BestEffortRow = typeof bestEffort.$inferSelect;
