import {
  type CoachDetail,
  coachDetailSchema,
  type Units,
  unitsSchema,
} from "@running-coach/shared";
import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { id, timestamps } from "./columns";

// One row per user, created with these defaults on the first GET /api/me (services/settings.ts).

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", "));

export const userSettings = pgTable(
  "user_settings",
  {
    id: id(),
    // unique() also gives user_id its index.
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    units: text("units").$type<Units>().notNull().default("km"),
    timezone: text("timezone").notNull().default("UTC"),
    hrZones: jsonb("hr_zones"),
    coachDetail: text("coach_detail").$type<CoachDetail>().notNull().default("standard"),
    // "v1:" ciphertext from src/lib/crypto.ts; never returned by a route.
    claudeKeyEnc: text("claude_key_enc"),
    ...timestamps(),
  },
  (table) => [
    check("user_settings_units_check", sql`${table.units} in (${inList(unitsSchema.options)})`),
    check(
      "user_settings_coach_detail_check",
      sql`${table.coachDetail} in (${inList(coachDetailSchema.options)})`,
    ),
  ],
);
