ALTER TABLE "plan_adjustment" DROP CONSTRAINT "plan_adjustment_source_check";--> statement-breakpoint
ALTER TABLE "coach_message" ADD COLUMN "week_start" date;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_message_weekly_review_week_start_idx" ON "coach_message" USING btree ("user_id","week_start") WHERE "coach_message"."kind" = 'weekly_review';--> statement-breakpoint
CREATE UNIQUE INDEX "plan_adjustment_review_message_session_idx" ON "plan_adjustment" USING btree ("coach_message_id","plan_session_id") WHERE "plan_adjustment"."source" = 'review';--> statement-breakpoint
ALTER TABLE "coach_message" ADD CONSTRAINT "coach_message_week_start_check" CHECK (("coach_message"."kind" = 'weekly_review') = ("coach_message"."week_start" is not null));--> statement-breakpoint
ALTER TABLE "plan_adjustment" ADD CONSTRAINT "plan_adjustment_source_check" CHECK ("plan_adjustment"."source" in ('coach', 'review', 'pause', 'gap'));