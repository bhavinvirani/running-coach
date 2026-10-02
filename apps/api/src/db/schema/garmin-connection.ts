import { type GarminRecord, garminStatusSchema } from "@running-coach/shared";
import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { id, inList, timestamps } from "./columns";

// A user's Garmin login: the encrypted token bundle, written back after every call because the refresh
// token rotates. No row means not connected, so the column holds every shared status but that one.

const connectionStatusSchema = garminStatusSchema.exclude(["not_connected"]);
type GarminConnectionStatus = (typeof connectionStatusSchema.options)[number];

export const garminConnection = pgTable(
  "garmin_connection",
  {
    id: id(),
    // unique() also gives user_id its index.
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    // "v1:" ciphertext from src/lib/crypto.ts.
    tokenBundleEnc: text("token_bundle_enc").notNull(),
    status: text("status").$type<GarminConnectionStatus>().notNull().default("ok"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    // An error code from the shared list, never upstream text.
    lastError: text("last_error"),
    // Garmin's own running records, shown beside the app's bests; written by the best-efforts batch that
    // empties the pending list. Null until then.
    garminRecords: jsonb("garmin_records").$type<GarminRecord[]>(),
    garminRecordsAt: timestamp("garmin_records_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    check(
      "garmin_connection_status_check",
      sql`${table.status} in (${inList(connectionStatusSchema.options)})`,
    ),
  ],
);
