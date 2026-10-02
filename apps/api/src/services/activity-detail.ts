import {
  type ActivityDetail,
  type ActivityResponse,
  ErrorCode,
  type GarminActivityDetailResponse,
} from "@running-coach/shared";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { activity, activityLap, activityStream } from "../db/schema";
import { garminClient } from "../garmin/client";
import { DomainError } from "../lib/errors";
import { withUserLock } from "../lib/locks";
import { logger } from "../lib/logger";
import { activityColumns, toActivity } from "./activities";
import { getRunBestEfforts } from "./best-efforts";
import { openGarminAccount, recordGarminSuccess } from "./garmin-account";

// One run with what Garmin holds about it beyond its summary. The detail is fetched on demand, once: the
// stream row marks it fetched, laps and stream commit together, and a stored detail is answered without
// calling Garmin. A sync that rewrites the run's summary keeps the row's id, so the detail stays with it.

const log = logger.child({ module: "activity-detail" });

function runNotFound(): DomainError {
  return new DomainError(ErrorCode.notFound, 404, "That run does not exist.");
}

/** The stored laps and samples, or null before the detail was fetched. */
async function readDetail(activityId: string): Promise<ActivityDetail | null> {
  // Stream first: laps commit with it, so once it is visible its laps are too.
  const [stream] = await db
    .select()
    .from(activityStream)
    .where(eq(activityStream.activityId, activityId));
  if (!stream) return null;
  const laps = await db
    .select({
      index: activityLap.idx,
      distanceM: activityLap.distanceM,
      durationS: activityLap.durationS,
      avgHr: activityLap.avgHr,
      avgCadence: activityLap.avgCadence,
    })
    .from(activityLap)
    .where(eq(activityLap.activityId, activityId))
    .orderBy(asc(activityLap.idx));
  return {
    laps,
    streams: {
      elapsedS: stream.elapsedS,
      distanceM: stream.distanceM,
      hr: stream.hr,
      cadence: stream.cadence,
      elevationM: stream.elevationM,
      speedMps: stream.speedMps,
    },
    route: stream.route,
    hrZones: stream.hrZones,
  };
}

async function hasDetail(activityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: activityStream.id })
    .from(activityStream)
    .where(eq(activityStream.activityId, activityId));
  return row !== undefined;
}

/**
 * GET /api/activities/:id: one of the user's runs, its stored detail (null until fetched) and its best
 * efforts with their personal-best flags (empty until computed, and for runs the bests leave out).
 */
export async function getActivity(userId: string, id: string): Promise<ActivityResponse> {
  const [row] = await db
    .select(activityColumns)
    .from(activity)
    .where(and(eq(activity.id, id), eq(activity.userId, userId)));
  if (!row) throw runNotFound();
  const [detail, bestEfforts] = await Promise.all([readDetail(id), getRunBestEfforts(userId, id)]);
  return { activity: toActivity(row), detail, bestEfforts };
}

/**
 * Stores a fetched detail and marks the Garmin login working, in one transaction. A stream row already
 * there means another caller stored the detail first: its laps are kept and nothing is written.
 */
async function saveDetail(
  userId: string,
  activityId: string,
  { laps, streams, route, hrZones }: GarminActivityDetailResponse["detail"],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(activityStream)
      .values({ activityId, ...streams, route, hrZones })
      .onConflictDoNothing({ target: activityStream.activityId })
      .returning({ id: activityStream.id });
    if (stored) {
      await tx.delete(activityLap).where(eq(activityLap.activityId, activityId));
      if (laps.length > 0) {
        await tx
          .insert(activityLap)
          .values(laps.map(({ index, ...lap }) => ({ activityId, idx: index, ...lap })));
      }
    }
    await recordGarminSuccess(tx, userId);
  });
}

/**
 * POST /api/activities/:id/detail: fetches the run's laps, samples, route and HR zones from Garmin, stores
 * them and answers like getActivity. A stored detail is answered without calling Garmin, so a second tap
 * or a concurrent request costs no login. The call runs inside the per-user lock behind the same gates as
 * a sync (not connected, expired, the hour after a 429), and a bundle Garmin rotated is written back. A
 * run deleted on Garmin Connect is a 404 and stores nothing.
 */
export async function fetchActivityDetail(userId: string, id: string): Promise<ActivityResponse> {
  const [run] = await db
    .select({ garminActivityId: activity.garminActivityId })
    .from(activity)
    .where(and(eq(activity.id, id), eq(activity.userId, userId)));
  if (!run) throw runNotFound();

  // Without the lock first, so a stored detail never waits behind a running sync.
  if (!(await hasDetail(id))) {
    await withUserLock(userId, async () => {
      // Again under the lock: a request ahead of this one may have stored it meanwhile.
      if (await hasDetail(id)) return;
      const account = await openGarminAccount(userId);
      let response: GarminActivityDetailResponse;
      try {
        response = await account.call((tokenBundle, options) =>
          garminClient.activityDetail(run.garminActivityId, { tokenBundle }, options),
        );
      } catch (error) {
        if (error instanceof DomainError && error.code === ErrorCode.notFound) {
          throw new DomainError(
            ErrorCode.notFound,
            404,
            "That run is no longer on Garmin Connect.",
            { cause: error },
          );
        }
        throw error;
      }
      await saveDetail(userId, id, response.detail);
      log.info(
        {
          userId,
          activityId: id,
          laps: response.detail.laps.length,
          samples: response.detail.streams.elapsedS.length,
        },
        "activity detail stored",
      );
    });
  }
  return getActivity(userId, id);
}
