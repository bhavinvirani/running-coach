import { setTimeout as sleep } from "node:timers/promises";
import {
  type GarminActivitySummary,
  type GarminRecentRuns,
  RECENT_RUNS_CHECKED,
  type SyncResponse,
} from "@running-coach/shared";
import { type Column, and, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { type Db, type DbTransaction, db } from "../db/client";
import { activity, garminConnection, shoe } from "../db/schema";
import { garminClient } from "../garmin/client";
import { config } from "../lib/config";
import { addDays, dateChunks, daysBetween, localDateOf, noonUtc } from "../lib/local-date";
import { withUserLock } from "../lib/locks";
import { logger } from "../lib/logger";
import { queueBestEfforts } from "./best-efforts";
import { garminNotConnected, openGarminAccount, recordGarminSuccess } from "./garmin-account";
import { queueRunInsights } from "./insights";
import { gapReEntry } from "./re-entry";
import { matchPlanSessions } from "./session-match";
import { queueWeeklyReview } from "./weekly-review";
import { queueWorkoutPush } from "./workout-push";

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
  return (await writeActivities(userId, summaries, executor)).written;
}

export interface WrittenActivities {
  /** Rows inserted or changed. */
  written: number;
  /** Ids of the rows inserted, not changed: the runs new to the app. */
  insertedIds: string[];
}

export interface WriteActivitiesOptions {
  /**
   * A local date (YYYY-MM-DD): new rows whose local start date is on or after it wear the user's active
   * pair, if any. The sync passes its window's start and the history import the window the next sync
   * would read, so a run gets the same pair whichever of them stores it first, and a run older than any
   * sync would insert gets none.
   */
  wearActivePairFrom?: string;
}

/**
 * The user's active pair, null for none, held with a key share lock until the executor's transaction
 * commits: a concurrent delete of the pair waits for the commit, and its on-delete set null then clears
 * the runs inserted here, instead of failing their foreign key. Both callers pass a transaction.
 */
async function lockedActivePair(
  userId: string,
  executor: Db | DbTransaction,
): Promise<string | null> {
  const [pair] = await executor
    .select({ id: shoe.id })
    .from(shoe)
    .where(and(eq(shoe.userId, userId), eq(shoe.active, true)))
    .for("key share");
  return pair?.id ?? null;
}

/** upsertActivities, also telling the inserted rows from the changed ones. */
export async function writeActivities(
  userId: string,
  summaries: GarminActivitySummary[],
  executor: Db | DbTransaction = db,
  { wearActivePairFrom }: WriteActivitiesOptions = {},
): Promise<WrittenActivities> {
  if (summaries.length === 0) return { written: 0, insertedIds: [] };
  const activePair =
    wearActivePairFrom === undefined ? null : await lockedActivePair(userId, executor);
  // In the INSERT values only, never in the DO UPDATE set below: a run takes the active pair once, when it
  // is new, so a re-sync, an edited run, a partial sync or overlapping syncs never reassign it, and a pair
  // the runner changed or cleared stays.
  const shoeIdOf = (summary: GarminActivitySummary): string | null =>
    activePair !== null &&
    wearActivePairFrom !== undefined &&
    summary.startLocal.slice(0, "YYYY-MM-DD".length) >= wearActivePairFrom
      ? activePair
      : null;
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
        shoeId: shoeIdOf(summary),
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
    // xmax is 0 on a row this statement inserted and set on one its ON CONFLICT updated.
    .returning({ id: activity.id, inserted: sql<boolean>`(xmax = 0)` });
  return {
    written: rows.length,
    insertedIds: rows.filter((row) => row.inserted).map((row) => row.id),
  };
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
 * Saves one finished chunk: runs (a new one wears the active pair, by the rule on
 * WriteActivitiesOptions, from the sync's window start), then on the last chunk the removal of runs
 * deleted on Garmin, then the cursor, together.
 */
async function saveChunk(
  userId: string,
  response: { activities: GarminActivitySummary[]; recent: GarminRecentRuns | null },
  cursor: Date,
  syncStart: string,
): Promise<WrittenActivities & { removed: number }> {
  return db.transaction(async (tx) => {
    const { written, insertedIds } = await writeActivities(userId, response.activities, tx, {
      wearActivePairFrom: syncStart,
    });
    // Null when not asked for (an earlier chunk) or when Garmin would not list them: nothing is checked.
    const removed = response.recent
      ? await removeRunsDeletedOnGarmin(userId, response.recent, tx)
      : 0;
    // Never move the cursor back: an older job finishing late must not re-open synced days.
    await recordGarminSuccess(tx, userId, {
      lastSyncAt: sql`greatest(${garminConnection.lastSyncAt}, ${cursor.toISOString()}::timestamptz)`,
    });
    return { written, insertedIds, removed };
  });
}

/**
 * The plan after a sync (slice 9): sessions matched with the runs on their dates, then the re-entry when
 * a run of the last 7 days ends 7 or more days without one (gapReEntry), and a workout push for what that
 * changed, then the weekly review of the runner's last ended week (slice 10), which reads the matched
 * statuses and the eased sessions. Each step has its own try (queueWeeklyReview never throws), so a failed
 * match still checks the gap and queues the review; none throws, so a stored run never fails the sync over
 * them. All look at the stored runs, not at what this sync inserted, so the next sync redoes what failed;
 * the error is logged.
 */
async function adaptPlan(userId: string, now: Date): Promise<void> {
  try {
    await matchPlanSessions(userId, now);
  } catch (err) {
    log.error({ err, userId }, "sessions not matched after the sync; the next sync matches again");
  }
  try {
    const eased = await gapReEntry(userId, now);
    if (eased !== null && eased.sessionsChanged > 0) await queueWorkoutPush(userId);
  } catch (err) {
    log.error({ err, userId }, "gap not checked after the sync; the next sync checks it again");
  }
  await queueWeeklyReview(userId, now);
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
 * token no longer works. Finished or not, the sync then adapts the plan to the runs stored (adaptPlan)
 * and queues the coach's card for each run it inserted that started in the last INSIGHT_WINDOW_DAYS,
 * when the user has a Claude key (queueRunInsights). A finished sync then queues the user's best efforts
 * when runs are pending, outside the lock the batch also takes.
 */
async function runSync({ userId, now, signal }: SyncGarminInput): Promise<SyncGarminResult> {
  // Runs new to the app across chunks, and the clock the sync read today from, for the coach below.
  const insertedIds: string[] = [];
  let clock = now ?? new Date();
  const synced = await withUserLock(userId, async () => {
    const account = await openGarminAccount(userId);
    const timeZone = account.connection.timezone;
    clock = now ?? new Date();
    const today = localDateOf(clock, timeZone);
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
      const saved = await saveChunk(userId, response, cursor, startDate);
      activitiesWritten += saved.written;
      activitiesRemoved += saved.removed;
      insertedIds.push(...saved.insertedIds);
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
  }).finally(async () => {
    // Also after a failed chunk: the runs the chunks before it stored would not be new to the next sync.
    // The plan first, so the coach reads fresh statuses and the next session as eased.
    await adaptPlan(userId, clock);
    // The coach for the runs this sync inserted, never one it updated; the history import queues none.
    await queueRunInsights(userId, insertedIds, clock);
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
  // A disconnect waiting on the lock can forget the login between the sync's end and this read.
  if (!row) throw garminNotConnected();
  // Every finished chunk moves the cursor, and a sync that returns finished at least one.
  if (!row.lastSyncAt) throw new Error("The sync finished without saving its cursor");
  return { lastSyncAt: row.lastSyncAt.toISOString(), activitiesWritten, activitiesRemoved };
}
