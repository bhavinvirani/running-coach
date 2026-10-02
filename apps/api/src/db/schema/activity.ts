import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { id, timestamps } from "./columns";

// One row per Garmin run, upserted by the sync on (user_id, garmin_activity_id), so a run synced twice
// or edited on Garmin stays one row. SI units; the UI converts with the user's settings.

export const activity = pgTable(
  "activity",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Garmin ids pass 2^31 but stay far below 2^53, so number mode is exact.
    garminActivityId: bigint("garmin_activity_id", { mode: "number" }).notNull(),
    // Garmin's activityType.typeKey: running, treadmill_running, trail_running, ...
    type: text("type").notNull(),
    startUtc: timestamp("start_utc", { withTimezone: true }).notNull(),
    // Wall-clock start in the activity's own zone, kept as Garmin's string so no zone math touches it.
    startLocal: timestamp("start_local", { mode: "string" }).notNull(),
    // IANA zone; the activity list has none, the detail call fills it later.
    tz: text("tz"),
    distanceM: doublePrecision("distance_m").notNull(),
    durationS: doublePrecision("duration_s").notNull(),
    // Null when the run had no heart rate or cadence sensor data.
    avgHr: doublePrecision("avg_hr"),
    maxHr: doublePrecision("max_hr"),
    cadence: doublePrecision("cadence"),
    calories: doublePrecision("calories"),
    elevationGainM: doublePrecision("elevation_gain_m"),
    isIndoor: boolean("is_indoor").notNull().default(false),
    isManual: boolean("is_manual").notNull().default(false),
    garminUpdatedAt: timestamp("garmin_updated_at", { withTimezone: true }),
    summary: jsonb("summary"),
    ...timestamps(),
  },
  (table) => [
    // Leads with user_id, so it is also the user_id index.
    uniqueIndex("activity_user_id_garmin_activity_id_idx").on(table.userId, table.garminActivityId),
    // The run list: a user's runs, newest first.
    index("activity_user_id_start_utc_idx").on(table.userId, table.startUtc.desc()),
  ],
);

export type Activity = typeof activity.$inferSelect;
export type NewActivity = typeof activity.$inferInsert;
