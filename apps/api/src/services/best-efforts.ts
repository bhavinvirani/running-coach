import { BEST_EFFORTS_VERSION, bestEfforts } from "@running-coach/engine";
import {
  DISTANCE_METERS,
  distanceKeySchema,
  ErrorCode,
  errorCodeSchema,
  GARMIN_SERIES_BATCH_MAX,
  type GarminActivitySeries,
  type PersonalBest,
  type PersonalBestsResponse,
} from "@running-coach/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db/client";
import { activity, bestEffort, garminConnection } from "../db/schema";
import { garminClient } from "../garmin/client";
import * as bestEffortsQueue from "../jobs/best-efforts-queue";
import { hasPendingJob } from "../jobs/boss";
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
 * Batches in which Garmin failed to read a run while it read others, before the run is given up. A run
 * Garmin cannot read (a broken file on its side) would otherwise come back in every batch, each one a
 * Garmin login; three failures in separate batches (a failed run goes last, so its tries spread out) tell
 * a broken run from a passing error. A sync that changes the run's distance or time starts the count again.
 */
export const BEST_EFFORTS_MAX_ATTEMPTS = 3;

/**
 * Eligible runs never computed, changed since (a null version), or computed by an older rule, unless
 * Garmin failed to read them BEST_EFFORTS_MAX_ATTEMPTS times.
 */
const pending = and(
  eligible,
  or(isNull(activity.bestEffortsVersion), lt(activity.bestEffortsVersion, BEST_EFFORTS_VERSION)),
  lt(activity.bestEffortsAttempts, BEST_EFFORTS_MAX_ATTEMPTS),
);

async function countPendingRuns(userId: string): Promise<number> {
  const [row] = await db
    .select({ runs: count() })
    .from(activity)
    .where(and(eq(activity.userId, userId), pending));
  return row?.runs ?? 0;
}

export interface BestEffortsBatchResult {
  /** Runs marked done in this batch, with or without efforts. */
  processed: number;
  /** Runs Garmin could not read in this batch: pending until BEST_EFFORTS_MAX_ATTEMPTS, tried again last. */
  failed: number;
  /** Runs the Garmin service never asked about (it stopped early): pending as they were, no attempt counted. */
  skipped: number;
  /** Pending runs left after it; the job queues its successor while any are. */
  remaining: number;
}

function garminDown(): DomainError {
  return new DomainError(
    ErrorCode.garminUnavailable,
    502,
    "Garmin is not answering. Try again later.",
  );
}

/**
 * Whether a series answer says Garmin is down rather than anything about these runs, so nothing may be
 * marked: no run came back "ok" or "gone" (every run failed, or the service skipped the rest after failures
 * in a row), or several runs Garmin was asked about all came back without a sample, which is what a moved
 * or blocked details endpoint looks like (one run without samples is a run Garmin holds no detail for). A
 * skipped run says nothing about Garmin either way. One exception: a batch of a single run that failed
 * again after failing while Garmin read others is that run failing, or the last pending run would be
 * retried as an outage after every sync and never given up.
 */
function readsAsOutage(
  batch: readonly { bestEffortsAttempts: number }[],
  series: readonly GarminActivitySeries[],
): boolean {
  if (!series.some((run) => run.outcome === "ok" || run.outcome === "gone")) {
    const loneRunFailedAgain =
      batch.length === 1 &&
      series[0]?.outcome === "failed" &&
      (batch[0]?.bestEffortsAttempts ?? 0) > 0;
    return !loneRunFailedAgain;
  }
  const asked = series.filter((run) => run.outcome !== "skipped");
  return (
    asked.length > 1 && asked.every((run) => run.outcome === "ok" && run.elapsedS.length === 0)
  );
}

/**
 * Computes the best efforts of up to GARMIN_SERIES_BATCH_MAX pending runs, with one Garmin call inside the
 * per-user lock (the gates, bundle write-back and failure bookkeeping of openGarminAccount). Runs that
 * failed before go last, so a run Garmin keeps failing on cannot hold back the others; otherwise newest
 * first. The batch that empties the pending list also fetches Garmin's own records.
 *
 * Each run comes back "ok", "gone", "failed" or "skipped". An answer that reads as Garmin being down
 * (readsAsOutage) throws garmin_unavailable before anything is written, recorded on the connection like any
 * Garmin failure, and the job retries. Otherwise, in one transaction: an "ok" run's rows are replaced and
 * its version set, so a recompute writes the same rows and a kill leaves the run pending; a "gone" run
 * (deleted on Garmin) is done with no rows; a "failed" run counts one more attempt and stays pending until
 * BEST_EFFORTS_MAX_ATTEMPTS; a "skipped" run (the service stopped early, after failures in a row or at its
 * time budget, before asking Garmin about it) is left exactly as it was, so a run never fetched is never
 * given up. Nothing pending returns at once without calling Garmin, which makes a duplicate job a no-op.
 */
export async function computeBestEffortsBatch(
  userId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<BestEffortsBatchResult> {
  return withUserLock(userId, async () => {
    // One more than a batch tells whether this batch empties the list, without a count.
    const candidates = await db
      .select({
        id: activity.id,
        garminActivityId: activity.garminActivityId,
        bestEffortsAttempts: activity.bestEffortsAttempts,
      })
      .from(activity)
      .where(and(eq(activity.userId, userId), pending))
      .orderBy(
        asc(activity.bestEffortsAttempts),
        desc(activity.startUtc),
        desc(activity.garminActivityId),
      )
      .limit(GARMIN_SERIES_BATCH_MAX + 1);
    if (candidates.length === 0) return { processed: 0, failed: 0, skipped: 0, remaining: 0 };
    const batch = candidates.slice(0, GARMIN_SERIES_BATCH_MAX);
    const includeRecords = candidates.length <= GARMIN_SERIES_BATCH_MAX;

    const account = await openGarminAccount(userId);
    signal?.throwIfAborted();
    const response = await account.call(async (tokenBundle, options) => {
      const answer = await garminClient.series(
        {
          tokenBundle,
          garminActivityIds: batch.map((run) => run.garminActivityId),
          includeRecords,
        },
        options,
      );
      // Thrown inside the call, so the connection records it like any other Garmin failure; a bundle
      // Garmin rotated is already stored by then.
      if (readsAsOutage(batch, answer.series)) {
        log.warn(
          { userId, runs: batch.length, ...outcomeCounts(answer.series) },
          "series answer reads as garmin being down; nothing marked",
        );
        throw garminDown();
      }
      return answer;
    });

    const answered = batch.map((run, index) => {
      const series = response.series[index];
      // The contract answers every id in request order; anything else is a service bug, and marking
      // the runs done on it would hide their efforts for good.
      if (series?.garminActivityId !== run.garminActivityId) {
        throw new Error("The Garmin service answered the series out of request order");
      }
      return { run, series };
    });
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
                updatedAt: keepUpdatedAt,
              })
              .where(inArray(activity.id, failedIds))
              .returning({ id: activity.id, attempts: activity.bestEffortsAttempts });
      if (response.records !== null) {
        await tx
          .update(garminConnection)
          .set({ garminRecords: response.records, garminRecordsAt: sql`now()` })
          .where(eq(garminConnection.userId, userId));
      }
      await recordGarminSuccess(tx, userId);
      return failedRuns
        .filter((run) => run.attempts >= BEST_EFFORTS_MAX_ATTEMPTS)
        .map((run) => run.id);
    });

    const result = {
      processed: doneIds.length,
      failed: failedIds.length,
      skipped,
      remaining: await countPendingRuns(userId),
    };
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
 * Queues a best-efforts batch when the user has pending runs. Called after a sync or an import page has
 * committed its runs and released the user lock. Never throws: a failed send must not fail the sync or
 * the page that called it, and the next one queues it again.
 */
export async function queueBestEfforts(userId: string): Promise<string | null> {
  try {
    if ((await countPendingRuns(userId)) === 0) return null;
    return await bestEffortsQueue.enqueueBestEfforts({ userId });
  } catch (err) {
    log.error({ err, userId }, "best-efforts batch not queued; the next sync queues it again");
    return null;
  }
}

/**
 * Queues a batch for every user with pending runs, once the workers run at boot. A deploy that raises
 * BEST_EFFORTS_VERSION, or the first one with best efforts, leaves stored runs pending, and otherwise
 * nothing would queue them before each user's next sync. Never throws, so boot goes on: a failure is
 * logged, and the next sync queues the work again. Returns how many batches were queued.
 */
export async function queuePendingBestEfforts(): Promise<number> {
  let users: { userId: string }[];
  try {
    users = await db.selectDistinct({ userId: activity.userId }).from(activity).where(pending);
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

/**
 * Why pending runs have no job to check them: no Garmin login, an expired one (the next sync after a
 * reconnect queues the work), or the error the last Garmin call ended with, when it is one of this app's
 * codes. Null when no reason is known: the next sync queues the work again.
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
 * GET /api/personal-bests: the fastest effort per distance over runs that still count, shortest first.
 * A run edited since its efforts were computed (a null version) is left out until they are again; an
 * exact tie goes to the earlier run. No Garmin call: Garmin's records are the ones last stored. Also
 * whether a best-efforts job for the user is waiting, retrying or running, and, when runs are pending with
 * none, why (stoppedBecause), so the screen polls only while something will change.
 */
export async function getPersonalBests(userId: string): Promise<PersonalBestsResponse> {
  const [fastest, pendingRuns, [connection], checking] = await Promise.all([
    db
      .selectDistinctOn([bestEffort.distanceKey], {
        distanceKey: bestEffort.distanceKey,
        timeS: bestEffort.timeS,
        activityId: activity.id,
        startUtc: activity.startUtc,
        startLocal: activity.startLocal,
      })
      .from(bestEffort)
      .innerJoin(activity, eq(activity.id, bestEffort.activityId))
      .where(and(eq(bestEffort.userId, userId), eligible, isNotNull(activity.bestEffortsVersion)))
      .orderBy(
        bestEffort.distanceKey,
        asc(bestEffort.timeS),
        asc(activity.startUtc),
        // Garmin ids grow over time, so they break a tie between two runs saved with the same start.
        asc(activity.garminActivityId),
      ),
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
    hasPendingJob(bestEffortsQueue.name, userId),
  ]);

  const bests: PersonalBest[] = fastest
    .map((row) => ({
      ...row,
      startUtc: row.startUtc.toISOString(),
      startLocal: isoLocal(row.startLocal),
    }))
    .sort(
      (a, b) => (DISTANCE_ORDER.get(a.distanceKey) ?? 0) - (DISTANCE_ORDER.get(b.distanceKey) ?? 0),
    );
  return {
    bests,
    garmin:
      connection?.records && connection.fetchedAt
        ? { records: connection.records, fetchedAt: connection.fetchedAt.toISOString() }
        : null,
    pendingRuns,
    checking,
    errorCode: pendingRuns > 0 && !checking ? stoppedBecause(connection) : null,
  };
}
