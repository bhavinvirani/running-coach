import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { CoachUsage } from "../../coach/client";
import { activity } from "./activity";
import { user } from "./auth";
import { id, timestamps } from "./columns";

// Everything the coach wrote: run insights now, weekly reviews and race plans later. plan_id arrives
// with the plan table in slice 6.

export type CoachMessageKind = "insight" | "weekly_review" | "race_plan";
export type CoachMessageFeedback = "up" | "down";

export const coachMessage = pgTable(
  "coach_message",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<CoachMessageKind>().notNull(),
    // An insight belongs to its run and goes when the run goes.
    activityId: uuid("activity_id").references(() => activity.id, { onDelete: "cascade" }),
    // "<prompt>/<version>", e.g. "run-insight/v1": which prompt file wrote it, or whose fallback card it is.
    promptVersion: text("prompt_version").notNull(),
    // The model that wrote content; null when content is the fallback card built without a model.
    model: text("model"),
    // The prompt's output schema, or its fallback card in the same shape.
    content: jsonb("content").notNull(),
    feedback: text("feedback").$type<CoachMessageFeedback>(),
    // Null when no call was made (no key); set for a failed call too, because it was billed.
    usage: jsonb("usage").$type<CoachUsage>(),
    ...timestamps(),
  },
  (table) => [
    index("coach_message_user_id_idx").on(table.userId),
    index("coach_message_activity_id_idx").on(table.activityId),
    check(
      "coach_message_kind_check",
      sql`${table.kind} in ('insight', 'weekly_review', 'race_plan')`,
    ),
    check("coach_message_feedback_check", sql`${table.feedback} in ('up', 'down')`),
  ],
);

export type CoachMessage = typeof coachMessage.$inferSelect;
