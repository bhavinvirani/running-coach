import { type ConnectGarminResponse, ErrorCode } from "@running-coach/shared";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { garminConnection } from "../db/schema";
import { garminClient } from "../garmin/client";
import { encrypt } from "../lib/crypto";
import { DomainError } from "../lib/errors";
import { withUserLock } from "../lib/locks";
import { logger } from "../lib/logger";

const log = logger.child({ module: "garmin-connection" });

export interface ConnectGarminInput {
  userId: string;
  /** The bundle garminconnect saved on the runner's laptop (`pnpm garmin:connect`). Never logged. */
  tokenBundle: string;
}

// garminconnect saves its tokens as one JSON object; anything else fails the Garmin service's login, so it
// is refused before it costs a Garmin call.
function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * PUT /api/garmin/connection: proves the bundle with one Garmin call, then stores it encrypted. A reconnect
 * replaces the bundle and clears an expired status and the last error but keeps last_sync_at, so the stored
 * runs stay and the next sync resumes from the cursor. Any failure stores nothing, and an existing
 * connection stays as it was. Runs under the per-user lock, so it never overlaps a sync's Garmin calls or
 * its token write-back.
 */
export async function connectGarmin({
  userId,
  tokenBundle,
}: ConnectGarminInput): Promise<ConnectGarminResponse> {
  if (!isJsonObject(tokenBundle)) {
    throw new DomainError(
      ErrorCode.validation,
      400,
      "The Garmin login is not valid. Run pnpm garmin:connect again.",
      {
        issues: [{ path: "tokenBundle", message: "Expected the JSON object garminconnect saves." }],
      },
    );
  }

  return withUserLock(userId, async () => {
    const checked = await garminClient.profile(
      { tokenBundle },
      // Nothing is stored before the check succeeds; its answer carries the bundle to keep, rotated or not.
      { onTokenBundle: () => Promise.resolve() },
    );
    const tokenBundleEnc = encrypt(checked.tokenBundle, userId);
    await db
      .insert(garminConnection)
      .values({ userId, tokenBundleEnc, status: "ok", lastError: null })
      .onConflictDoUpdate({
        target: garminConnection.userId,
        set: { tokenBundleEnc, status: "ok", lastError: null, updatedAt: sql`now()` },
      });
    log.info({ userId }, "garmin connected");
    return { displayName: checked.profile.displayName };
  });
}
