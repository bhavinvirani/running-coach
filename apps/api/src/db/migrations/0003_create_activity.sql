CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"garmin_activity_id" bigint NOT NULL,
	"type" text NOT NULL,
	"start_utc" timestamp with time zone NOT NULL,
	"start_local" timestamp NOT NULL,
	"tz" text,
	"distance_m" double precision NOT NULL,
	"duration_s" double precision NOT NULL,
	"avg_hr" double precision,
	"max_hr" double precision,
	"cadence" double precision,
	"calories" double precision,
	"elevation_gain_m" double precision,
	"is_indoor" boolean DEFAULT false NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"garmin_updated_at" timestamp with time zone,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_user_id_garmin_activity_id_idx" ON "activity" USING btree ("user_id","garmin_activity_id");--> statement-breakpoint
CREATE INDEX "activity_user_id_start_utc_idx" ON "activity" USING btree ("user_id","start_utc" DESC NULLS LAST);