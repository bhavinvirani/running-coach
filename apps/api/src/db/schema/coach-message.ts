import {
  type CoachFallbackReason,
  type CoachFeedback,
  coachFallbackReasonSchema,
  coachFeedbackSchema,
} from "@running-coach/shared";
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CoachUsage } from "../../coach/client";
import { activity } from "./activity";
import { user } from "./auth";
import { id, inList, timestamps } from "./columns";
import { plan } from "./plan";

// Everything the coach wrote: run insights now, weekly reviews and race plans later. Feedback and the
// fallback reason come from shared zod enums; kinds stay local, because no route exposes them (the
// insight routes imply "insight").

const COACH_MESSAGE_KINDS = ["insight", "weekly_review", "race_plan"] as const;
export type CoachMessageKind = (typeof COACH_MESSAGE_KINDS)[number];

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
    // Why content is the fallback card; null when the model wrote it.
    fallbackReason: text("fallback_reason").$type<CoachFallbackReason>(),
    feedback: text("feedback").$type<CoachFeedback>(),
    // Null when no call was made (no key); set for a failed call too, because it was billed.
    usage: jsonb("usage").$type<CoachUsage>(),
    ...timestamps(),
  },
  (table) => [
    index("coach_message_user_id_idx").on(table.userId),
    // For the cascade from activity, whose delete does not filter on kind.
    index("coach_message_activity_id_idx").on(table.activityId),
    // At most one insight per run: the card is upserted on this, so a job firing twice never makes two.
    uniqueIndex("coach_message_insight_activity_id_idx")
      .on(table.activityId)
      .where(sql`${table.kind} = 'insight'`),
    index("coach_message_plan_id_idx").on(table.planId),
    check("coach_message_kind_check", sql`${table.kind} in (${inList(COACH_MESSAGE_KINDS)})`),
    check(
      "coach_message_feedback_check",
      sql`${table.feedback} in (${inList(coachFeedbackSchema.options)})`,
    ),
    check(
      "coach_message_fallback_reason_check",
      sql`${table.fallbackReason} in (${inList(coachFallbackReasonSchema.options)})`,
    ),
  ],
);

export type CoachMessage = typeof coachMessage.$inferSelect;
