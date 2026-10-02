import { BEST_EFFORTS_VERSION, bestEfforts } from "@running-coach/engine";
import {
  DISTANCE_METERS,
  type DistanceKey,
  distanceKeySchema,
  ErrorCode,
  errorCodeSchema,
  GARMIN_SERIES_BATCH_MAX,
  type GarminActivitySeries,
  type PersonalBest,
  type PersonalBestsResponse,
  type RunBestEffort,
} from "@running-coach/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { type Db, type DbTransaction, db } from "../db/client";
import { activity, bestEffort, garminConnection } from "../db/schema";
import { garminClient } from "../garmin/client";
import * as bestEffortsQueue from "../jobs/best-efforts-queue";
import { findPendingJob, hasWaitingJob } from "../jobs/boss";
import { DomainError } from "../lib/errors";
import { withUserLock } from "../lib/locks";
import { logger } from "../lib/logger";
import { isoLocal } from "./activities";
import { openGarminAccount, recordGarminSuccess } from "./garmin-account";

// Best efforts and personal bests (SPEC: best_effort). Each outdoor run's 1 s series is fetched from Garmin
// once, in batches under the user lock, and only the efforts the engine finds in it are stored. A personal
// best is a query: the fastest stored effort per distance over runs that still count.

const log = logger.child({ module: "best-efforts" });

/**
 * Runs that can hold best efforts: outdoor, recorded by a device, and long enough for the shortest
 * distance. Treadmill, indoor and manual runs have no trustworthy distance series, so they are never
 * fetched, and a run that becomes one of them later drops out of the bests.
 */
const eligible = and(
  eq(activity.isIndoor, false),
  eq(activity.isManual, false),
  gte(activity.distanceM, DISTANCE_METERS["1k"]),
);

/**
 * Runs whose stored efforts count toward the personal bests: eligible, and not edited since the efforts
 * were computed (a null version) until they are again. Efforts from an older rule still count while they
 * wait to be recomputed.
 */
const counted = and(eligible, isNotNull(activity.bestEffortsVersion));

/**
 * Tries before a run is given up: batches in which Garmin failed to read the run while it read another
 * run asked with it. A run Garmin cannot read (a broken file on its side) would otherwise come back in
 * every batch, each one a Garmin login. A sync that changes the run's distance or time starts the count
 * again.
 */
export const BEST_EFFORTS_MAX_ATTEMPTS = 3;

/**
 * Seconds a run waits after a batch failed on it before a batch takes it again. Batches chain 30 s apart,
 * so without the wait a passing Garmin error would use up a run's tries in minutes; spaced 6 h, three
 * failed tries tell a broken run from a bad hour, and the runs behind it go first meanwhile.
 */
export const BEST_EFFORTS_RETRY_AFTER_S = 6 * 60 * 60;

/**
 * Eligible runs never computed, changed since (a null version), or computed by an older rule, unless
 * Garmin failed to read them BEST_EFFORTS_MAX_ATTEMPTS times.
 */
const pending = and(
  eligible,
  or(isNull(activity.bestEffortsVersion), lt(activity.bestEffortsVersion, BEST_EFFORTS_VERSION)),
  lt(activity.bestEffortsAttempts, BEST_EFFORTS_MAX_ATTEMPTS),
);

/** Runs no batch failed on in the last BEST_EFFORTS_RETRY_AFTER_S: a pending one is due. */
const rested = or(
  isNull(activity.bestEffortsFailedAt),
  lt(
    activity.bestEffortsFailedAt,
    sql`now() - make_interval(secs => ${BEST_EFFORTS_RETRY_AFTER_S})`,
  ),
);

/**
 * Pending runs by whether a batch may take them now (due) or they wait out BEST_EFFORTS_RETRY_AFTER_S.
 * Takes the caller's transaction, so it also counts runs it has not committed yet.
 */
async function countPendingRuns(
  userId: string,
  executor: Db | DbTransaction = db,
): Promise<{ due: number; waiting: number }> {
  const [row] = await executor
    .select({
      all: count(),
      due: sql<number>`count(*) filter (where ${rested})`.mapWith(Number),
    })
    .from(activity)
    .where(and(eq(activity.userId, userId), pending));
  const due = row?.due ?? 0;
  return { due, waiting: (row?.all ?? 0) - due };
}

/**
 * The batch's canary: the user's newest run computed at the current rule that holds at least one effort,
 * so Garmin gave it samples before, and that never came back without them since. A batch stamps
 * best_efforts_failed_at on a computed run only when it came back without samples, as the canary or in an
 * outage, and recomputing the run clears it, so a canary deleted on Garmin is never picked again and the
 * next-newest computed run takes over. Undefined until a first batch stored an effort.
 */
async function findCanary(userId: string) {
  const [canary] = await db
    .select({ id: activity.id, garminActivityId: activity.garminActivityId })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        eligible,
        eq(activity.bestEffortsVersion, BEST_EFFORTS_VERSION),
        isNull(activity.bestEffortsFailedAt),
        exists(
          db
            .select({ one: sql`1` })
            .from(bestEffort)
            .where(eq(bestEffort.activityId, activity.id)),
        ),
      ),
    )
    .orderBy(desc(activity.startUtc), desc(activity.garminActivityId))
    .limit(1);
  return canary;
}

export interface BestEffortsBatchResult {
  /** Runs marked done in this batch, with or without efforts. */
  processed: number;
  /** Runs Garmin could not read while it read another: one try counted, waiting until tried again. */
  failed: number;
  /** Runs the Garmin service never asked about (it stopped early): pending as they were, no try counted. */
  skipped: number;
  /** Pending runs a next batch may take now; the job queues its successor while any are. */
  remaining: number;
  /** Pending runs waiting out BEST_EFFORTS_RETRY_AFTER_S after a failure; the next sync queues them. */
  waiting: number;
}

function garminDown(): DomainError {
  return new DomainError(
    ErrorCode.garminUnavailable,
    502,
    "Garmin is not answering. Try again later.",
  );
}

/** Whether Garmin read the run: "ok" with samples. */
function hasSamples(series: GarminActivitySeries): boolean {
  return series.outcome === "ok" && series.elapsedS.length > 0;
}

interface AskedRun {
  id: string;
  garminActivityId: number;
}

interface AnsweredRun {
  run: AskedRun;
  series: GarminActivitySeries;
}

/** What one series answer says, read before anything is written (computeBestEffortsBatch). */
type SeriesReading =
  /** The service broke its contract (every id answered, in request order): nothing in it is trusted. */
  | { verdict: "out_of_order" }
  /** Garmin read no run: an outage. `stamp`: the runs it was asked about, none with samples. */
  | { verdict: "down"; stamp: string[] }
  /** The canary read, then the service stopped before any run of the batch: nothing learned. */
  | { verdict: "nothing_learned" }
  /** Garmin works: each run of the batch has its own outcome. `retiredCanaryId`: a canary without samples. */
  | { verdict: "works"; batch: AnsweredRun[]; retiredCanaryId: string | null };

/** Reads the answer to `asked`, whose first run is the canary when `withCanary`. */
function readSeriesAnswer(
  asked: readonly AskedRun[],
  answers: readonly GarminActivitySeries[],
  withCanary: boolean,
): SeriesReading {
  const answered: AnsweredRun[] = [];
  for (const [index, run] of asked.entries()) {
    const answer = answers[index];
    // Marking runs done on another run's answer would hide their efforts for good.
    if (answer?.garminActivityId !== run.garminActivityId) return { verdict: "out_of_order" };
    answered.push({ run, series: answer });
  }
  if (!answered.some(({ series }) => hasSamples(series))) {
    // Not the skipped runs: never asked, they are the ones the retry starts with.
    const stamp = answered
      .filter(({ series }) => series.outcome !== "skipped")
      .map(({ run }) => run.id);
    return { verdict: "down", stamp };
  }
  const canary = withCanary ? answered[0] : undefined;
  const batch = withCanary ? answered.slice(1) : answered;
  if (canary && batch.every(({ series }) => series.outcome === "skipped")) {
    return { verdict: "nothing_learned" };
  }
  return {
    verdict: "works",
    batch,
    retiredCanaryId: canary && !hasSamples(canary.series) ? canary.run.id : null,
  };
}

/**
 * Computes the best efforts of up to GARMIN_SERIES_BATCH_MAX due runs, never-failed first, then newest,
 * with one Garmin call inside the per-user lock (the gates, bundle write-back and failure bookkeeping of
 * openGarminAccount). The batch that takes the last due runs also fetches Garmin's own records. Nothing due
 * returns at once without calling Garmin, which makes a duplicate job, or one whose runs all wait, a no-op.
 *
 * Garmin works when any run asked came back "ok" with samples. The canary (findCanary) is asked first,
 * beside one fewer pending run, so the service's early stop after two failures in a row cannot skip it, and
 * its answer is never written: it is what tells a batch of runs deleted or empty on Garmin from an outage,
 * which is how such a batch reads before the user has a canary. A canary that comes back without samples
 * (deleted on Garmin) leaves canary duty for good, stamped best_efforts_failed_at, and the next-newest
 * computed run takes over.
 *
 * An outage (no run with samples) writes no outcome and counts no try: the runs asked that came back
 * without samples, the canary included, are stamped best_efforts_failed_at, so they wait
 * BEST_EFFORTS_RETRY_AFTER_S (6 h) and the retry starts with the runs behind them, skipped ones first (a
 * first pass gets past broken newest runs; a real outage only delays the stamped runs). A canary that
 * came back while every run of the batch was skipped (the service spent its time budget on the canary)
 * taught nothing, and nothing is written. Both throw garmin_unavailable inside the call, which records it
 * on the connection, and the job retries with pg-boss's backoff and limit, never chaining its 30 s
 * successor. The stamp is its own write after the call, so a failed write is not recorded as Garmin's
 * failure, and it survives the throw. An answer out of request order, a bug in the service, throws a
 * plain Error after the call and leaves the connection as it was.
 *
 * Otherwise, in one transaction: an "ok" run's rows are replaced and its version set, so a recompute writes
 * the same rows and a kill leaves the run pending; a "gone" run (deleted on Garmin) is done with no rows; a
 * "failed" run counts a try, stamped so it waits BEST_EFFORTS_RETRY_AFTER_S, and is given up at
 * BEST_EFFORTS_MAX_ATTEMPTS; a "skipped" run (the service stopped early, after failures in a row or at its
 * time budget) is left exactly as it was, so a run never fetched is never given up.
 */
export async function computeBestEffortsBatch(
  userId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<BestEffortsBatchResult> {
  return withUserLock(userId, async () => {
    // One more than a batch tells whether this batch takes the last due runs, without a count.
    const candidates = await db
      .select({ id: activity.id, garminActivityId: activity.garminActivityId })
      .from(activity)
      .where(and(eq(activity.userId, userId), pending, rested))
      .orderBy(
        asc(activity.bestEffortsAttempts),
        desc(activity.startUtc),
        desc(activity.garminActivityId),
      )
      .limit(GARMIN_SERIES_BATCH_MAX + 1);
    if (candidates.length === 0) {
      const { waiting } = await countPendingRuns(userId);
      return { processed: 0, failed: 0, skipped: 0, remaining: 0, waiting };
    }
    const canary = await findCanary(userId);
    const size = canary ? GARMIN_SERIES_BATCH_MAX - 1 : GARMIN_SERIES_BATCH_MAX;
    const batch = candidates.slice(0, size);
    const includeRecords = candidates.length <= size;
    const asked = canary ? [canary, ...batch] : batch;

    const account = await openGarminAccount(userId);
    signal?.throwIfAborted();
    // The runs an outage stamps, handed out of the call to be written after it.
    const outageRuns: string[] = [];
    const response = await account
      .call(async (tokenBundle, options) => {
        const answer = await garminClient.series(
          {
            tokenBundle,
            garminActivityIds: asked.map((run) => run.garminActivityId),
            includeRecords,
          },
          options,
        );
        const reading = readSeriesAnswer(asked, answer.series, canary !== undefined);
        if (reading.verdict === "down" || reading.verdict === "nothing_learned") {
          if (reading.verdict === "down") outageRuns.push(...reading.stamp);
          log.warn(
            {
              userId,
              runs: batch.length,
              canary: canary !== undefined,
              verdict: reading.verdict,
              ...outcomeCounts(answer.series),
            },
            "garmin read no run, or only the canary before the service ran out of time; the job retries",
          );
          // The one error thrown in the call, so the connection records it like any other Garmin failure;
          // a bundle Garmin rotated is already stored by then.
          throw garminDown();
        }
        return { reading, records: answer.records, series: answer.series };
      })
      .catch(async (error: unknown) => {
        // Outside the lock's transaction, so it survives the rethrow.
        if (outageRuns.length > 0) {
          await db
            .update(activity)
            .set({ bestEffortsFailedAt: sql`now()`, updatedAt: sql`${activity.updatedAt}` })
            .where(inArray(activity.id, outageRuns));
        }
        throw error;
      });
    const { reading } = response;
    if (reading.verdict === "out_of_order") {
      throw new Error("The Garmin service answered the series out of request order");
    }

    // The canary's answer is never written, beyond taking it off duty.
    const answered = reading.batch;
    // A "skipped" run is in neither list: no row of it is touched.
    const doneIds = answered
      .filter(({ series }) => series.outcome === "ok" || series.outcome === "gone")
      .map(({ run }) => run.id);
    const failedIds = answered
      .filter(({ series }) => series.outcome === "failed")
      .map(({ run }) => run.id);
    const skipped = answered.filter(({ series }) => series.outcome === "skipped").length;
    const rows = answered.flatMap(({ run, series }) =>
      series.outcome === "ok"
        ? bestEfforts(series).map((effort) => ({ userId, activityId: run.id, ...effort }))
        : [],
    );

    const givenUp = await db.transaction(async (tx) => {
      // updated_at stays: it records the last change Garmin made to the run, and this is bookkeeping.
      const keepUpdatedAt = sql`${activity.updatedAt}`;
      if (doneIds.length > 0) {
        await tx.delete(bestEffort).where(inArray(bestEffort.activityId, doneIds));
        if (rows.length > 0) await tx.insert(bestEffort).values(rows);
        await tx
          .update(activity)
          .set({
            bestEffortsVersion: BEST_EFFORTS_VERSION,
            bestEffortsAttempts: 0,
            bestEffortsFailedAt: null,
            updatedAt: keepUpdatedAt,
          })
          .where(inArray(activity.id, doneIds));
      }
      const failedRuns =
        failedIds.length === 0
          ? []
          : await tx
              .update(activity)
              .set({
                bestEffortsAttempts: sql`${activity.bestEffortsAttempts} + 1`,
                bestEffortsFailedAt: sql`now()`,
                updatedAt: keepUpdatedAt,
              })
              .where(inArray(activity.id, failedIds))
              .returning({ id: activity.id, attempts: activity.bestEffortsAttempts });
      if (reading.retiredCanaryId !== null) {
        await tx
          .update(activity)
          .set({ bestEffortsFailedAt: sql`now()`, updatedAt: keepUpdatedAt })
          .where(eq(activity.id, reading.retiredCanaryId));
      }
      if (response.records !== null) {
        await tx
          .update(garminConnection)
          .set({ garminRecords: response.records, garminRecordsAt: sql`now()` })
          .where(eq(garminConnection.userId, userId));
      }
      // Some run came back "ok" with samples, or this would have been an outage: the login works.
      await recordGarminSuccess(tx, userId);
      return failedRuns
        .filter((run) => run.attempts >= BEST_EFFORTS_MAX_ATTEMPTS)
        .map((run) => run.id);
    });

    const { due, waiting } = await countPendingRuns(userId);
    const result = {
      processed: doneIds.length,
      failed: failedIds.length,
      skipped,
      remaining: due,
      waiting,
    };
    if (reading.retiredCanaryId !== null) {
      log.warn(
        { userId, activityId: reading.retiredCanaryId },
        "the canary came back without samples; the next computed run takes over",
      );
    }
    if (givenUp.length > 0) {
      log.warn(
        { userId, activityIds: givenUp, attempts: BEST_EFFORTS_MAX_ATTEMPTS },
        "garmin could not read these runs again; their best efforts are given up",
      );
    }
    log.info(
      {
        userId,
        ...result,
        canary: canary !== undefined,
        ...outcomeCounts(response.series),
        efforts: rows.length,
        records: response.records?.length ?? null,
      },
      "best efforts computed",
    );
    return result;
  });
}

/** Counts for the log: runs per outcome, and "ok" runs without a sample. */
function outcomeCounts(series: readonly GarminActivitySeries[]) {
  return {
    ok: series.filter((run) => run.outcome === "ok").length,
    gone: series.filter((run) => run.outcome === "gone").length,
    failed: series.filter((run) => run.outcome === "failed").length,
    skipped: series.filter((run) => run.outcome === "skipped").length,
    empty: series.filter((run) => run.outcome === "ok" && run.elapsedS.length === 0).length,
  };
}

/**
 * Queues a best-efforts batch when the user has runs a batch may take now, unless a job of theirs waits to
 * start: a waiting or deferred one re-reads what is pending when it runs, so it covers new runs, and a
 * fresh one beside a retrying one would call Garmin before the retry's backoff ran out. Beside a running
 * job it sends, since that job may have read what is pending before these runs were stored: the stately
 * queue keeps one waiting job beside the running one and folds the running job's own successor into it. A
 * sync calls it after committing its runs; an import page calls it inside its transaction (`executor`,
 * which also counts the page's runs), so the job is pending before the import can read as done. Never
 * throws on its own: a failed send must not fail the sync or the page that called it, and the next one
 * queues it again (a failed count inside the caller's transaction still fails that transaction).
 */
export async function queueBestEfforts(
  userId: string,
  executor: Db | DbTransaction = db,
): Promise<string | null> {
  try {
    if ((await countPendingRuns(userId, executor)).due === 0) return null;
    if (await hasWaitingJob(bestEffortsQueue.name, userId)) return null;
    return await bestEffortsQueue.enqueueBestEfforts({ userId });
  } catch (err) {
    log.error({ err, userId }, "best-efforts batch not queued; the next sync queues it again");
    return null;
  }
}

/**
 * Queues a batch for every user with runs a batch may take now, once the workers run at boot. A deploy
 * that raises BEST_EFFORTS_VERSION, or the first one with best efforts, leaves stored runs pending, and
 * otherwise nothing would queue them before each user's next sync. Never throws, so boot goes on: a failure
 * is logged, and the next sync queues the work again. Returns how many batches were queued.
 */
export async function queuePendingBestEfforts(): Promise<number> {
  let users: { userId: string }[];
  try {
    users = await db
      .selectDistinct({ userId: activity.userId })
      .from(activity)
      .where(and(pending, rested));
  } catch (err) {
    log.error({ err }, "pending best efforts not queued at boot; the next sync queues them");
    return 0;
  }
  let queued = 0;
  for (const { userId } of users) {
    if ((await queueBestEfforts(userId)) !== null) queued += 1;
  }
  log.info({ users: users.length, queued }, "pending best efforts queued at boot");
  return queued;
}

const DISTANCE_ORDER = new Map(distanceKeySchema.options.map((key, index) => [key, index]));

/** Shortest distance first, in distanceKeySchema's order. */
function byDistance(a: { distanceKey: DistanceKey }, b: { distanceKey: DistanceKey }): number {
  return (DISTANCE_ORDER.get(a.distanceKey) ?? 0) - (DISTANCE_ORDER.get(b.distanceKey) ?? 0);
}

/**
 * The personal bests: the fastest stored effort per distance over the user's runs that count, one row per
 * distance in no set order; an exact tie goes to the earlier run. The one query behind GET
 * /api/personal-bests and a run's personal-best flags (getRunBestEfforts), so the two never disagree. A
 * builder, so a caller awaits it or joins it as a subquery.
 */
function fastestEfforts(userId: string) {
  return db
    .selectDistinctOn([bestEffort.distanceKey], {
      distanceKey: bestEffort.distanceKey,
      timeS: bestEffort.timeS,
      activityId: activity.id,
      startUtc: activity.startUtc,
      startLocal: activity.startLocal,
    })
    .from(bestEffort)
    .innerJoin(activity, eq(activity.id, bestEffort.activityId))
    .where(and(eq(bestEffort.userId, userId), counted))
    .orderBy(
      bestEffort.distanceKey,
      asc(bestEffort.timeS),
      asc(activity.startUtc),
      // Garmin ids grow over time, so they break a tie between two runs saved with the same start.
      asc(activity.garminActivityId),
    );
}

/**
 * GET /api/activities/:id's best efforts: the run's own, shortest first, each a personal best when the run
 * is the one fastestEfforts picks at that distance. Empty for a run whose efforts do not count (treadmill,
 * indoor, manual, under 1 km, edited since they were computed) and for one not computed yet. One statement,
 * so the run's efforts and the bests are read from one snapshot even while a batch commits.
 */
export async function getRunBestEfforts(
  userId: string,
  activityId: string,
): Promise<RunBestEffort[]> {
  const fastest = fastestEfforts(userId).as("fastest");
  const rows = await db
    .select({
      distanceKey: bestEffort.distanceKey,
      timeS: bestEffort.timeS,
      fastestRunId: fastest.activityId,
    })
    .from(bestEffort)
    .innerJoin(activity, eq(activity.id, bestEffort.activityId))
    // Inner: a run that counts is itself among the efforts the bests are picked from.
    .innerJoin(fastest, eq(fastest.distanceKey, bestEffort.distanceKey))
    .where(and(eq(bestEffort.activityId, activityId), eq(bestEffort.userId, userId), counted));
  return rows
    .map(({ distanceKey, timeS, fastestRunId }) => ({
      distanceKey,
      timeS,
      personalBest: fastestRunId === activityId,
    }))
    .sort(byDistance);
}

/**
 * Why pending runs are not being checked: no Garmin login, an expired one (the next sync after a reconnect
 * queues the work), or the error the last Garmin call ended with, when it is one of this app's codes, which
 * is also what holds back a deferred or retrying job. Null when no reason is known: the next sync queues
 * the work again.
 */
function stoppedBecause(
  connection: Pick<typeof garminConnection.$inferSelect, "status" | "lastError"> | undefined,
): ErrorCode | null {
  if (!connection) return ErrorCode.garminNotConnected;
  if (connection.status === "expired") return ErrorCode.garminAuthExpired;
  const code = errorCodeSchema.safeParse(connection.lastError);
  return code.success ? code.data : null;
}

/**
 * GET /api/personal-bests: the bests fastestEfforts picks, shortest first. No Garmin call: Garmin's
 * records are the ones last stored. Also whether a best-efforts job for the user is waiting, deferred,
 * retrying or running (checking), and, while runs are pending with no job or with one held back (a 429's
 * hour, a retry's backoff), why (stoppedBecause), so the screen polls only while something will change and
 * says what holds it.
 *
 * pg-boss is asked first and the tables after: a batch that finishes in between is then visible to the
 * reads, never a job gone with the runs it computed still counted as pending.
 */
export async function getPersonalBests(userId: string): Promise<PersonalBestsResponse> {
  const job = await findPendingJob(bestEffortsQueue.name, userId);
  const [fastest, { due, waiting }, [connection]] = await Promise.all([
    fastestEfforts(userId),
    countPendingRuns(userId),
    db
      .select({
        records: garminConnection.garminRecords,
        fetchedAt: garminConnection.garminRecordsAt,
        status: garminConnection.status,
        lastError: garminConnection.lastError,
      })
      .from(garminConnection)
      .where(eq(garminConnection.userId, userId)),
  ]);

  const bests: PersonalBest[] = fastest
    .map((row) => ({
      ...row,
      startUtc: row.startUtc.toISOString(),
      startLocal: isoLocal(row.startLocal),
    }))
    .sort(byDistance);
  // Runs waiting out their retry spacing count too: they are not done, and the screen says so.
  const pendingRuns = due + waiting;
  return {
    bests,
    garmin:
      connection?.records && connection.fetchedAt
        ? { records: connection.records, fetchedAt: connection.fetchedAt.toISOString() }
        : null,
    pendingRuns,
    checking: job !== null,
    errorCode:
      pendingRuns > 0 && (job === null || job.heldBack) ? stoppedBecause(connection) : null,
  };
}
