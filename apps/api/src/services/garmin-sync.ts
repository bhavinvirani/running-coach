import { setTimeout as sleep } from "node:timers/promises";
import type { GarminActivitySummary, SyncResponse } from "@running-coach/shared";
import { type Column, eq, sql } from "drizzle-orm";
import { type Db, type DbTransaction, db } from "../db/client";
import { activity, garminConnection } from "../db/schema";
import { garminClient } from "../garmin/client";
import { config } from "../lib/config";
import { addDays, dateChunks, daysBetween, localDateOf, noonUtc } from "../lib/local-date";
import { withUserLock } from "../lib/locks";
import { logger } from "../lib/logger";
import { queueBestEfforts } from "./best-efforts";
import { openGarminAccount, recordGarminSuccess } from "./garmin-account";

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
  // The runner can mark a run a race on Garmin after it synced; Import history carries the change over
  // (a sync re-reads only the day before its cursor).
  "eventType",
] as const;
const syncedColumns = SYNCED_KEYS.map((key) => activity[key]);

// A run edited on Garmin (cropped, corrected) has another series, so its stored best efforts are hidden
// and recomputed (services/best-efforts.ts); any other change keeps them.
const seriesColumns = [activity.distanceM, activity.durationS];
const seriesChanged = sql`(${sql.join(seriesColumns.map(current), sql`, `)}) is distinct from (${sql.join(
  seriesColumns.map(excluded),
  sql`, `,
)})`;

/**
 * Inserts new runs and updates changed ones on (user_id, garmin_activity_id). An unchanged run is not
 * rewritten, so a repeated sync writes nothing. A changed distance or time also clears the run's
 * best-efforts version, failed attempts and last failure. Returns the number of rows inserted or changed.
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
        eventType: summary.eventType,
      })),
    )
    .onConflictDoUpdate({
      target: [activity.userId, activity.garminActivityId],
      set: {
        ...Object.fromEntries(SYNCED_KEYS.map((key) => [key, excluded(activity[key])])),
        tz: sql`coalesce(${excluded(activity.tz)}, ${current(activity.tz)})`,
        bestEffortsVersion: sql`case when ${seriesChanged} then null else ${current(activity.bestEffortsVersion)} end`,
        // A new series earns fresh tries at once, also for a run given up on after failed reads.
        bestEffortsAttempts: sql`case when ${seriesChanged} then 0 else ${current(activity.bestEffortsAttempts)} end`,
        bestEffortsFailedAt: sql`case when ${seriesChanged} then null else ${current(activity.bestEffortsFailedAt)} end`,
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

/** Saves one finished chunk: runs, then the cursor, together. */
async function saveChunk(
  userId: string,
  activities: GarminActivitySummary[],
  cursor: Date,
): Promise<number> {
  return db.transaction(async (tx) => {
    const written = await upsertActivities(userId, activities, tx);
    // Never move the cursor back: an older job finishing late must not re-open synced days.
    await recordGarminSuccess(tx, userId, {
      lastSyncAt: sql`greatest(${garminConnection.lastSyncAt}, ${cursor.toISOString()}::timestamptz)`,
    });
    return written;
  });
}

// The sync running in this process for each user; an entry leaves when its sync settles.
const inFlight = new Map<string, Promise<SyncGarminResult>>();

/**
 * Pulls the user's runs from Garmin into `activity`, from the last sync (minus a day) or 30 days back, up
 * to the user's local date today, in 7-day chunks oldest first.
 *
 * Single-flight per user: a call while the user's sync runs in this process returns that sync's promise
 * and shares its result or error, instead of waiting behind the lock to log in to Garmin a second time for
 * a range the first one just read. That happens when Sync now is tapped during the app-open sync, when the
 * cron's job runs during either, or with the app open in two tabs. In memory is enough because one
 * process serves the app (SPEC: Hosting); withUserLock still serializes a sync with other Garmin work for
 * the user and with any other process. A joining caller's `now` and `signal` are not used: the sync it
 * joins reads its own.
 */
export function syncGarmin(input: SyncGarminInput): Promise<SyncGarminResult> {
  const running = inFlight.get(input.userId);
  if (running) return running;
  const sync = runSync(input).finally(() => {
    // Removes only this sync's own entry, never one a later sync set.
    if (inFlight.get(input.userId) === sync) inFlight.delete(input.userId);
  });
  inFlight.set(input.userId, sync);
  return sync;
}

/**
 * One sync for syncGarmin. Runs inside the per-user lock, so it never overlaps other Garmin calls for the
 * user. Each chunk commits on its own connection (not the lock's transaction): a kill or an error keeps
 * the finished chunks and the cursor, and the next run resumes there. A bundle Garmin rotated is written
 * back the moment the client hands it over, before the call returns or throws, because the old refresh
 * token no longer works. A finished sync then queues the user's best efforts when runs are pending,
 * outside the lock the batch also takes.
 */
async function runSync({ userId, now, signal }: SyncGarminInput): Promise<SyncGarminResult> {
  const synced = await withUserLock(userId, async () => {
    const account = await openGarminAccount(userId);
    const timeZone = account.connection.timezone;
    const today = localDateOf(now ?? new Date(), timeZone);
    const startDate = syncStartDate(account.connection.lastSyncAt, timeZone, today);
    const chunks = dateChunks(startDate, today, SYNC_CHUNK_DAYS);
    let activitiesSeen = 0;
    let activitiesWritten = 0;

    for (const [index, chunk] of chunks.entries()) {
      signal?.throwIfAborted();
      if (index > 0 && CHUNK_GAP_MS > 0) await sleep(CHUNK_GAP_MS, undefined, { signal });

      const response = await account.call((tokenBundle, options) =>
        garminClient.sync({ tokenBundle, startDate: chunk.start, endDate: chunk.end }, options),
      );

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
  // Also when this sync wrote nothing: runs left pending by an earlier stop (an expired login since
  // reconnected, a rule version bump) start again here.
  await queueBestEfforts(userId);
  return synced;
}

/**
 * POST /api/sync: Sync now, also run by the web app when it opens. Runs in the request instead of the job
 * queue, so a 409, 429 or 502 reaches the runner who asked rather than hiding behind the job's retries
 * minutes later. A 429 is not deferred here: the runner sees it and decides when to try again. A request
 * during a running sync joins it (syncGarmin) and answers with its outcome.
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
