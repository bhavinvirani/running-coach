import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCode,
  type GarminActivitySummary,
  type GarminSyncResponse,
  type SyncResponse,
} from "@running-coach/shared";
import { type Column, eq, sql } from "drizzle-orm";
import { type Db, type DbTransaction, db } from "../db/client";
import { activity, garminConnection, userSettings } from "../db/schema";
import { DEFAULT_RETRY_AFTER_S, garminClient } from "../garmin/client";
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
  /**
   * The sync runs up to the user's local date at this instant, inclusive; the time it takes the lock when
   * omitted. Tests pin it; a job never passes the date it was queued for.
   */
  now?: Date;
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
      lastError: garminConnection.lastError,
      updatedAt: garminConnection.updatedAt,
      timezone: userSettings.timezone,
    })
    .from(garminConnection)
    // Every user gets a settings row at creation (auth.ts), so the join never drops a connection.
    .innerJoin(userSettings, eq(userSettings.userId, garminConnection.userId))
    .where(eq(garminConnection.userId, userId));
  return row;
}

/**
 * Seconds left of the hour a Garmin 429 blocks the login, or 0 when none is running. updated_at marks the
 * 429: recordFailure wrote last_error then, and nothing else changes the row until a finished chunk
 * (saveChunk) or a reconnect clears last_error, which ends the hour early.
 */
function rateLimitSecondsLeft(connection: { lastError: string | null; updatedAt: Date }): number {
  if (connection.lastError !== ErrorCode.garminRateLimited) return 0;
  const leftMs = connection.updatedAt.getTime() + DEFAULT_RETRY_AFTER_S * 1000 - Date.now();
  if (leftMs <= 0) return 0;
  return Math.min(DEFAULT_RETRY_AFTER_S, Math.max(1, Math.ceil(leftMs / 1000)));
}

/**
 * Stores a bundle Garmin rotated, at once and on its own connection: the old refresh token is dead, so this
 * write must survive whatever fails next.
 */
async function saveTokenBundle(userId: string, tokenBundle: string): Promise<void> {
  await db
    .update(garminConnection)
    .set({ tokenBundleEnc: encrypt(tokenBundle, userId) })
    .where(eq(garminConnection.userId, userId));
}

/**
 * Stores the error code. Only a second garmin_auth_expired in a row marks the login expired: the library
 * swallows a failed token refresh (a 429 or a block on the token endpoint) and reports it as the same 401,
 * and an expired connection is never tried again until the runner reconnects with 2FA. The next sync
 * confirms it with one token login. A success in between clears lastError (saveChunk).
 */
async function recordFailure(userId: string, error: unknown): Promise<void> {
  const code = error instanceof DomainError ? error.code : ErrorCode.internal;
  await db
    .update(garminConnection)
    .set({
      lastError: code,
      ...(code === ErrorCode.garminAuthExpired
        ? {
            status: sql`case when ${garminConnection.lastError} = ${code} then 'expired' else ${garminConnection.status} end`,
          }
        : {}),
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
 * to the user's local date today, in 7-day chunks oldest first. Runs inside the per-user lock, so two
 * syncs for one user never overlap. Each chunk commits on its own connection (not the lock's
 * transaction): a kill or an error keeps the finished chunks and the cursor, and the next run resumes
 * there. A bundle Garmin rotated is written back the moment the client hands it over, before the call
 * returns or throws, because the old refresh token no longer works.
 */
export async function syncGarmin({
  userId,
  now,
  signal,
}: SyncGarminInput): Promise<SyncGarminResult> {
  return withUserLock(userId, async () => {
    const connection = await readConnection(userId);
    if (!connection) {
      throw new DomainError(ErrorCode.garminNotConnected, 409, "Connect Garmin first.");
    }
    // A known-dead login is not sent again: failed logins are what Garmin rate-limits hardest.
    if (connection.status === "expired") throw expired();
    // Nor is a login Garmin rate-limited within the hour: every try during the block is another login,
    // which can stretch it. The refusal writes nothing, so a tap never pushes the hour forward.
    const retryAfterSeconds = rateLimitSecondsLeft(connection);
    if (retryAfterSeconds > 0) {
      throw new DomainError(
        ErrorCode.garminRateLimited,
        429,
        "Garmin is limiting requests. Try again later.",
        { retryAfterSeconds },
      );
    }

    const timeZone = connection.timezone;
    const today = localDateOf(now ?? new Date(), timeZone);
    const startDate = syncStartDate(connection.lastSyncAt, timeZone, today);
    const chunks = dateChunks(startDate, today, SYNC_CHUNK_DAYS);
    let bundle = decrypt(connection.tokenBundleEnc, userId);
    const onTokenBundle = async (rotated: string): Promise<void> => {
      await saveTokenBundle(userId, rotated);
      bundle = rotated;
    };
    let activitiesSeen = 0;
    let activitiesWritten = 0;

    for (const [index, chunk] of chunks.entries()) {
      signal?.throwIfAborted();
      if (index > 0 && CHUNK_GAP_MS > 0) await sleep(CHUNK_GAP_MS, undefined, { signal });

      let response: GarminSyncResponse;
      try {
        response = await garminClient.sync(
          { tokenBundle: bundle, startDate: chunk.start, endDate: chunk.end },
          { onTokenBundle },
        );
      } catch (error) {
        await recordFailure(userId, error);
        throw error;
      }

      // The last chunk ends today: the cursor is now. Earlier chunks end on a past day (and so does a
      // pinned `now` in the past): noon UTC of it, whose local date is that day or the next, so the one-day
      // overlap re-reads it either way.
      const isLast = index === chunks.length - 1;
      const finishedAt = new Date();
      const cursor =
        isLast && localDateOf(finishedAt, timeZone) === today ? finishedAt : noonUtc(chunk.end);
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

/**
 * POST /api/sync: Sync now. Runs in the request instead of the job queue, so a 409, 429 or 502 reaches the
 * runner who tapped rather than hiding behind the job's retries minutes later. A 429 is not deferred here:
 * the runner sees it and decides when to try again.
 */
export async function syncNow({ userId }: { userId: string }): Promise<SyncResponse> {
  const { activitiesWritten } = await syncGarmin({ userId });
  const [row] = await db
    .select({ lastSyncAt: garminConnection.lastSyncAt })
    .from(garminConnection)
    .where(eq(garminConnection.userId, userId));
  // Every finished chunk moves the cursor, and a sync that returns finished at least one.
  if (!row?.lastSyncAt) throw new Error("The sync finished without saving its cursor");
  return { lastSyncAt: row.lastSyncAt.toISOString(), activitiesWritten };
}
