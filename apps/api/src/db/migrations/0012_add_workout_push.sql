ALTER TABLE "plan_session" DROP CONSTRAINT "plan_session_status_check";--> statement-breakpoint
DROP INDEX "plan_session_user_id_idx";--> statement-breakpoint
ALTER TABLE "plan_session" ALTER COLUMN "plan_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_session" ALTER COLUMN "phase" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "garmin_connection" ADD COLUMN "workouts_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "garmin_connection" ADD COLUMN "workouts_push_error" text;--> statement-breakpoint
ALTER TABLE "garmin_connection" ADD COLUMN "garmin_calendar" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_session" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "plan_session" ADD COLUMN "garmin_date" date;--> statement-breakpoint
ALTER TABLE "plan_session" ADD COLUMN "garmin_hash" text;--> statement-breakpoint
CREATE INDEX "plan_session_user_id_date_idx" ON "plan_session" USING btree ("user_id","date");--> statement-breakpoint
ALTER TABLE "garmin_connection" ADD CONSTRAINT "garmin_connection_workouts_push_error_check" CHECK ("garmin_connection"."workouts_push_error" in ('validation', 'unauthorized', 'not_found', 'rate_limited', 'internal', 'garmin_not_connected', 'garmin_auth_expired', 'garmin_rate_limited', 'garmin_unavailable', 'garmin_mfa_required', 'claude_key_missing', 'claude_key_invalid', 'claude_unavailable', 'plan_missing', 'session_locked'));--> statement-breakpoint
ALTER TABLE "plan_session" ADD CONSTRAINT "plan_session_custom_check" CHECK (("plan_session"."plan_id" is null) = ("plan_session"."phase" is null));--> statement-breakpoint
ALTER TABLE "plan_session" ADD CONSTRAINT "plan_session_status_check" CHECK ("plan_session"."status" in ('planned', 'done', 'missed', 'moved', 'skipped'));