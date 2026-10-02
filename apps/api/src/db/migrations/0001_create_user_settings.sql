CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"units" text DEFAULT 'km' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"hr_zones" jsonb,
	"coach_detail" text DEFAULT 'standard' NOT NULL,
	"claude_key_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "user_settings_units_check" CHECK ("user_settings"."units" in ('km', 'mi')),
	CONSTRAINT "user_settings_coach_detail_check" CHECK ("user_settings"."coach_detail" in ('short', 'standard', 'detailed'))
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;