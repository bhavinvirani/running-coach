CREATE TABLE "shoe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"colour" text,
	"nickname" text,
	"retire_distance_m" integer DEFAULT 650000 NOT NULL,
	"start_distance_m" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shoe_retired_not_active_check" CHECK (not ("shoe"."active" and "shoe"."retired_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "shoe_id" uuid;--> statement-breakpoint
ALTER TABLE "shoe" ADD CONSTRAINT "shoe_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shoe_user_id_idx" ON "shoe" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shoe_user_id_active_idx" ON "shoe" USING btree ("user_id") WHERE "shoe"."active";--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_shoe_id_shoe_id_fk" FOREIGN KEY ("shoe_id") REFERENCES "public"."shoe"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_shoe_id_idx" ON "activity" USING btree ("shoe_id");