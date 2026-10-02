CREATE TABLE "garmin_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_bundle_enc" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "garmin_connection_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "garmin_connection_status_check" CHECK ("garmin_connection"."status" in ('ok', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "garmin_connection" ADD CONSTRAINT "garmin_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;