CREATE TABLE "best_effort" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"distance_key" text NOT NULL,
	"time_s" double precision NOT NULL,
	"start_s" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "best_effort_activity_id_distance_key_unique" UNIQUE("activity_id","distance_key"),
	CONSTRAINT "best_effort_distance_key_check" CHECK ("best_effort"."distance_key" in ('1k', '1mi', '2mi', '5k', '5mi', '10k', '15k', '10mi', '20k', 'half', 'marathon'))
);
--> statement-breakpoint
ALTER TABLE "garmin_connection" ADD COLUMN "garmin_records" jsonb;--> statement-breakpoint
ALTER TABLE "garmin_connection" ADD COLUMN "garmin_records_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "best_efforts_version" smallint;--> statement-breakpoint
ALTER TABLE "best_effort" ADD CONSTRAINT "best_effort_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "best_effort" ADD CONSTRAINT "best_effort_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "best_effort_user_id_distance_key_time_s_idx" ON "best_effort" USING btree ("user_id","distance_key","time_s");