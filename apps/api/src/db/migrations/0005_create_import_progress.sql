CREATE TABLE "import_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"next_offset" integer DEFAULT 0 NOT NULL,
	"cursor_date" date,
	"last_error" text,
	"resume_at" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_progress_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "import_progress_status_check" CHECK ("import_progress"."status" in ('running', 'paused', 'failed', 'done'))
);
--> statement-breakpoint
ALTER TABLE "import_progress" ADD CONSTRAINT "import_progress_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;