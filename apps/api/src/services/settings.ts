import type { MeResponse, UpdateSettingsRequest } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { garminConnection, user, userSettings } from "../db/schema";

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

/** PATCH /api/me/settings: applies the given fields and returns the new state. */
export async function updateSettings(
  userId: string,
  patch: UpdateSettingsRequest,
): Promise<MeResponse> {
  await db.update(userSettings).set(patch).where(eq(userSettings.userId, userId));
  return getMe(userId);
}
