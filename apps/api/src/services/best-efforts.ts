import { BEST_EFFORTS_VERSION, bestEfforts } from "@running-coach/engine";
import {
  DISTANCE_METERS,
  distanceKeySchema,
  GARMIN_SERIES_BATCH_MAX,
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
import { enqueueBestEfforts } from "../jobs/best-efforts-queue";
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

/** Eligible runs never computed, changed since (a null version), or computed by an older rule. */
const pending = and(
  eligible,
  or(isNull(activity.bestEffortsVersion), lt(activity.bestEffortsVersion, BEST_EFFORTS_VERSION)),
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
  /** Pending runs left after it; the job queues its successor while any are. */
  remaining: number;
}

/**
 * Computes the best efforts of up to GARMIN_SERIES_BATCH_MAX pending runs, newest first, with one Garmin
 * call inside the per-user lock (the gates, bundle write-back and failure bookkeeping of
 * openGarminAccount). The batch that empties the pending list also fetches Garmin's own records. In one
 * transaction, each run's rows are replaced and its version set, so a recompute writes the same rows and a
 * kill leaves the run pending; a run with no samples (deleted on Garmin) is marked done with no rows.
 * Nothing pending returns at once without calling Garmin, which makes a duplicate job a no-op.
 */
export async function computeBestEffortsBatch(
  userId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<BestEffortsBatchResult> {
  return withUserLock(userId, async () => {
    // One more than a batch tells whether this batch empties the list, without a count.
    const candidates = await db
      .select({ id: activity.id, garminActivityId: activity.garminActivityId })
      .from(activity)
      .where(and(eq(activity.userId, userId), pending))
      .orderBy(desc(activity.startUtc), desc(activity.garminActivityId))
      .limit(GARMIN_SERIES_BATCH_MAX + 1);
    if (candidates.length === 0) return { processed: 0, remaining: 0 };
    const batch = candidates.slice(0, GARMIN_SERIES_BATCH_MAX);
    const includeRecords = candidates.length <= GARMIN_SERIES_BATCH_MAX;

    const account = await openGarminAccount(userId);
    signal?.throwIfAborted();
    const response = await account.call((tokenBundle, options) =>
      garminClient.series(
        {
          tokenBundle,
          garminActivityIds: batch.map((run) => run.garminActivityId),
          includeRecords,
        },
        options,
      ),
    );

    const rows = batch.flatMap((run, index) => {
      const series = response.series[index];
      // The contract answers every id in request order; anything else is a service bug, and marking
      // the runs done on it would hide their efforts for good.
      if (series?.garminActivityId !== run.garminActivityId) {
        throw new Error("The Garmin service answered the series out of request order");
      }
      return bestEfforts(series).map((effort) => ({ userId, activityId: run.id, ...effort }));
    });
    const runIds = batch.map((run) => run.id);

    await db.transaction(async (tx) => {
      await tx.delete(bestEffort).where(inArray(bestEffort.activityId, runIds));
      if (rows.length > 0) await tx.insert(bestEffort).values(rows);
      await tx
        .update(activity)
        // updated_at stays: it records the last change Garmin made to the run, and this is bookkeeping.
        .set({ bestEffortsVersion: BEST_EFFORTS_VERSION, updatedAt: sql`${activity.updatedAt}` })
        .where(inArray(activity.id, runIds));
      if (response.records !== null) {
        await tx
          .update(garminConnection)
          .set({ garminRecords: response.records, garminRecordsAt: sql`now()` })
          .where(eq(garminConnection.userId, userId));
      }
      await recordGarminSuccess(tx, userId);
    });

    const empty = response.series.filter((series) => series.elapsedS.length === 0).length;
    const result = { processed: batch.length, remaining: await countPendingRuns(userId) };
    if (batch.length > 1 && empty === batch.length) {
      // Every run without samples is what a moved or blocked details endpoint would look like.
      log.warn({ userId, runs: batch.length }, "garmin returned no samples for a whole batch");
    }
    log.info(
      { userId, ...result, efforts: rows.length, empty, records: response.records?.length ?? null },
      "best efforts computed",
    );
    return result;
  });
}

/**
 * Queues a best-efforts batch when the user has pending runs. Called after a sync or an import page has
 * committed its runs and released the user lock. Never throws: a failed send must not fail the sync or
 * the page that called it, and the next one queues it again.
 */
export async function queueBestEfforts(userId: string): Promise<string | null> {
  try {
    if ((await countPendingRuns(userId)) === 0) return null;
    return await enqueueBestEfforts({ userId });
  } catch (err) {
    log.error({ err, userId }, "best-efforts batch not queued; the next sync queues it again");
    return null;
  }
}

const DISTANCE_ORDER = new Map(distanceKeySchema.options.map((key, index) => [key, index]));

/**
 * GET /api/personal-bests: the fastest effort per distance over runs that still count, shortest first.
 * A run edited since its efforts were computed (a null version) is left out until they are again; an
 * exact tie goes to the earlier run. No Garmin call: Garmin's records are the ones last stored.
 */
export async function getPersonalBests(userId: string): Promise<PersonalBestsResponse> {
  const [fastest, pendingRuns, [connection]] = await Promise.all([
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
  };
}
