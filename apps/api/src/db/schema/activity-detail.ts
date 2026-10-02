import type { HrZoneTime, RoutePoint } from "@running-coach/shared";
import { doublePrecision, integer, jsonb, pgTable, real, unique, uuid } from "drizzle-orm/pg-core";
import { activity } from "./activity";
import { id, timestamps } from "./columns";

// What Garmin holds about one run beyond its summary, fetched once on demand (services/activity-detail.ts)
// and kept when a sync rewrites the run's summary, since the activity row keeps its id. SI units.

/** One lap as the watch recorded it; on an auto-lap watch these are the per-km splits. */
export const activityLap = pgTable(
  "activity_lap",
  {
    id: id(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activity.id, { onDelete: "cascade" }),
    // Lap number as the watch shows it, starting at 1.
    idx: integer("idx").notNull(),
    distanceM: doublePrecision("distance_m").notNull(),
    durationS: doublePrecision("duration_s").notNull(),
    avgHr: doublePrecision("avg_hr"),
    // Steps per minute.
    avgCadence: doublePrecision("avg_cadence"),
    ...timestamps(),
  },
  // Leads with activity_id, so it is also the activity_id index.
  (table) => [unique("activity_lap_activity_id_idx_unique").on(table.activityId, table.idx)],
);

/**
 * One row per run whose detail was fetched; its presence is what "fetched" means. Row-aligned samples as
 * Garmin's detail call thins them: real (4 bytes) is plenty for charted samples. A null column is a series
 * the watch did not record; a null element is one missing reading. Every array is empty for a manual entry.
 */
export const activityStream = pgTable("activity_stream", {
  id: id(),
  // unique() also gives activity_id its index.
  activityId: uuid("activity_id")
    .notNull()
    .unique()
    .references(() => activity.id, { onDelete: "cascade" }),
  elapsedS: real("elapsed_s").array().notNull().$type<number[]>(),
  distanceM: real("distance_m").array().notNull().$type<number[]>(),
  hr: real("hr").array().$type<(number | null)[]>(),
  // Steps per minute.
  cadence: real("cadence").array().$type<(number | null)[]>(),
  elevationM: real("elevation_m").array().$type<(number | null)[]>(),
  speedMps: real("speed_mps").array().$type<(number | null)[]>(),
  // [[lat, lng], ...] in order; null for an indoor run or a manual entry. Never filtered on.
  route: jsonb("route").$type<RoutePoint[]>(),
  // Garmin's five zones in order; null when the run has no heart rate.
  hrZones: jsonb("hr_zones").$type<HrZoneTime[]>(),
  ...timestamps(),
});

export type ActivityLapRow = typeof activityLap.$inferSelect;
export type ActivityStreamRow = typeof activityStream.$inferSelect;
