CREATE TABLE "goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"distance_key" text,
	"race_date" date,
	"target_time_s" integer,
	"days_per_week" smallint NOT NULL,
	"long_run_day" text NOT NULL,
	"recent_distance_key" text,
	"recent_time_s" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "goal_kind_check" CHECK ("goal"."kind" in ('race', 'fitness')),
	CONSTRAINT "goal_distance_key_check" CHECK ("goal"."distance_key" in ('5k', '10k', 'half', 'marathon')),
	CONSTRAINT "goal_long_run_day_check" CHECK ("goal"."long_run_day" in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
	CONSTRAINT "goal_recent_distance_key_check" CHECK ("goal"."recent_distance_key" in ('1k', '1mi', '2mi', '5k', '5mi', '10k', '15k', '10mi', '20k', 'half', 'marathon')),
	CONSTRAINT "goal_recent_time_check" CHECK (("goal"."recent_distance_key" is null) = ("goal"."recent_time_s" is null))
);
--> statement-breakpoint
CREATE TABLE "plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" smallint NOT NULL,
	"engine_version" text NOT NULL,
	"status" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"vdot" double precision NOT NULL,
	"vdot_source" jsonb NOT NULL,
	"paces" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_goal_id_version_unique" UNIQUE("goal_id","version"),
	CONSTRAINT "plan_status_check" CHECK ("plan"."status" in ('active', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "plan_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"type" text NOT NULL,
	"phase" text NOT NULL,
	"target" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"activity_id" uuid,
	"garmin_workout_id" text,
	"garmin_schedule_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_session_type_check" CHECK ("plan_session"."type" in ('easy', 'intervals', 'tempo', 'long', 'race_practice', 'race', 'strength', 'rest')),
	CONSTRAINT "plan_session_phase_check" CHECK ("plan_session"."phase" in ('base', 'build', 'peak', 'taper', 'race')),
	CONSTRAINT "plan_session_status_check" CHECK ("plan_session"."status" in ('planned', 'done', 'missed', 'moved'))
);
--> statement-breakpoint
ALTER TABLE "coach_message" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan" ADD CONSTRAINT "plan_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_session" ADD CONSTRAINT "plan_session_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_session" ADD CONSTRAINT "plan_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_session" ADD CONSTRAINT "plan_session_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_user_id_idx" ON "plan" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_user_id_active_idx" ON "plan" USING btree ("user_id") WHERE "plan"."status" = 'active';--> statement-breakpoint
CREATE INDEX "plan_session_plan_id_date_idx" ON "plan_session" USING btree ("plan_id","date");--> statement-breakpoint
CREATE INDEX "plan_session_user_id_idx" ON "plan_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plan_session_activity_id_idx" ON "plan_session" USING btree ("activity_id");--> statement-breakpoint
ALTER TABLE "coach_message" ADD CONSTRAINT "coach_message_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_message_plan_id_idx" ON "coach_message" USING btree ("plan_id");