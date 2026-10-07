import type { DisconnectGarminQuery, DisconnectGarminResponse } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { garminConnection } from "../db/schema";
import { withUserLock } from "../lib/locks";
import { logger } from "../lib/logger";
import { garminAuthExpired } from "./garmin-account";
import { removeOwnWorkouts } from "./workout-push";

const log = logger.child({ module: "garmin-disconnect" });

export interface DisconnectGarminInput extends DisconnectGarminQuery {
  userId: string;
  /** "Today" is the runner's local date at this instant; the time it takes the lock when omitted. */
  now?: Date;
}

/**
 * DELETE /api/garmin/connection: forgets the runner's Garmin login (SPEC: Garmin). keep deletes the row,
 * whatever its status. remove first takes the app's workouts from today on off Garmin
 * (removeOwnWorkouts), which needs a working login: an expired one answers 409 garmin_auth_expired and
 * nothing changes, and a failed removal throws its error with the login kept, so the runner can try again
 * or keep them. No login at all answers 0, so a second tap is a no-op.
 *
 * Under the user lock, so it never cuts into a sync's or a push's Garmin calls and their token write-back;
 * removeOwnWorkouts runs inside it, since the lock is not re-entrant. Runs, plans and sessions stay, with
 * the Garmin ids of the workouts kept; jobs still queued for the user complete on garmin_not_connected.
 * Worst case: the wait for the lock, then MAX_REMOVE_ROUNDS workout batches.
 */
export async function disconnectGarmin({
  userId,
  workouts,
  now,
}: DisconnectGarminInput): Promise<DisconnectGarminResponse> {
  return withUserLock(userId, async () => {
    const [row] = await db
      .select({ status: garminConnection.status })
      .from(garminConnection)
      .where(eq(garminConnection.userId, userId));
    if (!row) return { removedWorkouts: 0 };

    let removedWorkouts = 0;
    if (workouts === "remove") {
      // Removing needs a Garmin login; an expired one is never sent again (garmin-account.ts).
      if (row.status === "expired") throw garminAuthExpired();
      removedWorkouts = await removeOwnWorkouts(userId, now ?? new Date());
    }
    await db.delete(garminConnection).where(eq(garminConnection.userId, userId));
    log.info({ userId, workouts, removedWorkouts }, "garmin disconnected");
    return { removedWorkouts };
  });
}
