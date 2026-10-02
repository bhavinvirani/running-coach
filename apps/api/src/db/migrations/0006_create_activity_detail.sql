CREATE TABLE "activity_lap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"distance_m" double precision NOT NULL,
	"duration_s" double precision NOT NULL,
	"avg_hr" double precision,
	"avg_cadence" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_lap_activity_id_idx_unique" UNIQUE("activity_id","idx")
);
--> statement-breakpoint
CREATE TABLE "activity_stream" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"elapsed_s" real[] NOT NULL,
	"distance_m" real[] NOT NULL,
	"hr" real[],
	"cadence" real[],
	"elevation_m" real[],
	"speed_mps" real[],
	"route" jsonb,
	"hr_zones" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_stream_activity_id_unique" UNIQUE("activity_id")
);
--> statement-breakpoint
ALTER TABLE "activity_lap" ADD CONSTRAINT "activity_lap_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_stream" ADD CONSTRAINT "activity_stream_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;