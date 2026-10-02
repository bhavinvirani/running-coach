import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCode,
  type GarminActivitySummary,
  type GarminSyncResponse,
} from "@running-coach/shared";
import { type Column, eq, sql } from "drizzle-orm";
import { type Db, type DbTransaction, db } from "../db/client";
import { activity, garminConnection, userSettings } from "../db/schema";
import { garminClient } from "../garmin/client";
import { config } from "../lib/config";
import { decrypt, encrypt } from "../lib/crypto";
import { DomainError } from "../lib/errors";
import { addDays, dateChunks, daysBetween, localDateOf, noonUtc } from "../lib/local-date";
import { withUserLock } from "../lib/locks";
import { logger } from "../lib/logger";

const log = logger.child({ module: "garmin-sync" });

export const SYNC_CHUNK_DAYS = 7;
export const FIRST_SYNC_DAYS = 30;
// Re-read the last synced day: a run saved late, or edited on Garmin, lands in it.
const OVERLAP_DAYS = 1;
// About 1 s between Garmin calls (SPEC); the fixture service has no Garmin behind it.
const CHUNK_GAP_MS = config.GARMIN_FIXTURES ? 0 : 1000;

export interface SyncGarminInput {
  userId: string;
  /** The user's local date the sync runs up to, inclusive. */
  today: string;
  /** Aborts between chunks, when the worker stops. */
  signal?: AbortSignal;
}

export interface SyncGarminResult {
  startDate: string;
  endDate: string;
  chunks: number;
  /** Runs Garmin listed in the range. */
  activitiesSeen: number;
  /** Rows inserted or changed; 0 when everything was already stored. */
  activitiesWritten: number;
}

const excluded = (column: Column) => sql`excluded.${sql.identifier(column.name)}`;
const current = (column: Column) =>
  sql`${sql.identifier("activity")}.${sql.identifier(column.name)}`;

// Columns a sync owns. tz, summary and garmin_updated_at come from later detail calls and are kept.
const SYNCED_KEYS = [
  "type",
  "startUtc",
  "startLocal",
  "distanceM",
  "durationS",
  "avgHr",
  "maxHr",
  "cadence",
  "calories",
  "elevationGainM",
  "isIndoor",
  "isManual",
] as const;
const syncedColumns = SYNCED_KEYS.map((key) => activity[key]);

/**
 * Inserts new runs and updates changed ones on (user_id, garmin_activity_id). An unchanged run is not
 * rewritten, so a repeated sync writes nothing. Returns the number of rows inserted or changed.
 */
export async function upsertActivities(
  userId: string,
  summaries: GarminActivitySummary[],
  executor: Db | DbTransaction = db,
): Promise<number> {
  if (summaries.length === 0) return 0;
  const rows = await executor
    .insert(activity)
    .values(
      summaries.map((summary) => ({
        userId,
        garminActivityId: summary.garminActivityId,
        type: summary.type,
        startUtc: new Date(summary.startUtc),
        startLocal: summary.startLocal,
        tz: summary.tz,
        distanceM: summary.distanceM,
        durationS: summary.durationS,
        avgHr: summary.avgHr,
        maxHr: summary.maxHr,
        cadence: summary.cadence,
        calories: summary.calories,
        elevationGainM: summary.elevationGainM,
        isIndoor: summary.isIndoor,
        isManual: summary.isManual,
      })),
    )
    .onConflictDoUpdate({
      target: [activity.userId, activity.garminActivityId],
      set: {
        ...Object.fromEntries(SYNCED_KEYS.map((key) => [key, excluded(activity[key])])),
        tz: sql`coalesce(${excluded(activity.tz)}, ${current(activity.tz)})`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`(${sql.join(syncedColumns.map(current), sql`, `)}) is distinct from (${sql.join(
        syncedColumns.map(excluded),
        sql`, `,
      )})`,
    })
    .returning({ id: activity.id });
  return rows.length;
}

/** Where the next sync starts: the day before the last synced one, or 30 days back the first time. */
export function syncStartDate(lastSyncAt: Date | null, timeZone: string, today: string): string {
  const start = lastSyncAt
    ? addDays(localDateOf(lastSyncAt, timeZone), -OVERLAP_DAYS)
    : addDays(today, -FIRST_SYNC_DAYS);
  return daysBetween(start, today) < 0 ? today : start;
}

function expired(): DomainError {
  return new DomainError(
    ErrorCode.garminAuthExpired,
    409,
    "Garmin rejected the saved login. Connect Garmin again.",
  );
}

async function readConnection(userId: string) {
  const [row] = await db
    .select({
      tokenBundleEnc: garminConnection.tokenBundleEnc,
      status: garminConnection.status,
      lastSyncAt: garminConnection.lastSyncAt,
      timezone: userSettings.timezone,
    })
    .from(garminConnection)
    .leftJoin(userSettings, eq(userSettings.userId, garminConnection.userId))
    .where(eq(garminConnection.userId, userId));
  return row;
}

async function recordFailure(userId: string, error: unknown): Promise<void> {
  const code = error instanceof DomainError ? error.code : ErrorCode.internal;
  await db
    .update(garminConnection)
    .set({
      lastError: code,
      ...(code === ErrorCode.garminAuthExpired ? { status: "expired" as const } : {}),
    })
    .where(eq(garminConnection.userId, userId));
}

/** Saves one finished chunk: runs, then the cursor, together. */
async function saveChunk(
  userId: string,
  activities: GarminActivitySummary[],
  cursor: Date,
): Promise<number> {
  return db.transaction(async (tx) => {
    const written = await upsertActivities(userId, activities, tx);
    // Never move the cursor back: an older job finishing late must not re-open synced days.
    await tx
      .update(garminConnection)
      .set({
        lastSyncAt: sql`greatest(${garminConnection.lastSyncAt}, ${cursor.toISOString()}::timestamptz)`,
        status: "ok",
        lastError: null,
      })
      .where(eq(garminConnection.userId, userId));
    return written;
  });
}

/**
 * Pulls the user's runs from Garmin into `activity`, from the last sync (minus a day) or 30 days back, up
 * to `today`, in 7-day chunks oldest first. Runs inside the per-user lock, so two syncs for one user never
 * overlap. Each chunk commits on its own connection (not the lock's transaction): a kill or an error
 * keeps the finished chunks and the cursor, and the next run resumes there. A bundle Garmin rotated is
 * written back before anything else, because the old refresh token no longer works.
 */
export async function syncGarmin({
  userId,
  today,
  signal,
}: SyncGarminInput): Promise<SyncGarminResult> {
  return withUserLock(userId, async () => {
    const connection = await readConnection(userId);
    if (!connection) {
      throw new DomainError(ErrorCode.garminNotConnected, 409, "Connect Garmin first.");
    }
    // A known-dead login is not sent again: failed logins are what Garmin rate-limits hardest.
    if (connection.status === "expired") throw expired();

    const timeZone = connection.timezone ?? "UTC";
    const startDate = syncStartDate(connection.lastSyncAt, timeZone, today);
    const chunks = dateChunks(startDate, today, SYNC_CHUNK_DAYS);
    let bundle = decrypt(connection.tokenBundleEnc, userId);
    let activitiesSeen = 0;
    let activitiesWritten = 0;

    for (const [index, chunk] of chunks.entries()) {
      signal?.throwIfAborted();
      if (index > 0 && CHUNK_GAP_MS > 0) await sleep(CHUNK_GAP_MS, undefined, { signal });

      let response: GarminSyncResponse;
      try {
        response = await garminClient.sync({
          tokenBundle: bundle,
          startDate: chunk.start,
          endDate: chunk.end,
        });
      } catch (error) {
        await recordFailure(userId, error);
        throw error;
      }

      if (response.tokenBundle !== bundle) {
        await db
          .update(garminConnection)
          .set({ tokenBundleEnc: encrypt(response.tokenBundle, userId) })
          .where(eq(garminConnection.userId, userId));
        bundle = response.tokenBundle;
      }

      // The last chunk ends today: the cursor is now. Earlier chunks end on a past day: noon UTC of it,
      // whose local date is that day or the next, so the one-day overlap re-reads it either way.
      const isLast = index === chunks.length - 1;
      const now = new Date();
      const cursor = isLast && localDateOf(now, timeZone) === today ? now : noonUtc(chunk.end);
      activitiesSeen += response.activities.length;
      activitiesWritten += await saveChunk(userId, response.activities, cursor);
    }

    const result = {
      startDate,
      endDate: today,
      chunks: chunks.length,
      activitiesSeen,
      activitiesWritten,
    };
    log.info({ userId, ...result }, "garmin sync finished");
    return result;
  });
}
