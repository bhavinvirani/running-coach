import {
  type CoachCredentialChoice,
  coachCredentialChoiceSchema,
  type CoachDetail,
  coachDetailSchema,
  type Units,
  unitsSchema,
} from "@running-coach/shared";
import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { id, inList, timestamps } from "./columns";

// One row per user with these defaults, inserted when the user is created (Better Auth's user.create.after
// hook in src/auth/auth.ts), so every reader can inner join it.

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
    // What runs the coach: the key above, or the owner's Claude plan through the coach service; a
    // choice honoured only while the plan is offered to the user (services/coach-credential.ts).
    coachCredential: text("coach_credential")
      .$type<CoachCredentialChoice>()
      .notNull()
      .default("key"),
    ...timestamps(),
  },
  (table) => [
    check("user_settings_units_check", sql`${table.units} in (${inList(unitsSchema.options)})`),
    check(
      "user_settings_coach_detail_check",
      sql`${table.coachDetail} in (${inList(coachDetailSchema.options)})`,
    ),
    check(
      "user_settings_coach_credential_check",
      sql`${table.coachCredential} in (${inList(coachCredentialChoiceSchema.options)})`,
    ),
  ],
);
