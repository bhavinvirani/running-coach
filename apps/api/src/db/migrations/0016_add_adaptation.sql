CREATE TABLE "plan_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_session_id" uuid,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"requested" jsonb,
	"applied" jsonb,
	"before" jsonb,
	"after" jsonb,
	"activity_id" uuid,
	"coach_message_id" uuid,
	"pause_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_adjustment_source_check" CHECK ("plan_adjustment"."source" in ('coach', 'pause', 'gap')),
	CONSTRAINT "plan_adjustment_kind_check" CHECK ("plan_adjustment"."kind" in ('scale', 'easy', 'rest', 're_entry')),
	CONSTRAINT "plan_adjustment_outcome_check" CHECK ("plan_adjustment"."outcome" in ('applied', 'clamped', 'rejected')),
	CONSTRAINT "plan_adjustment_reason_check" CHECK ("plan_adjustment"."reason" in ('race', 'custom', 'locked', 'adjusted', 'paused', 'stale_run', 'no_session', 'no_change', 'invalid')),
	CONSTRAINT "plan_adjustment_rejected_reason_check" CHECK (("plan_adjustment"."outcome" = 'rejected') = ("plan_adjustment"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "training_pause" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_pause_reason_check" CHECK ("training_pause"."reason" in ('sick', 'injured', 'break')),
	CONSTRAINT "training_pause_ended_on_check" CHECK ("training_pause"."ended_on" is null or "training_pause"."ended_on" >= "training_pause"."started_on")
);
--> statement-breakpoint
ALTER TABLE "plan_adjustment" ADD CONSTRAINT "plan_adjustment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_adjustment" ADD CONSTRAINT "plan_adjustment_plan_session_id_plan_session_id_fk" FOREIGN KEY ("plan_session_id") REFERENCES "public"."plan_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_adjustment" ADD CONSTRAINT "plan_adjustment_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_adjustment" ADD CONSTRAINT "plan_adjustment_coach_message_id_coach_message_id_fk" FOREIGN KEY ("coach_message_id") REFERENCES "public"."coach_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_adjustment" ADD CONSTRAINT "plan_adjustment_pause_id_training_pause_id_fk" FOREIGN KEY ("pause_id") REFERENCES "public"."training_pause"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_pause" ADD CONSTRAINT "training_pause_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_adjustment_user_id_idx" ON "plan_adjustment" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plan_adjustment_plan_session_id_idx" ON "plan_adjustment" USING btree ("plan_session_id");--> statement-breakpoint
CREATE INDEX "plan_adjustment_activity_id_idx" ON "plan_adjustment" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "plan_adjustment_coach_message_id_idx" ON "plan_adjustment" USING btree ("coach_message_id");--> statement-breakpoint
CREATE INDEX "plan_adjustment_pause_id_idx" ON "plan_adjustment" USING btree ("pause_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_adjustment_coach_activity_id_idx" ON "plan_adjustment" USING btree ("activity_id") WHERE "plan_adjustment"."source" = 'coach';--> statement-breakpoint
CREATE UNIQUE INDEX "plan_adjustment_gap_activity_id_session_idx" ON "plan_adjustment" USING btree ("activity_id","plan_session_id") WHERE "plan_adjustment"."source" = 'gap';--> statement-breakpoint
CREATE UNIQUE INDEX "plan_adjustment_pause_id_session_idx" ON "plan_adjustment" USING btree ("pause_id","plan_session_id") WHERE "plan_adjustment"."source" = 'pause';--> statement-breakpoint
CREATE INDEX "training_pause_user_id_idx" ON "training_pause" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "training_pause_user_id_open_idx" ON "training_pause" USING btree ("user_id") WHERE "training_pause"."ended_on" is null;