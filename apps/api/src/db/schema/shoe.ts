import { DEFAULT_SHOE_RETIRE_DISTANCE_M } from "@running-coach/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { id, timestamps } from "./columns";

// The runner's pairs (slice 52). Kept in the app, not read from Garmin's gear. A pair's distance, runs and
// time are summed from the runs that wear it (activity.shoe_id) when read, never stored, so a re-synced or
// edited run never counts twice.

export const shoe = pgTable(
  "shoe",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    brand: text("brand").notNull(),
    model: text("model").notNull(),
    colour: text("colour"),
    nickname: text("nickname"),
    retireDistanceM: integer("retire_distance_m").notNull().default(DEFAULT_SHOE_RETIRE_DISTANCE_M),
    // Distance the pair had before the app counted its runs.
    startDistanceM: integer("start_distance_m").notNull().default(0),
    // The pair the sync puts on new runs.
    active: boolean("active").notNull().default(false),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    // The active index below is partial, so the cascade from user needs its own.
    index("shoe_user_id_idx").on(table.userId),
    // One active pair per user: two activations racing cannot leave two.
    uniqueIndex("shoe_user_id_active_idx")
      .on(table.userId)
      .where(sql`${table.active}`),
    check(
      "shoe_retired_not_active_check",
      sql`not (${table.active} and ${table.retiredAt} is not null)`,
    ),
  ],
);

export type ShoeRow = typeof shoe.$inferSelect;
export type NewShoeRow = typeof shoe.$inferInsert;
