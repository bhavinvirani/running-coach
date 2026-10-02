import { ErrorCode, type MeResponse, type UpdateSettingsRequest } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { garminConnection, user, userSettings } from "../db/schema";
import { DomainError } from "../lib/errors";

async function readMe(userId: string): Promise<MeResponse | undefined> {
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
  if (!row) return undefined;
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

/** Creates the default settings row (km, UTC, standard). Two first reads at once still make one row. */
async function ensureSettings(userId: string): Promise<void> {
  const [exists] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId));
  if (!exists) throw new DomainError(ErrorCode.notFound, 404, "This account no longer exists.");
  await db.insert(userSettings).values({ userId }).onConflictDoNothing({
    target: userSettings.userId,
  });
}

/** GET /api/me: the user, their settings and the Garmin connection state. */
export async function getMe(userId: string): Promise<MeResponse> {
  const me = await readMe(userId);
  if (me) return me;
  await ensureSettings(userId);
  const created = await readMe(userId);
  if (!created) throw new Error("Settings row missing after insert");
  return created;
}

/** PATCH /api/me/settings: applies the given fields and returns the new state. */
export async function updateSettings(
  userId: string,
  patch: UpdateSettingsRequest,
): Promise<MeResponse> {
  await ensureSettings(userId);
  await db.update(userSettings).set(patch).where(eq(userSettings.userId, userId));
  return getMe(userId);
}
