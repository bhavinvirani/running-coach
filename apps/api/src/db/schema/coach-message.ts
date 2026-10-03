import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { CoachUsage } from "../../coach/client";
import { activity } from "./activity";
import { user } from "./auth";
import { id, inList, timestamps } from "./columns";
import { plan } from "./plan";

// Everything the coach wrote: run insights now, weekly reviews and race plans later. Kinds and feedback
// move to shared zod enums when a route exposes them.

const COACH_MESSAGE_KINDS = ["insight", "weekly_review", "race_plan"] as const;
const COACH_MESSAGE_FEEDBACK = ["up", "down"] as const;
export type CoachMessageKind = (typeof COACH_MESSAGE_KINDS)[number];
export type CoachMessageFeedback = (typeof COACH_MESSAGE_FEEDBACK)[number];

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
    // The plan a weekly review or race plan was written for; outlives the plan, unlinked.
    planId: uuid("plan_id").references(() => plan.id, { onDelete: "set null" }),
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
    index("coach_message_plan_id_idx").on(table.planId),
    check("coach_message_kind_check", sql`${table.kind} in (${inList(COACH_MESSAGE_KINDS)})`),
    check(
      "coach_message_feedback_check",
      sql`${table.feedback} in (${inList(COACH_MESSAGE_FEEDBACK)})`,
    ),
  ],
);

export type CoachMessage = typeof coachMessage.$inferSelect;
