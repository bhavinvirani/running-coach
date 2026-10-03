import { setTimeout as sleep } from "node:timers/promises";
import {
  type GarminActivitySummary,
  type GarminRecentRuns,
  RECENT_RUNS_CHECKED,
  type SyncResponse,
} from "@running-coach/shared";
import { type Column, and, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
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
/**
 * At most this many stored runs go in one sync because Garmin no longer lists them. More at once is a
 * Garmin glitch (a short or wrong answer), not a runner deleting runs, so then none go.
 */
export const MAX_RUNS_REMOVED_PER_SYNC = 10;

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
  /** Stored runs removed because Garmin no longer lists them (removeRunsDeletedOnGarmin). */
  activitiesRemoved: number;
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

/**
 * Deletes the user's stored runs that Garmin's newest runs should hold but do not: deleted on Garmin, or
 * changed there to another sport, which the running list leaves out too. The checked range is every run
 * that started after the oldest listed one on both clocks, local and UTC, or the whole history when Garmin
 * listed fewer items than the RECENT_RUNS_CHECKED the sync asks for, since the list then reached the first
 * run; a run deleted further back is not seen. Both clocks because Garmin orders the list by local start,
 * which UTC order can contradict (a flight over the date line, DST, a watch on the wrong zone): a run newer
 * in UTC but older on the clock may sit past the list's end, and the range holds whichever order Garmin
 * uses. Removes nothing when the list holds no run, or when more than
 * MAX_RUNS_REMOVED_PER_SYNC would go: a mass disappearance is a Garmin glitch, not the runner, and is
 * logged instead. Each run's laps, streams, best efforts and coach messages go with it (on delete
 * cascade), so personal bests come from the remaining runs; a plan session keeps its date and status and
 * loses the link. Returns the number removed.
 */
export async function removeRunsDeletedOnGarmin(
  userId: string,
  recent: GarminRecentRuns,
  executor: Db | DbTransaction = db,
): Promise<number> {
  const listedAll = recent.listed < RECENT_RUNS_CHECKED;
  // Strictly after the oldest listed run: one that started at the same instant may be the next item. The
  // oldest starts are null only when no run is listed (the contract), and then nothing is removed below.
  const inRange =
    listedAll || recent.oldestStartUtc === null || recent.oldestStartLocal === null
      ? undefined
      : and(
          gt(activity.startUtc, new Date(recent.oldestStartUtc)),
          gt(activity.startLocal, recent.oldestStartLocal),
        );
  const listed = recent.garminActivityIds;
  const missing = await executor
    .select({ id: activity.id, garminActivityId: activity.garminActivityId })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        inRange,
        listed.length > 0 ? notInArray(activity.garminActivityId, listed) : undefined,
      ),
    );
  if (missing.length === 0) return 0;
  if (listed.length === 0) {
    log.warn(
      { userId, stored: missing.length, listedItems: recent.listed },
      "Garmin listed no runs while runs are stored: removed none",
    );
    return 0;
  }
  if (missing.length > MAX_RUNS_REMOVED_PER_SYNC) {
    log.warn(
      { userId, missing: missing.length, max: MAX_RUNS_REMOVED_PER_SYNC },
      "too many stored runs missing from Garmin's newest runs: removed none",
    );
    return 0;
  }
  await executor.delete(activity).where(
    inArray(
      activity.id,
      missing.map((run) => run.id),
    ),
  );
  log.info(
    {
      userId,
      removed: missing.length,
      garminActivityIds: missing.map((run) => run.garminActivityId),
    },
    "removed runs Garmin no longer lists",
  );
  return missing.length;
}

/**
 * Saves one finished chunk: runs, then on the last chunk the removal of runs deleted on Garmin, then the
 * cursor, together.
 */
async function saveChunk(
  userId: string,
  response: { activities: GarminActivitySummary[]; recent: GarminRecentRuns | null },
  cursor: Date,
): Promise<{ written: number; removed: number }> {
  return db.transaction(async (tx) => {
    const written = await upsertActivities(userId, response.activities, tx);
    // Null when not asked for (an earlier chunk) or when Garmin would not list them: nothing is checked.
    const removed = response.recent
      ? await removeRunsDeletedOnGarmin(userId, response.recent, tx)
      : 0;
    // Never move the cursor back: an older job finishing late must not re-open synced days.
    await recordGarminSuccess(tx, userId, {
      lastSyncAt: sql`greatest(${garminConnection.lastSyncAt}, ${cursor.toISOString()}::timestamptz)`,
    });
    return { written, removed };
  });
}

// The sync running in this process for each user; an entry leaves when its sync settles.
const inFlight = new Map<string, Promise<SyncGarminResult>>();

/**
 * Pulls the user's runs from Garmin into `activity`, from the last sync (minus a day) or 30 days back, up
 * to the user's local date today, in 7-day chunks oldest first. The last chunk also lists Garmin's newest
 * RECENT_RUNS_CHECKED runs under the same login and removes stored runs Garmin no longer lists
 * (removeRunsDeletedOnGarmin).
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
    let activitiesRemoved = 0;

    for (const [index, chunk] of chunks.entries()) {
      signal?.throwIfAborted();
      if (index > 0 && CHUNK_GAP_MS > 0) await sleep(CHUNK_GAP_MS, undefined, { signal });

      const isLast = index === chunks.length - 1;
      // Once per sync: one more paced call under the chunk's login, never another login.
      const recentLimit = isLast ? RECENT_RUNS_CHECKED : 0;
      const response = await account.call((tokenBundle, options) =>
        garminClient.sync(
          { tokenBundle, startDate: chunk.start, endDate: chunk.end, recentLimit },
          options,
        ),
      );

      // The last chunk ends today: the cursor is now. Earlier chunks end on a past day (and so does a
      // pinned `now` in the past): noon UTC of it, whose local date is that day or the next, so the one-day
      // overlap re-reads it either way.
      const finishedAt = new Date();
      const cursor =
        isLast && localDateOf(finishedAt, timeZone) === today ? finishedAt : noonUtc(chunk.end);
      activitiesSeen += response.activities.length;
      const saved = await saveChunk(userId, response, cursor);
      activitiesWritten += saved.written;
      activitiesRemoved += saved.removed;
    }

    const result = {
      startDate,
      endDate: today,
      chunks: chunks.length,
      activitiesSeen,
      activitiesWritten,
      activitiesRemoved,
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
  const { activitiesWritten, activitiesRemoved } = await syncGarmin({ userId });
  const [row] = await db
    .select({ lastSyncAt: garminConnection.lastSyncAt })
    .from(garminConnection)
    .where(eq(garminConnection.userId, userId));
  // Every finished chunk moves the cursor, and a sync that returns finished at least one.
  if (!row?.lastSyncAt) throw new Error("The sync finished without saving its cursor");
  return { lastSyncAt: row.lastSyncAt.toISOString(), activitiesWritten, activitiesRemoved };
}
