import type { CronSyncResponse } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { garminConnection, userSettings } from "../db/schema";
import { enqueueSyncGarmin } from "../jobs/sync-garmin-queue";
import { localDateOf } from "../lib/local-date";
import { logger } from "../lib/logger";

const log = logger.child({ module: "daily-sync" });

/**
 * POST /api/cron/sync: queues one background sync per user whose Garmin login works, keyed on the user's
 * local date at `now`, so a second fire on that date queues nothing (deterministic job id). An expired or
 * missing login is left out: only the runner can reconnect it, and a job a day would be one more failed
 * Garmin login each time. A user in the hour after a Garmin 429 is queued all the same: the job's
 * openGarminAccount refuses without calling Garmin and defers itself to the hour's end. A failed send
 * throws, and the cron's retry queues the rest while the users already queued fold into their jobs.
 */
export async function queueDailySyncs({ now }: { now: Date }): Promise<CronSyncResponse> {
  const users = await db
    .select({ userId: garminConnection.userId, timezone: userSettings.timezone })
    .from(garminConnection)
    // Every user gets a settings row at creation (auth.ts), so the join never drops a connection.
    .innerJoin(userSettings, eq(userSettings.userId, garminConnection.userId))
    .where(eq(garminConnection.status, "ok"));

  let queued = 0;
  for (const { userId, timezone } of users) {
    const id = await enqueueSyncGarmin({ userId, date: localDateOf(now, timezone) });
    if (id) queued += 1;
  }
  const result = { connected: users.length, queued };
  log.info(result, "daily syncs queued");
  return result;
}
