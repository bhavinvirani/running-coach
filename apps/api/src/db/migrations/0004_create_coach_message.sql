CREATE TABLE "coach_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"activity_id" uuid,
	"prompt_version" text NOT NULL,
	"model" text,
	"content" jsonb NOT NULL,
	"feedback" text,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coach_message_kind_check" CHECK ("coach_message"."kind" in ('insight', 'weekly_review', 'race_plan')),
	CONSTRAINT "coach_message_feedback_check" CHECK ("coach_message"."feedback" in ('up', 'down'))
);
--> statement-breakpoint
ALTER TABLE "coach_message" ADD CONSTRAINT "coach_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_message" ADD CONSTRAINT "coach_message_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_message_user_id_idx" ON "coach_message" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "coach_message_activity_id_idx" ON "coach_message" USING btree ("activity_id");