import type { CronSyncResponse } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { garminConnection } from "../db/schema";
import { enqueuePushWorkouts } from "../jobs/push-workouts-queue";
import { enqueueSyncGarmin } from "../jobs/sync-garmin-queue";
import { logger } from "../lib/logger";

const log = logger.child({ module: "daily-sync" });

/**
 * POST /api/cron/sync: queues one background sync per user whose Garmin login works, keyed on the fire's UTC
 * date. The cron fires once per UTC day, so a double fire or a retry that day queues nothing (deterministic
 * job id). Never the user's local date: two consecutive fires can share one, a late fire and the next on
 * time west of UTC or the two around a fall-back, and the second day would queue nothing. The job reads the
 * user's local date when it runs. An expired or missing login is left out: only the runner can reconnect
 * it, and a job a day would be one more failed Garmin login each time. A user in the hour after a Garmin
 * 429 is queued all the same: the job's openGarminAccount refuses without calling Garmin and defers itself
 * to the hour's end. A failed send throws, and the cron's retry queues the rest while the users already
 * queued fold into their jobs. Beside each sync it queues the user's workout push, keyed the same way, so
 * the next seven days reach the watch even without an edit; `queued` counts the syncs.
 */
export async function queueDailySyncs({ now }: { now: Date }): Promise<CronSyncResponse> {
  const users = await db
    .select({ userId: garminConnection.userId })
    .from(garminConnection)
    .where(eq(garminConnection.status, "ok"));

  const date = now.toISOString().slice(0, 10);
  let queued = 0;
  for (const { userId } of users) {
    const id = await enqueueSyncGarmin({ userId, date });
    if (id) queued += 1;
    await enqueuePushWorkouts({ userId }, { date });
  }
  const result = { connected: users.length, queued };
  log.info({ ...result, date }, "daily syncs queued");
  return result;
}
