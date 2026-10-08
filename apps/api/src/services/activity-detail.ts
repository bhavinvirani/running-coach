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
import { secondsInZones } from "./hr-zone-time";
import { customHrZoneFloors } from "./hr-zones";

// One run with what Garmin holds about it beyond its summary. The detail is fetched on demand, once: the
// stream row marks it fetched, laps and stream commit together, and a stored detail is answered without
// calling Garmin. A sync that rewrites the run's summary keeps the row's id, so the detail stays with it.

const log = logger.child({ module: "activity-detail" });

export function runNotFound(): DomainError {
  return new DomainError(ErrorCode.notFound, 404, "That run does not exist.");
}

/**
 * The stored laps and samples, or null before the detail was fetched. With the runner's own zones the
 * seconds in zone come from the stored HR series on every read, so a detail fetched again or a zone edit
 * shows at once; else Garmin's seconds as stored.
 */
async function readDetail(userId: string, activityId: string): Promise<ActivityDetail | null> {
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
  const floors = await customHrZoneFloors(userId);
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
    hrZones: floors ? secondsInZones(stream.elapsedS, stream.hr, floors) : stream.hrZones,
  };
}

async function runExists(userId: string, activityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: activity.id })
    .from(activity)
    .where(and(eq(activity.id, activityId), eq(activity.userId, userId)));
  return row !== undefined;
}

async function hasDetail(activityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: activityStream.id })
    .from(activityStream)
    .where(eq(activityStream.activityId, activityId));
  return row !== undefined;
}

/**
 * GET /api/activities/:id: one of the user's runs, its stored detail (null until fetched), its best
 * efforts with their personal-best flags (empty until computed, and for runs the bests leave out) and the
 * pair it wore.
 */
export async function getActivity(userId: string, id: string): Promise<ActivityResponse> {
  const [row] = await db
    .select({ ...activityColumns, shoeId: activity.shoeId })
    .from(activity)
    .where(and(eq(activity.id, id), eq(activity.userId, userId)));
  if (!row) throw runNotFound();
  const [detail, bestEfforts] = await Promise.all([
    readDetail(userId, id),
    getRunBestEfforts(userId, id),
  ]);
  const { shoeId, ...run } = row;
  return { activity: toActivity(run), detail, bestEfforts, shoeId };
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
 * run deleted on Garmin Connect is a 404 and stores nothing, and so is one a sync removed while this request
 * waited for the lock.
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
      // Again under the lock: a sync ahead of this request may have removed the run (Garmin no longer lists
      // it), and storing its detail would then fail on the foreign key; a request ahead may have stored it.
      if (!(await runExists(userId, id))) throw runNotFound();
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
