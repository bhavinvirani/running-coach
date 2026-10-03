import type { MeResponse, UpdateSettingsRequest } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { garminConnection, user, userSettings } from "../db/schema";
import { queueWorkoutPush } from "./workout-push";

/**
 * Inserts the user's settings row with the column defaults (km, UTC, standard). Runs when the user is created
 * (Better Auth's user.create.after hook) and for an existing owner at seed, so every reader can rely on the
 * row; a second call is a no-op.
 */
export async function createDefaultSettings(userId: string): Promise<void> {
  await db
    .insert(userSettings)
    .values({ userId })
    .onConflictDoNothing({ target: userSettings.userId });
}

/** GET /api/me: the user, their settings and the Garmin connection state. */
export async function getMe(userId: string): Promise<MeResponse> {
  const [row] = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      units: userSettings.units,
      timezone: userSettings.timezone,
      coachDetail: userSettings.coachDetail,
      claudeKeyEnc: userSettings.claudeKeyEnc,
      garminStatus: garminConnection.status,
      lastSyncAt: garminConnection.lastSyncAt,
    })
    .from(user)
    .innerJoin(userSettings, eq(userSettings.userId, user.id))
    .leftJoin(garminConnection, eq(garminConnection.userId, user.id))
    .where(eq(user.id, userId));
  // requireUser found the user, and its settings row is created with it.
  if (!row) throw new Error("The signed-in user has no settings row");
  return {
    user: { id: row.id, email: row.email, name: row.name },
    settings: {
      units: row.units,
      timezone: row.timezone,
      coachDetail: row.coachDetail,
      // Only whether a key exists; the key itself never leaves the service layer.
      hasClaudeKey: row.claudeKeyEnc !== null,
    },
    garmin: {
      status: row.garminStatus ?? "not_connected",
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    },
  };
}

/**
 * PATCH /api/me/settings: applies the given fields and returns the new state. A change of units renames
 * every workout on the watch and a change of time zone moves the push window, so either queues a workout
 * push (only while the Garmin login works, as queueWorkoutPush decides); the coach detail does neither.
 */
export async function updateSettings(
  userId: string,
  patch: UpdateSettingsRequest,
): Promise<MeResponse> {
  const changed = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ units: userSettings.units, timezone: userSettings.timezone })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .for("update");
    await tx.update(userSettings).set(patch).where(eq(userSettings.userId, userId));
    return (
      before !== undefined &&
      ((patch.units !== undefined && patch.units !== before.units) ||
        (patch.timezone !== undefined && patch.timezone !== before.timezone))
    );
  });
  if (changed) await queueWorkoutPush(userId);
  return getMe(userId);
}
