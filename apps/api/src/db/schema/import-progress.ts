import { importStatusSchema } from "@running-coach/shared";
import { sql } from "drizzle-orm";
import { check, date, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { id, inList, timestamps } from "./columns";

// One row per user for the full-history import: where it stands and the cursor its next page reads from.
// No row means not started, and "stalled" is derived from updated_at (services/history-import.ts), so the
// column holds every shared status but those two.

const storedImportStatusSchema = importStatusSchema.exclude(["not_started", "stalled"]);
export type StoredImportStatus = (typeof storedImportStatusSchema.options)[number];

export const importProgress = pgTable(
  "import_progress",
  {
    id: id(),
    // unique() also gives user_id its index.
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").$type<StoredImportStatus>().notNull(),
    // Offset in Garmin's activity list, newest first, where the next page starts.
    nextOffset: integer("next_offset").notNull().default(0),
    // Local start date of the oldest run reached; null before the first page.
    cursorDate: date("cursor_date", { mode: "string" }),
    // An error code from the shared list, never upstream text.
    lastError: text("last_error"),
    // While paused after a Garmin 429: when the deferred page runs.
    resumeAt: timestamp("resume_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // updated_at also tells a stalled import: every write here moves it.
    ...timestamps(),
  },
  (table) => [
    check(
      "import_progress_status_check",
      sql`${table.status} in (${inList(storedImportStatusSchema.options)})`,
    ),
  ],
);

export type ImportProgressRow = typeof importProgress.$inferSelect;
